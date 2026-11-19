// Transmissões (mailing): escolhe o público, agenda e envia pelo bot em ritmo seguro.
import { type Api, InlineKeyboard, InputFile } from "grammy";
import { and, eq, inArray, lt, lte, sql } from "drizzle-orm";
import * as s from "../db/schema.js";
import type { BotlyRuntime } from "../bot/runtime.js";
import { fillTemplate } from "./retention.js";
import type { Ctx } from "./context.js";
import type { BroadcastAudience } from "./types.js";
import { logEvent } from "./sales.js";

const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
/** Mensagens por segundo (o Telegram aguenta ~30/s por bot; ficamos abaixo). */
const PER_SECOND = 20;
/** Quanto tempo cada rodada pode ficar enviando. */
const ROUND_MS = 25_000;

export interface AudienceRow {
  customerId: string;
  botId: string;
  telegramUserId: number;
}

/**
 * Quem recebe: pessoas que falaram com algum dos bots escolhidos e não bloquearam.
 * Cada pessoa aparece uma vez só, pelo bot em que falou por último.
 */
export async function audienceRows(ctx: Ctx, accountId: string, botIds: string[], aud: BroadcastAudience, limit?: number): Promise<AudienceRow[]> {
  if (!botIds.length) return [];
  const now = ctx.now();
  const nowIso = now.toISOString();
  const activeNow = sql`a.status = 'active' and (a.expires_at is null or a.expires_at > ${nowIso}::timestamptz)`;
  const segment =
    aud.segment === "active"
      ? sql`and exists (select 1 from accesses a where a.customer_id = c.id and ${activeNow})`
      : aud.segment === "expired"
        ? sql`and exists (select 1 from accesses a where a.customer_id = c.id) and not exists (select 1 from accesses a where a.customer_id = c.id and ${activeNow})`
        : aud.segment === "never"
          ? sql`and c.purchases = 0 and not exists (select 1 from accesses a where a.customer_id = c.id)`
          : sql``;
  const channel = aud.channelId
    ? aud.channelMode === "hasnt"
      ? sql`and not exists (select 1 from accesses a where a.customer_id = c.id and a.channel_id = ${aud.channelId} and ${activeNow})`
      : sql`and exists (select 1 from accesses a where a.customer_id = c.id and a.channel_id = ${aud.channelId} and ${activeNow})`
    : sql``;
  const expiring =
    aud.segment === "active" && aud.expiringDays && aud.expiringDays > 0
      ? sql`and exists (select 1 from accesses a where a.customer_id = c.id and a.status = 'active' and a.expires_at is not null and a.expires_at > ${nowIso}::timestamptz and a.expires_at <= ${new Date(now.getTime() + aud.expiringDays * 86_400_000).toISOString()}::timestamptz)`
      : sql``;
  const ids = sql.join(botIds.map((b) => sql`${b}::uuid`), sql`, `);
  const rows = (await ctx.db.execute(sql`
    select distinct on (c.id) c.id as "customerId", cb.bot_id as "botId", c.telegram_user_id as "telegramUserId"
    from customers c
    join customer_bots cb on cb.customer_id = c.id
    where c.account_id = ${accountId}::uuid and cb.bot_id in (${ids}) and cb.can_message
      ${segment} ${channel} ${expiring}
    order by c.id, cb.last_interaction_at desc
    ${limit ? sql`limit ${limit}` : sql``}
  `)) as unknown as { customerId: string; botId: string; telegramUserId: string | number }[];
  return rows.map((r) => ({ customerId: r.customerId, botId: r.botId, telegramUserId: Number(r.telegramUserId) }));
}

/** Transmissões que chegaram na hora: começa a montar a lista de destinatários. */
async function startDue(ctx: Ctx) {
  const due = await ctx.db
    .update(s.broadcasts)
    .set({ status: "sending", startedAt: ctx.now() })
    .where(and(eq(s.broadcasts.status, "scheduled"), lte(s.broadcasts.scheduledAt, ctx.now())))
    .returning();
  for (const b of due) {
    const rows = await audienceRows(ctx, b.accountId, b.botIds, b.audience);
    for (let i = 0; i < rows.length; i += 500) {
      await ctx.db
        .insert(s.broadcastRecipients)
        .values(rows.slice(i, i + 500).map((r) => ({ broadcastId: b.id, customerId: r.customerId, botId: r.botId })))
        .onConflictDoNothing();
    }
    ctx.log.info({ broadcastId: b.id, total: rows.length }, "transmissão iniciada");
  }
}

type Bc = typeof s.broadcasts.$inferSelect;
const fileIds = new Map<string, string>();

function keyboard(content: Bc["content"], broadcastId: string): InlineKeyboard | undefined {
  const btn = content.button;
  if (!btn || btn.kind === "none") return undefined;
  const kb = new InlineKeyboard();
  if (btn.kind === "plans") kb.text(btn.label || "💎 Ver planos", "plans");
  else if (btn.kind === "url" && btn.url) kb.url(btn.label || "Abrir", btn.url);
  else if (btn.kind === "offer") kb.text(btn.label || "🎁 Quero a oferta", `bo:${broadcastId}`);
  else return undefined;
  return kb;
}

/** Manda o conteúdo para uma pessoa (usado no envio de verdade e no teste). Lança o erro do Telegram. */
export async function deliver(ctx: Ctx, api: Api, botId: string, chatId: number, content: Bc["content"], nome: string, broadcastId: string) {
  const text = fillTemplate(content.text, { nome: esc(nome) });
  const kb = keyboard(content, broadcastId);
  const m = content.media;
  if (m && (m.mediaId || m.url)) {
    const key = `${botId}:${m.mediaId ?? m.url}`;
    let src: string | InputFile | undefined = fileIds.get(key) ?? m.url ?? undefined;
    let up = false;
    if (!src && m.mediaId) {
      const row = (await ctx.db.select().from(s.media).where(eq(s.media.id, m.mediaId)))[0];
      if (row) {
        src = new InputFile(row.data, row.fileName);
        up = true;
      }
    }
    if (src) {
      const opts = { caption: text, parse_mode: "HTML" as const, reply_markup: kb };
      const sent = m.type === "video" ? await api.sendVideo(chatId, src, opts) : m.type === "animation" ? await api.sendAnimation(chatId, src, opts) : await api.sendPhoto(chatId, src, opts);
      if (up) {
        const fid = "video" in sent && sent.video ? sent.video.file_id : "animation" in sent && sent.animation ? sent.animation.file_id : "photo" in sent && sent.photo ? sent.photo.at(-1)?.file_id : null;
        if (fid) fileIds.set(key, fid);
      }
      return;
    }
  }
  await api.sendMessage(chatId, text, { parse_mode: "HTML", reply_markup: kb });
}

/** Erro do Telegram que significa "essa pessoa não recebe mais". */
export const isBlockedError = (msg: string) => /403|blocked|deactivated|chat not found|user is deactivated/i.test(msg);

async function sendOne(ctx: Ctx, rt: BotlyRuntime, b: Bc, r: { id: string; customerId: string; botId: string }): Promise<"sent" | "blocked" | "retry" | "failed"> {
  const c = (await ctx.db.select().from(s.customers).where(eq(s.customers.id, r.customerId)))[0];
  if (!c) return "failed";
  try {
    await deliver(ctx, await rt.api(r.botId), r.botId, c.telegramUserId, b.content, c.firstName || c.username || "", b.id);
    return "sent";
  } catch (err) {
    const msg = String(err);
    if (isBlockedError(msg)) {
      await ctx.db.update(s.customerBots).set({ canMessage: false }).where(and(eq(s.customerBots.customerId, r.customerId), eq(s.customerBots.botId, r.botId)));
      return "blocked";
    }
    if (/Network request|ETIMEDOUT|ECONNRESET|ENOTFOUND|EAI_AGAIN|socket hang up|fetch failed|429|Too Many Requests|5\d\d/i.test(msg)) return "retry";
    ctx.log.warn({ broadcastId: b.id, err: msg }, "falha ao enviar transmissão");
    await ctx.db.update(s.broadcastRecipients).set({ error: msg.slice(0, 300) }).where(eq(s.broadcastRecipients.id, r.id));
    return "failed";
  }
}

/** Uma rodada: manda por até ROUND_MS, em lotes de PER_SECOND por segundo. */
export async function broadcastTick(ctx: Ctx, rt: BotlyRuntime) {
  await startDue(ctx);
  // Envios que ficaram "sending" há +10 min (queda no meio) viram falha: não reenvia.
  await ctx.db
    .update(s.broadcastRecipients)
    .set({ status: "failed", error: "interrompido" })
    .where(and(eq(s.broadcastRecipients.status, "sending"), lt(s.broadcastRecipients.sentAt, new Date(ctx.now().getTime() - 10 * 60_000))));
  const active = await ctx.db.select().from(s.broadcasts).where(eq(s.broadcasts.status, "sending"));
  const t0 = Date.now();
  for (const b of active) {
    while (Date.now() - t0 < ROUND_MS) {
      const fresh = (await ctx.db.select({ st: s.broadcasts.status }).from(s.broadcasts).where(eq(s.broadcasts.id, b.id)))[0];
      if (fresh?.st !== "sending") break; // cancelada no meio
      const batch = (await ctx.db.execute(sql`
        update broadcast_recipients set status = 'sending', sent_at = ${ctx.now().toISOString()}::timestamptz
        where id in (select id from broadcast_recipients where broadcast_id = ${b.id}::uuid and status = 'pending' order by id limit ${PER_SECOND} for update skip locked)
        returning id, customer_id as "customerId", bot_id as "botId"`)) as unknown as { id: string; customerId: string; botId: string }[];
      if (!batch.length) {
        const left = await ctx.db.select({ id: s.broadcastRecipients.id }).from(s.broadcastRecipients).where(and(eq(s.broadcastRecipients.broadcastId, b.id), inArray(s.broadcastRecipients.status, ["pending", "sending"]))).limit(1);
        if (!left.length) await ctx.db.update(s.broadcasts).set({ status: "done", finishedAt: ctx.now() }).where(and(eq(s.broadcasts.id, b.id), eq(s.broadcasts.status, "sending")));
        break;
      }
      const started = Date.now();
      // Quem usa mídia por upload: o 1º de cada bot vai sozinho para guardar o file_id.
      const results = await Promise.all(batch.map((r) => sendOne(ctx, rt, b, r)));
      for (let i = 0; i < batch.length; i++) {
        const r = batch[i]!;
        const res = results[i]!;
        if (res === "retry") await ctx.db.update(s.broadcastRecipients).set({ status: "pending" }).where(eq(s.broadcastRecipients.id, r.id));
        else {
          await ctx.db.update(s.broadcastRecipients).set({ status: res, sentAt: ctx.now() }).where(eq(s.broadcastRecipients.id, r.id));
          if (res === "sent") await logEvent(ctx, { accountId: b.accountId, botId: r.botId, customerId: r.customerId, type: "broadcast_sent", meta: { broadcastId: b.id } });
        }
      }
      if (results.includes("retry")) await new Promise((r) => setTimeout(r, 3000));
      const wait = 1000 - (Date.now() - started);
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    }
  }
}

/** Números de uma transmissão (para a lista e o detalhe). */
export async function broadcastStats(ctx: Ctx, id: string) {
  const rows = (await ctx.db.execute(sql`select status, count(*)::int as n from broadcast_recipients where broadcast_id = ${id}::uuid group by status`)) as unknown as { status: string; n: number }[];
  const by = Object.fromEntries(rows.map((r) => [r.status, r.n])) as Record<string, number>;
  const clicks = (await ctx.db.execute(sql`select count(distinct customer_id)::int as n from events where type = 'broadcast_clicked' and meta->>'broadcastId' = ${id}`)) as unknown as { n: number }[];
  const sales = (await ctx.db.execute(
    sql`select count(*)::int as n, coalesce(sum(total_cents),0)::int as cents from orders where status = 'paid' and source = ${"bc:" + id}`,
  )) as unknown as { n: number; cents: number }[];
  return {
    total: Object.values(by).reduce((a, b) => a + b, 0),
    sent: by.sent ?? 0,
    pending: (by.pending ?? 0) + (by.sending ?? 0),
    blocked: by.blocked ?? 0,
    failed: by.failed ?? 0,
    clicks: clicks[0]?.n ?? 0,
    sales: sales[0]?.n ?? 0,
    revenueCents: sales[0]?.cents ?? 0,
  };
}
