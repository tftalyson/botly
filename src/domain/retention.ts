// Retenção: lembretes de vencimento, "volte" depois do vencimento e corte.
//
// 1) planOutbox: a cada poucos minutos, monta a fila (outbox) dos próximos 8 dias
//    a partir dos acessos e dos modelos de mensagem da conta.
// 2) sendDue: manda o que já está na hora, pelo bot da última compra.
// 3) cutExpired: vencidos além da tolerância viram "expired"; com o corte ligado,
//    são removidos do canal (bane e desbane). Desligado = modo simulação.
import { chName } from "./channel-name.js";
import { and, asc, eq, inArray, isNotNull, isNull, lte, sql } from "drizzle-orm";
import { InlineKeyboard } from "grammy";
import * as s from "../db/schema.js";
import type { Ctx } from "./context.js";
import { removeFromChannel } from "./removal.js";
import { logEvent } from "./sales.js";
import { activeAccess } from "./customers.js";
import type { BotlyRuntime } from "../bot/runtime.js";
import { brl, discounted } from "../lib/money.js";
import { addDays, atLocal, DEFAULT_TZ, fmtDate, zoned } from "../lib/time.js";

type Template = typeof s.templates.$inferSelect;
type Access = typeof s.accesses.$inferSelect;
const DAY = 1440;

export const DEFAULT_TEMPLATES: { kind: "reminder" | "winback"; days: number; text: string; discountPct: number }[] = [
  { kind: "reminder", days: -3, discountPct: 0, text: "⏰ Oi, {nome}! Seu acesso ao <b>{canal}</b> vence em <b>3 dias</b> ({vencimento}).\nRenove agora e não perca nada:" },
  { kind: "reminder", days: -1, discountPct: 0, text: "⏰ {nome}, seu acesso ao <b>{canal}</b> vence <b>amanhã</b> ({vencimento}).\nRenove e continue com acesso:" },
  { kind: "reminder", days: 0, discountPct: 0, text: "⚠️ {nome}, seu acesso ao <b>{canal}</b> vence <b>hoje</b>.\nRenove agora para não ser removido:" },
  { kind: "winback", days: 1, discountPct: 0, text: "😢 Seu acesso ao <b>{canal}</b> terminou.\nQuer voltar? É só tocar no botão:" },
  { kind: "winback", days: 7, discountPct: 15, text: "🎁 Saudade? Volte para o <b>{canal}</b> com <b>{desconto}% de desconto</b>:" },
];

/** Cria os modelos padrão na primeira vez. */
export async function ensureTemplates(ctx: Ctx, accountId: string): Promise<Template[]> {
  const cur = await ctx.db.select().from(s.templates).where(and(eq(s.templates.accountId, accountId), isNull(s.templates.botId), inArray(s.templates.kind, ["reminder", "winback"])));
  if (cur.length) return cur;
  return ctx.db
    .insert(s.templates)
    .values(DEFAULT_TEMPLATES.map((t) => ({ accountId, kind: t.kind, offsetMinutes: t.days * DAY, text: t.text, discountPct: t.discountPct })))
    .returning();
}

const keyFor = (accessId: string, templateId: string, expiresAt: Date) => `r:${accessId}:${templateId}:${expiresAt.toISOString()}`;
const expiryFromKey = (key: string) => {
  const iso = key.split(":").slice(3).join(":");
  const d = new Date(iso);
  return Number.isFinite(d.getTime()) ? d : null;
};

/** Monta a fila dos próximos 8 dias (não duplica: chave única por acesso + modelo + vencimento). */
export async function planOutbox(ctx: Ctx, accountId?: string) {
  const now = ctx.now();
  const accounts = await ctx.db
    .select()
    .from(s.accounts)
    .where(and(eq(s.accounts.status, "active"), accountId ? eq(s.accounts.id, accountId) : undefined));
  for (const acc of accounts) {
    const tz = acc.settings.timezone ?? DEFAULT_TZ;
    const time = acc.settings.reminderTime ?? "10:00";
    const tpls = (await ensureTemplates(ctx, acc.id)).filter((t) => t.enabled);
    if (!tpls.length) continue;
    const maxBefore = Math.max(0, ...tpls.map((t) => -t.offsetMinutes / DAY));
    const maxAfter = Math.max(0, ...tpls.map((t) => t.offsetMinutes / DAY));
    // Acessos com vencimento numa janela que algum modelo pode alcançar.
    const from = new Date(now.getTime() - (maxAfter + 1) * 86_400_000);
    const to = new Date(now.getTime() + (maxBefore + 9) * 86_400_000);
    const rows = await ctx.db
      .select({ a: s.accesses, price: s.plans.priceCents })
      .from(s.accesses)
      .leftJoin(s.plans, eq(s.plans.id, s.accesses.planId))
      .where(and(eq(s.accesses.accountId, acc.id), isNotNull(s.accesses.expiresAt), sql`${s.accesses.expiresAt} between ${from.toISOString()}::timestamptz and ${to.toISOString()}::timestamptz`));
    const values: (typeof s.outbox.$inferInsert)[] = [];
    for (const { a, price } of rows) {
      const exp = a.expiresAt!;
      const z = zoned(exp, tz);
      for (const t of tpls) {
        if (t.botId && t.botId !== a.billingBotId) continue;
        const days = Math.round(t.offsetMinutes / DAY);
        const d = addDays(z.year, z.month, z.day, days);
        let when = atLocal(d.year, d.month, d.day, time, tz);
        // "Vence hoje" não pode sair depois de vencer: adianta para 3 h antes.
        if (t.kind === "reminder" && when.getTime() >= exp.getTime()) when = new Date(exp.getTime() - 3 * 3600_000);
        // Fora da janela de 8 dias ou já passou há mais de 6 h: não agenda.
        if (when.getTime() > now.getTime() + 8 * 86_400_000) continue;
        if (when.getTime() < now.getTime() - 6 * 3600_000) continue;
        // Lembrete só para quem está ativo; "volte" só para quem venceu.
        if (t.kind === "reminder" && a.status !== "active") continue;
        values.push({
          accountId: acc.id,
          botId: a.billingBotId,
          customerId: a.customerId,
          accessId: a.id,
          templateId: t.id,
          dedupeKey: keyFor(a.id, t.id, exp),
          scheduledFor: when,
          expectedCents: t.discountPct ? discounted(price ?? a.lastPriceCents ?? 0, t.discountPct) : (price ?? a.lastPriceCents ?? 0),
        });
      }
    }
    for (let i = 0; i < values.length; i += 500) await ctx.db.insert(s.outbox).values(values.slice(i, i + 500)).onConflictDoNothing();
  }
}

export function fillTemplate(text: string, v: Record<string, string>) {
  return text.replace(/\{(\w+)\}/g, (m, k: string) => v[k] ?? m);
}

/** Botões do lembrete: renovar (+ extra e plano longo, se ligados no bot) ou "voltar" com desconto. */
async function buttons(ctx: Ctx, bot: typeof s.bots.$inferSelect, a: Access, t: Template, outboxId: string, planName: string, priceCents: number) {
  const kb = new InlineKeyboard();
  if (t.kind === "winback") {
    const p = t.discountPct ? discounted(priceCents, t.discountPct) : priceCents;
    kb.text(`🔄 Voltar — ${brl(p)}${t.discountPct ? ` (${t.discountPct}% off)` : ""}`, `wb:${outboxId}`).row();
    kb.text("💎 Ver planos", "plans");
    return kb;
  }
  kb.text(`🔄 Renovar ${planName} — ${brl(priceCents)}`, `rn:${a.id}`).row();
  const r = bot.upsell.renewal;
  if (r?.enabled && r.extraChannelId && r.extraChannelId !== a.channelId && !(await activeAccess(ctx, a.customerId, r.extraChannelId))) {
    const ch = (await ctx.db.select().from(s.channels).where(eq(s.channels.id, r.extraChannelId)))[0];
    const extra = bot.upsell.orderBump?.priceOverrides?.[r.extraChannelId] ?? ch?.extraPriceCents;
    if (ch?.active && ch.inviteLink && extra) kb.text(`⭐ Renovar + ${chName(ch)} — ${brl(priceCents + extra)}`, `rnx:${a.id}`).row();
  }
  if (r?.enabled && r.longPlanId && r.longPlanId !== a.planId) {
    const lp = (await ctx.db.select().from(s.plans).where(and(eq(s.plans.id, r.longPlanId), eq(s.plans.active, true))))[0];
    if (lp) kb.text(`💰 ${lp.name} — ${brl(lp.priceCents)}`, `p:${lp.id}`).row();
  }
  return kb;
}

/** Manda o que já está na hora (até `limit` por rodada). */
export async function sendDue(ctx: Ctx, rt: BotlyRuntime, limit = 40) {
  const now = ctx.now();
  const due = await ctx.db
    .select()
    .from(s.outbox)
    .where(and(eq(s.outbox.status, "scheduled"), lte(s.outbox.scheduledFor, now)))
    .orderBy(asc(s.outbox.scheduledFor))
    .limit(limit);
  for (const o of due) {
    const skip = (error: string) => ctx.db.update(s.outbox).set({ status: "skipped", error }).where(eq(s.outbox.id, o.id));
    try {
      const a = o.accessId ? (await ctx.db.select().from(s.accesses).where(eq(s.accesses.id, o.accessId)))[0] : undefined;
      const t = o.templateId ? (await ctx.db.select().from(s.templates).where(eq(s.templates.id, o.templateId)))[0] : undefined;
      if (!a || !t || !t.enabled) {
        await skip("modelo ou acesso removido");
        continue;
      }
      // Passou muito do horário (sistema parado): não manda atrasado.
      if (o.scheduledFor.getTime() < now.getTime() - 12 * 3600_000) {
        await skip("horário passou");
        continue;
      }
      const keyExp = expiryFromKey(o.dedupeKey);
      const renewed = !a.expiresAt || (keyExp && a.expiresAt.getTime() > keyExp.getTime());
      if (renewed) {
        await skip("já renovou");
        continue;
      }
      if (t.kind === "reminder" && a.status !== "active") {
        await skip("acesso não está ativo");
        continue;
      }
      // Bot que manda: o da última compra; se não puder, outro bot que o cliente já usou.
      const links = await ctx.db.select().from(s.customerBots).where(and(eq(s.customerBots.customerId, o.customerId), eq(s.customerBots.canMessage, true)));
      const botId = links.find((l) => l.botId === a.billingBotId)?.botId ?? links[0]?.botId;
      if (!botId) {
        await skip("cliente não pode receber mensagem de nenhum bot");
        continue;
      }
      const bot = (await ctx.db.select().from(s.bots).where(eq(s.bots.id, botId)))[0];
      if (!bot || bot.status !== "active") {
        await skip("bot pausado ou desconectado");
        continue;
      }
      const customer = (await ctx.db.select().from(s.customers).where(eq(s.customers.id, o.customerId)))[0]!;
      const ch = (await ctx.db.select().from(s.channels).where(eq(s.channels.id, a.channelId)))[0]!;
      const plan = a.planId ? (await ctx.db.select().from(s.plans).where(eq(s.plans.id, a.planId)))[0] : undefined;
      const price = plan?.priceCents ?? a.lastPriceCents ?? 0;
      const account = (await ctx.db.select().from(s.accounts).where(eq(s.accounts.id, o.accountId)))[0]!;
      const tz = account.settings.timezone ?? DEFAULT_TZ;
      const daysLeft = Math.max(0, Math.ceil((a.expiresAt!.getTime() - now.getTime()) / 86_400_000));
      const text = fillTemplate(t.text, {
        nome: esc(customer.firstName || customer.username || ""),
        canal: esc(chName(ch)),
        vencimento: fmtDate(a.expiresAt, tz),
        dias: String(daysLeft),
        valor: brl(t.discountPct ? discounted(price, t.discountPct) : price),
        desconto: String(t.discountPct),
      });
      const kb = await buttons(ctx, bot, a, t, o.id, plan?.name ?? "por mais um período", price);
      const api = await rt.api(bot.id);
      try {
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
          await ctx.db.update(s.outbox).set({ status: "failed", error: "cliente bloqueou o bot" }).where(eq(s.outbox.id, o.id));
          continue;
        }
        throw err;
      }
      await ctx.db.update(s.outbox).set({ status: "sent", sentAt: now, botId: bot.id }).where(eq(s.outbox.id, o.id));
      await logEvent(ctx, { accountId: o.accountId, botId: bot.id, customerId: o.customerId, type: t.kind === "winback" ? "winback_sent" : "reminder_sent", meta: { outboxId: o.id, accessId: a.id } });
      await new Promise((r) => setTimeout(r, 60)); // folga para o limite do Telegram
    } catch (err) {
      const msg = String(err);
      ctx.log.warn({ outboxId: o.id, err: msg }, "falha ao enviar lembrete");
      // Falha de rede (o Telegram não respondeu): tenta de novo na próxima rodada, até 5 vezes.
      const tries = Number(o.error?.match(/tentativa (\d+)/)?.[1] ?? 0) + 1;
      if (/Network request|ETIMEDOUT|ECONNRESET|ENOTFOUND|EAI_AGAIN|socket hang up|fetch failed|429|Too Many Requests|5\d\d/i.test(msg) && tries < 5) {
        await ctx.db.update(s.outbox).set({ error: `falha de rede, tentativa ${tries}` }).where(eq(s.outbox.id, o.id));
      } else await ctx.db.update(s.outbox).set({ status: "failed", error: msg.slice(0, 300) }).where(eq(s.outbox.id, o.id));
    }
  }
}

const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * Vencidos além da tolerância viram "expired". Com o corte ligado (autoRemove),
 * quem está "expired" é removido do canal. Desligado = modo simulação: só aparecem
 * na Retenção como "seriam removidos".
 */
export async function cutExpired(ctx: Ctx, rt: BotlyRuntime, limit = 50) {
  const now = ctx.now();
  const accounts = await ctx.db.select().from(s.accounts).where(eq(s.accounts.status, "active"));
  for (const acc of accounts) {
    const grace = (acc.settings.removeGraceHours ?? 0) * 3600_000;
    const limitDate = new Date(now.getTime() - grace);
    const expired = await ctx.db
      .update(s.accesses)
      .set({ status: "expired", updatedAt: now })
      .where(and(eq(s.accesses.accountId, acc.id), eq(s.accesses.status, "active"), isNotNull(s.accesses.expiresAt), lte(s.accesses.expiresAt, limitDate)))
      .returning();
    for (const a of expired) await logEvent(ctx, { accountId: acc.id, customerId: a.customerId, type: "expired", meta: { channelId: a.channelId, simulation: !acc.settings.autoRemove } });
    if (!acc.settings.autoRemove) continue;
    const toRemove = await ctx.db
      .select({ a: s.accesses, ch: s.channels, c: s.customers })
      .from(s.accesses)
      .innerJoin(s.channels, eq(s.channels.id, s.accesses.channelId))
      .innerJoin(s.customers, eq(s.customers.id, s.accesses.customerId))
      .where(and(eq(s.accesses.accountId, acc.id), eq(s.accesses.status, "expired")))
      .limit(limit);
    for (const r of toRemove) {
      const managerId = r.ch.managerBotId;
      if (!managerId) continue;
      try {
        await removeFromChannel(ctx, await rt.api(managerId), { channel: r.ch, customer: r.c, reason: "expired" });
      } catch (err) {
        const msg = String(err);
        // Já não está no canal / nunca entrou: só marca como removido.
        if (/USER_NOT_PARTICIPANT|user not found|PARTICIPANT_ID_INVALID|member not found/i.test(msg)) {
          await ctx.db.update(s.accesses).set({ status: "removed", removedAt: now }).where(eq(s.accesses.id, r.a.id));
        } else ctx.log.warn({ accessId: r.a.id, err: msg }, "falha ao remover vencido");
      }
    }
  }
}

/** Para a página Retenção: o que aconteceria/aconteceu num intervalo. */
export async function retentionWindow(ctx: Ctx, accountId: string, from: Date, to: Date) {
  return ctx.db
    .select({
      o: s.outbox,
      kind: s.templates.kind,
      offset: s.templates.offsetMinutes,
      discountPct: s.templates.discountPct,
      customer: { id: s.customers.id, tg: s.customers.telegramUserId, username: s.customers.username, firstName: s.customers.firstName },
      channel: sql<string>`coalesce(${s.channels.displayName}, ${s.channels.title})`,
      expiresAt: s.accesses.expiresAt,
      bot: s.bots.username,
    })
    .from(s.outbox)
    .leftJoin(s.templates, eq(s.templates.id, s.outbox.templateId))
    .innerJoin(s.customers, eq(s.customers.id, s.outbox.customerId))
    .leftJoin(s.accesses, eq(s.accesses.id, s.outbox.accessId))
    .leftJoin(s.channels, eq(s.channels.id, s.accesses.channelId))
    .leftJoin(s.bots, eq(s.bots.id, s.outbox.botId))
    .where(and(eq(s.outbox.accountId, accountId), sql`${s.outbox.scheduledFor} >= ${from.toISOString()}::timestamptz`, sql`${s.outbox.scheduledFor} < ${to.toISOString()}::timestamptz`))
    .orderBy(asc(s.outbox.scheduledFor));
}

/** Vencidos esperando remoção (modo simulação mostra estes). */
export async function pendingRemovals(ctx: Ctx, accountId: string) {
  return ctx.db
    .select({ id: s.accesses.id, expiresAt: s.accesses.expiresAt, channel: sql<string>`coalesce(${s.channels.displayName}, ${s.channels.title})`, username: s.customers.username, firstName: s.customers.firstName, tg: s.customers.telegramUserId })
    .from(s.accesses)
    .innerJoin(s.channels, eq(s.channels.id, s.accesses.channelId))
    .innerJoin(s.customers, eq(s.customers.id, s.accesses.customerId))
    .where(and(eq(s.accesses.accountId, accountId), eq(s.accesses.status, "expired")))
    .orderBy(asc(s.accesses.expiresAt))
    .limit(500);
}

