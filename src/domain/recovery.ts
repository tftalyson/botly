// Recuperação de Pix: o cliente gerou o Pix e não pagou.
//
// Mensagens (templates kind "recovery", minutos depois de gerar o Pix): por padrão
// 15 min (lembrete), 2 h (10% de desconto) e 24 h (plano mais barato).
// O botão "rc:" cria o pedido com desconto só quando o cliente toca (o envio não mexe em pedidos).
import { and, asc, eq, gt, inArray, isNull, lt, sql } from "drizzle-orm";
import { InlineKeyboard } from "grammy";
import * as s from "../db/schema.js";
import type { Ctx } from "./context.js";
import { fillTemplate } from "./retention.js";
import { logEvent } from "./sales.js";
import type { BotlyRuntime } from "../bot/runtime.js";
import { brl, discounted } from "../lib/money.js";

type Template = typeof s.templates.$inferSelect;

export const DEFAULT_RECOVERY: { minutes: number; discountPct: number; text: string }[] = [
  { minutes: 15, discountPct: 0, text: "⏳ {nome}, seu Pix de <b>{valor}</b> ({plano}) ainda está esperando pagamento.\nÉ só tocar no botão para ver o código de novo:" },
  { minutes: 120, discountPct: 10, text: "🎁 {nome}, separei <b>{desconto}% de desconto</b> para você fechar agora: {plano} por <b>{valor}</b>.\nÉ por tempo limitado:" },
  { minutes: 1440, discountPct: 0, text: "👋 {nome}, última chance: que tal começar com o <b>{plano}</b> por <b>{valor}</b>?\nÉ só tocar no botão:" },
];

/** Modelos padrão na primeira vez (a conta pode editar/apagar depois). */
export async function ensureRecoveryTemplates(ctx: Ctx, accountId: string): Promise<Template[]> {
  const cur = await ctx.db.select().from(s.templates).where(and(eq(s.templates.accountId, accountId), isNull(s.templates.botId), eq(s.templates.kind, "recovery")));
  if (cur.length) return cur;
  return ctx.db
    .insert(s.templates)
    .values(DEFAULT_RECOVERY.map((t) => ({ accountId, kind: "recovery" as const, offsetMinutes: t.minutes, text: t.text, discountPct: t.discountPct })))
    .returning();
}

/** Modelos ligados da conta, na ordem do tempo. */
export async function recoverySteps(ctx: Ctx, accountId: string): Promise<Template[]> {
  const rows = await ctx.db
    .select()
    .from(s.templates)
    .where(and(eq(s.templates.accountId, accountId), isNull(s.templates.botId), eq(s.templates.kind, "recovery"), eq(s.templates.enabled, true)))
    .orderBy(asc(s.templates.offsetMinutes));
  return rows;
}

const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
/** Passou mais que isso do horário (sistema parado)? Não manda atrasado. */
const LATE_MS = 3 * 3600_000;

/** Plano mais barato da última etapa (se o bot tem um escolhido e ele é mesmo mais barato que o pedido). */
export async function downsellFor(ctx: Ctx, bot: typeof s.bots.$inferSelect, orderTotalCents: number) {
  const id = bot.recovery.downsellPlanId;
  if (!id) return null;
  const plan = (await ctx.db.select().from(s.plans).where(and(eq(s.plans.id, id), eq(s.plans.botId, bot.id), eq(s.plans.active, true))))[0];
  return plan && plan.priceCents < orderTotalCents ? plan : null;
}

/** Roda a cada minuto: manda a próxima mensagem de recuperação de cada pedido que está na hora. */
export async function recoveryTick(ctx: Ctx, rt: BotlyRuntime, limit = 40) {
  const now = ctx.now();
  const bots = await ctx.db.select().from(s.bots).where(eq(s.bots.status, "active"));
  let sentCount = 0;
  for (const bot of bots) {
    if (!bot.recovery.enabled) continue;
    await ensureRecoveryTemplates(ctx, bot.accountId);
    const steps = await recoverySteps(ctx, bot.accountId);
    if (!steps.length) continue;
    const maxAge = steps[steps.length - 1]!.offsetMinutes * 60_000 + LATE_MS;
    const since = new Date(now.getTime() - maxAge - 3600_000);
    // Pedidos pendentes com Pix gerado há pouco (o tempo conta do Pix MAIS RECENTE do pedido, pois o pedido pode ser reaproveitado;
    // kind "recovery" não recupera de novo).
    const orders = await ctx.db
      .select({ o: s.orders, firstPix: sql<Date>`max(${s.charges.createdAt})` })
      .from(s.orders)
      .innerJoin(s.charges, eq(s.charges.orderId, s.orders.id))
      .where(and(eq(s.orders.botId, bot.id), eq(s.orders.status, "pending"), inArray(s.orders.kind, ["new", "renewal", "bundle"]), gt(s.charges.createdAt, since), lt(s.orders.recoveryStep, steps.length)))
      .groupBy(s.orders.id);
    for (const { o, firstPix } of orders) {
      if (sentCount >= limit) return;
      const base = new Date(firstPix).getTime();
      const from = o.recoveryStep;
      let step = from;
      // Etapas que já passaram do prazo (sistema parado) são puladas sem mandar.
      while (step < steps.length && now.getTime() - (base + steps[step]!.offsetMinutes * 60_000) > LATE_MS) step++;
      const due = step < steps.length && now.getTime() >= base + steps[step]!.offsetMinutes * 60_000;
      if (!due) {
        if (step !== from) await ctx.db.update(s.orders).set({ recoveryStep: step }).where(and(eq(s.orders.id, o.id), eq(s.orders.recoveryStep, from)));
        continue;
      }
      // Reserva a etapa antes de enviar (dois processos não mandam a mesma).
      const claimed = await ctx.db
        .update(s.orders)
        .set({ recoveryStep: step + 1 })
        .where(and(eq(s.orders.id, o.id), eq(s.orders.recoveryStep, from), eq(s.orders.status, "pending")))
        .returning({ id: s.orders.id });
      if (!claimed.length) continue;
      const res = await sendRecovery(ctx, rt, bot, o, steps, step, new Date(base));
      if (res === "retry") await ctx.db.update(s.orders).set({ recoveryStep: from }).where(eq(s.orders.id, o.id));
      else if (res === "stop") await ctx.db.update(s.orders).set({ recoveryStep: steps.length }).where(eq(s.orders.id, o.id));
      else if (res === "sent") sentCount++;
    }
  }
}

async function sendRecovery(ctx: Ctx, rt: BotlyRuntime, bot: typeof s.bots.$inferSelect, o: typeof s.orders.$inferSelect, steps: Template[], idx: number, pixAt: Date): Promise<"sent" | "stop" | "skip" | "retry"> {
  const t = steps[idx]!;
  // Já pagou outra coisa depois deste pedido? Não incomoda.
  const paidAfter = await ctx.db.select({ id: s.orders.id }).from(s.orders).where(and(eq(s.orders.customerId, o.customerId), eq(s.orders.status, "paid"), gt(s.orders.paidAt, pixAt))).limit(1);
  if (paidAfter.length) return "stop";
  const link = (await ctx.db.select().from(s.customerBots).where(and(eq(s.customerBots.customerId, o.customerId), eq(s.customerBots.botId, bot.id))))[0];
  if (!link?.canMessage) return "stop";
  const customer = (await ctx.db.select().from(s.customers).where(eq(s.customers.id, o.customerId)))[0]!;
  const isLast = idx === steps.length - 1;
  const down = isLast ? await downsellFor(ctx, bot, o.totalCents) : null;
  const planName = down?.name ?? o.items.map((i) => i.name).join(" + ");
  const base = down ? down.priceCents : o.totalCents;
  const final = t.discountPct ? discounted(base, t.discountPct) : base;
  const text = fillTemplate(t.text, {
    nome: esc(customer.firstName || customer.username || ""),
    plano: esc(planName),
    valor: brl(final),
    desconto: String(t.discountPct),
    canal: esc(o.items[0] ? o.items[0].name : ""),
  });
  const label = t.discountPct || down ? `💳 Pagar ${brl(final)}${t.discountPct ? ` (${t.discountPct}% off)` : ""}` : `💳 Ver o Pix de ${brl(final)}`;
  const kb = new InlineKeyboard().text(label, `rc:${o.id}:${t.id}`).row().text("💎 Ver planos", "plans");
  try {
    const api = await rt.api(bot.id);
    if (t.media?.fileId || t.media?.url) {
      const src = (t.media.fileId || t.media.url)!;
      const opts = { caption: text, parse_mode: "HTML" as const, reply_markup: kb };
      if (t.media.type === "video") await api.sendVideo(customer.telegramUserId, src, opts);
      else await api.sendPhoto(customer.telegramUserId, src, opts);
    } else await api.sendMessage(customer.telegramUserId, text, { parse_mode: "HTML", reply_markup: kb });
  } catch (err) {
    const msg = String(err);
    if (/403|blocked|deactivated|chat not found/i.test(msg)) {
      await ctx.db.update(s.customerBots).set({ canMessage: false }).where(and(eq(s.customerBots.customerId, o.customerId), eq(s.customerBots.botId, bot.id)));
      return "stop";
    }
    if (/Network request|ETIMEDOUT|ECONNRESET|ENOTFOUND|EAI_AGAIN|socket hang up|fetch failed|429|Too Many Requests|5\d\d/i.test(msg)) return "retry";
    ctx.log.warn({ orderId: o.id, err: msg }, "falha ao enviar recuperação de Pix");
    return "skip";
  }
  await logEvent(ctx, { accountId: o.accountId, botId: bot.id, customerId: o.customerId, type: "recovery_sent", meta: { orderId: o.id, step: idx + 1, templateId: t.id, discountPct: t.discountPct } });
  await new Promise((r) => setTimeout(r, 60));
  return "sent";
}

/** Plano principal do pedido para o botão "rc:" (desconto + plano mais barato na última etapa). */
export function recoveryPrice(baseCents: number, discountPct: number) {
  return discountPct ? discounted(baseCents, discountPct) : baseCents;
}

