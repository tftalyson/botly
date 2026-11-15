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
