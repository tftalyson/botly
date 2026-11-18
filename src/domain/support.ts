// Atendimento: conversas do cliente com um humano, pelo próprio bot.
// O cliente escreve no bot; a mensagem vai para o painel (página Atendimento).
// O atendente responde no painel; o bot entrega com o nome dele ("Talyson: ...").
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { InlineKeyboard, type Api } from "grammy";
import * as s from "../db/schema.js";
import type { Ctx } from "./context.js";
import type { AccountSettings } from "./types.js";
import { DEFAULT_TZ, zoned } from "../lib/time.js";

type Ticket = typeof s.supportTickets.$inferSelect;
const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export const SUPPORT_DEFAULTS = { start: "10:00", end: "22:00" };

export function supportHours(st: AccountSettings) {
  return { start: st.supportStart || SUPPORT_DEFAULTS.start, end: st.supportEnd || SUPPORT_DEFAULTS.end };
}

/** Está dentro do horário de atendimento? (aceita horário que passa da meia-noite) */
export function isSupportOpen(st: AccountSettings, now: Date): boolean {
  const { start, end } = supportHours(st);
  const z = zoned(now, st.timezone ?? DEFAULT_TZ);
  const m = z.hour * 60 + z.minute;
  const toMin = (h: string) => {
    const [a, b] = h.split(":").map(Number);
    return (a ?? 0) * 60 + (b ?? 0);
  };
  const a = toMin(start);
  const b = toMin(end);
  return a <= b ? m >= a && m < b : m >= a || m < b;
}

export function offHoursText(st: AccountSettings) {
  const { start, end } = supportHours(st);
  return (st.supportOffMessage?.trim() || "🌙 Nosso atendimento é das {inicio} às {fim}. Deixe sua mensagem aqui que respondemos assim que abrirmos.")
    .replace(/\{inicio\}/g, start)
    .replace(/\{fim\}/g, end);
}

/** Conversa aberta (aguardando ou em atendimento) do cliente neste bot. */
export async function openTicketFor(ctx: Ctx, customerId: string, botId: string) {
  return (
    await ctx.db
      .select()
      .from(s.supportTickets)
      .where(and(eq(s.supportTickets.customerId, customerId), eq(s.supportTickets.botId, botId), inArray(s.supportTickets.status, ["open", "active"])))
      .orderBy(desc(s.supportTickets.createdAt))
      .limit(1)
  )[0];
}

export async function addMessage(ctx: Ctx, t: Pick<Ticket, "id" | "accountId">, m: { sender: "customer" | "agent" | "system"; text?: string | null; mediaType?: "photo" | "document" | "video" | "voice" | null; tgFileId?: string | null; agentName?: string | null }) {
  await ctx.db.insert(s.supportMessages).values({ ticketId: t.id, accountId: t.accountId, sender: m.sender, text: m.text ?? null, mediaType: m.mediaType ?? null, tgFileId: m.tgFileId ?? null, agentName: m.agentName ?? null, createdAt: ctx.now() });
  await ctx.db
    .update(s.supportTickets)
    .set({ lastMessageAt: ctx.now(), ...(m.sender === "customer" ? { unread: sql`${s.supportTickets.unread} + 1` } : {}) })
    .where(eq(s.supportTickets.id, t.id));
}

/** Abre (ou devolve a já aberta) conversa de atendimento. */
export async function openTicket(ctx: Ctx, a: { accountId: string; customerId: string; botId: string; topic: string }): Promise<{ ticket: Ticket; created: boolean }> {
  const cur = await openTicketFor(ctx, a.customerId, a.botId);
  if (cur) return { ticket: cur, created: false };
  const [ticket] = await ctx.db.insert(s.supportTickets).values({ accountId: a.accountId, customerId: a.customerId, botId: a.botId, topic: a.topic, createdAt: ctx.now(), lastMessageAt: ctx.now() }).returning();
  await addMessage(ctx, ticket!, { sender: "system", text: `Cliente pediu atendimento (${a.topic}).` });
  return { ticket: ticket!, created: true };
}

/** Atendente responde: assume a conversa se ainda não assumiu e entrega com o nome. */
export async function agentReply(ctx: Ctx, api: Api, ticket: Ticket, agent: { id: string; name: string }, text: string) {
  const customer = (await ctx.db.select().from(s.customers).where(eq(s.customers.id, ticket.customerId)))[0]!;
  if (ticket.status !== "active" || ticket.agentName !== agent.name) await assume(ctx, api, ticket, agent);
  await api.sendMessage(customer.telegramUserId, `<b>${esc(agent.name)}:</b> ${esc(text)}`, { parse_mode: "HTML" });
  await addMessage(ctx, ticket, { sender: "agent", text, agentName: agent.name });
}

export async function assume(ctx: Ctx, api: Api, ticket: Ticket, agent: { id: string; name: string }) {
  const customer = (await ctx.db.select().from(s.customers).where(eq(s.customers.id, ticket.customerId)))[0]!;
  await ctx.db.update(s.supportTickets).set({ status: "active", assignedUserId: agent.id, agentName: agent.name }).where(eq(s.supportTickets.id, ticket.id));
  await api.sendMessage(customer.telegramUserId, `👤 <b>${esc(agent.name)}</b> entrou na conversa.`, { parse_mode: "HTML" }).catch(() => {});
  await addMessage(ctx, ticket, { sender: "system", text: `${agent.name} entrou na conversa.` });
}

export async function closeTicket(ctx: Ctx, api: Api | null, ticket: Ticket, by: "agent" | "customer", agentName?: string) {
  await ctx.db.update(s.supportTickets).set({ status: "closed", closedAt: ctx.now(), unread: 0 }).where(eq(s.supportTickets.id, ticket.id));
  await addMessage(ctx, ticket, { sender: "system", text: by === "customer" ? "Cliente encerrou o atendimento." : `${agentName ?? "Atendente"} encerrou o atendimento.` });
  if (api && by === "agent") {
    const customer = (await ctx.db.select().from(s.customers).where(eq(s.customers.id, ticket.customerId)))[0]!;
    await api
      .sendMessage(customer.telegramUserId, "✅ Atendimento encerrado. Se precisar de algo, é só tocar em 💬 Suporte.", {
        reply_markup: new InlineKeyboard().text("💬 Suporte", "sup").text("🏠 Início", "home"),
      })
      .catch(() => {});
  }
}

const STEP_LABEL: Record<string, string> = { started: "Deu /start", viewed_plans: "Viu os planos", chose_plan: "Escolheu um plano", pix_generated: "Gerou o Pix", paid: "Pagou", joined: "Entrou no canal" };
const STEPS = ["started", "viewed_plans", "chose_plan", "pix_generated", "paid", "joined"] as const;

/** Rastro do cliente: até onde chegou no funil e o que aconteceu (mais recente primeiro). */
export async function customerTrail(ctx: Ctx, accountId: string, customerId: string) {
  const evs = await ctx.db
    .select({ type: s.events.type, meta: s.events.meta, at: s.events.createdAt, botId: s.events.botId })
    .from(s.events)
    .where(and(eq(s.events.accountId, accountId), eq(s.events.customerId, customerId)))
    .orderBy(desc(s.events.createdAt))
    .limit(80);
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const ids = (k: string) => [...new Set(evs.map((e) => e.meta?.[k]).filter((x): x is string => typeof x === "string" && UUID.test(x)))];
  const planIds = ids("planId");
  const bundleIds = ids("bundleId");
  const plans = planIds.length ? await ctx.db.select({ id: s.plans.id, name: s.plans.name }).from(s.plans).where(inArray(s.plans.id, planIds)) : [];
  const bundles = bundleIds.length ? await ctx.db.select({ id: s.bundles.id, name: s.bundles.name }).from(s.bundles).where(inArray(s.bundles.id, bundleIds)) : [];
  const bots = await ctx.db.select({ id: s.bots.id, username: s.bots.username }).from(s.bots).where(eq(s.bots.accountId, accountId));
  const brl = (c: unknown) => (typeof c === "number" ? ` de ${(c / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" })}` : "");
  const label = (e: (typeof evs)[number]): string => {
    const m = e.meta ?? {};
    switch (e.type) {
      case "started": return "Deu /start";
      case "age_confirmed": return "Confirmou a maioridade";
      case "viewed_plans": return "Viu os planos";
      case "chose_plan": {
        const n = plans.find((p) => p.id === m.planId)?.name ?? bundles.find((b) => b.id === m.bundleId)?.name;
        return n ? `Escolheu ${m.bundleId ? "o pacote" : "o plano"} ${n}` : "Escolheu um plano";
      }
      case "bump_offered": return "Recebeu a oferta de canal extra";
      case "bump_accepted": return "Aceitou o canal extra";
      case "bump_declined": return "Recusou o canal extra";
      case "pix_generated": return `Gerou um Pix${brl(m.totalCents)}${typeof m.provider === "string" ? ` (${m.provider})` : ""}`;
      case "paid": return "Pagou";
      case "renewed": return "Renovou";
      case "underpaid": return `Pagou valor diferente (${typeof m.paidCents === "number" ? (m.paidCents / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" }) : "?"} em vez de ${typeof m.expectedCents === "number" ? (m.expectedCents / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" }) : "?"})`;
      case "joined": return "Entrou no canal";
      case "join_declined": return "Pediu para entrar, mas foi recusado (sem acesso ativo)";
      case "reminder_sent": return "Recebeu lembrete de vencimento";
      case "winback_sent": return "Recebeu mensagem para voltar";
      case "renew_clicked": return "Clicou em renovar";
      case "expired": return "Acesso venceu";
      case "removed": return "Foi removido do canal";
      default: return e.type;
    }
  };
  const seen = new Set(evs.map((e) => e.type));
  const reached: Record<string, boolean> = {
    started: seen.has("started"),
    viewed_plans: seen.has("viewed_plans"),
    chose_plan: seen.has("chose_plan"),
    pix_generated: seen.has("pix_generated"),
    paid: seen.has("paid") || seen.has("renewed"),
    joined: seen.has("joined"),
  };
  // Quem comprou/renovou sem passar pelo funil (importado) conta como tendo passado pelas etapas anteriores.
  const last = STEPS.reduce((acc, k, i) => (reached[k] ? i : acc), -1);
  const steps = STEPS.map((k, i) => ({ key: k, label: STEP_LABEL[k]!, reached: reached[k] || i < last }));
  const firstMissing = steps.find((x) => !x.reached);
  return {
    steps,
    stoppedAt: last >= 0 && firstMissing ? firstMissing.label : null,
    events: evs.map((e) => ({ type: e.type, at: e.at, label: label(e), bot: bots.find((b) => b.id === e.botId)?.username ?? null })),
  };
}
