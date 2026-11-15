// Avisos depois do pagamento: cliente recebe os botões de entrada;
// o canal de avisos da conta recebe a venda.
import { chName } from "../domain/channel-name.js";
import { eq, inArray } from "drizzle-orm";
import { InlineKeyboard } from "grammy";
import * as s from "../db/schema.js";
import type { Ctx } from "../domain/context.js";
import type { PaidResult } from "../domain/sales.js";
import { brl } from "../lib/money.js";
import { DEFAULT_TZ, fmtDate } from "../lib/time.js";
import type { BotlyRuntime } from "./runtime.js";

const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export async function announcePaid(ctx: Ctx, rt: BotlyRuntime, r: PaidResult) {
  const { order, accesses } = r;
  if (!order.botId) return;
  const customer = (await ctx.db.select().from(s.customers).where(eq(s.customers.id, order.customerId)))[0]!;
  const account = (await ctx.db.select().from(s.accounts).where(eq(s.accounts.id, order.accountId)))[0]!;
  const tz = account.settings.timezone ?? DEFAULT_TZ;
  const chans = accesses.length ? await ctx.db.select().from(s.channels).where(inArray(s.channels.id, accesses.map((a) => a.channelId))) : [];
  const kb = new InlineKeyboard();
  const lines: string[] = [];
  for (const a of accesses) {
    const ch = chans.find((x) => x.id === a.channelId);
    if (!ch) continue;
    lines.push(`• <b>${esc(chName(ch))}</b> — ${a.expiresAt ? `até ${fmtDate(a.expiresAt, tz)}` : "vitalício"}`);
    if (ch.inviteLink) kb.url(`🔓 Entrar no ${chName(ch)}`, ch.inviteLink).row();
  }
  try {
    const api = await rt.api(order.botId);
    // Confirmação: some o Pix (QR e código) da conversa, fica só a confirmação.
    const pixMsgs = await ctx.db.select({ id: s.charges.id, ids: s.charges.chatMessageIds }).from(s.charges).where(eq(s.charges.orderId, order.id));
    for (const p of pixMsgs) {
      for (const mid of p.ids) await api.deleteMessage(customer.telegramUserId, mid).catch(() => {});
      if (p.ids.length) await ctx.db.update(s.charges).set({ chatMessageIds: [] }).where(eq(s.charges.id, p.id));
    }
    await api.sendMessage(
      customer.telegramUserId,
      `✅ <b>Pagamento confirmado!</b>\n\n${lines.join("\n")}\n\nToque no botão abaixo e peça para entrar — eu aprovo na hora.`,
      { parse_mode: "HTML", reply_markup: kb },
    );
  } catch (err) {
    ctx.log.warn({ orderId: order.id, err: String(err) }, "falha ao avisar o cliente do pagamento");
  }

  const notifyChat = account.settings.notifyChatId;
  const notifyBot = account.settings.notifyBotId || order.botId;
  if (notifyChat) {
    try {
      const bot = (await ctx.db.select().from(s.bots).where(eq(s.bots.id, order.botId)))[0];
      const who = customer.username ? `@${customer.username}` : `${customer.firstName ?? ""} (${customer.telegramUserId})`;
      const tipo = order.kind === "renewal" ? "🔄 Renovação" : order.kind === "bundle" ? "🔥 Pacote" : "💰 Venda";
      const api = await rt.api(notifyBot);
      await api.sendMessage(
        notifyChat,
        `${tipo} — <b>${brl(order.totalCents)}</b>\n${esc(order.items.map((i) => i.name).join(" + "))}\nCliente: ${esc(who)}\nBot: @${esc(bot?.username ?? "?")} · ${r.charge.provider}`,
        { parse_mode: "HTML" },
      );
    } catch (err) {
      ctx.log.warn({ orderId: order.id, err: String(err) }, "falha ao avisar o canal de vendas");
    }
  }
}
