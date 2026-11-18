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
import { addMessage, isSupportOpen, offHoursText, openTicket } from "../domain/support.js";
import { logEvent } from "../domain/sales.js";
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

/**
 * Pix pago com valor menor que o do pedido: não libera o acesso, mas explica ao cliente,
 * abre uma conversa no Atendimento (com o motivo escrito) e avisa o canal de avisos.
 */
export async function announceUnderpaid(ctx: Ctx, rt: BotlyRuntime, info: { chargeId: string; paidCents: number }) {
  const charge = (await ctx.db.select().from(s.charges).where(eq(s.charges.id, info.chargeId)))[0];
  if (!charge) return;
  const order = (await ctx.db.select().from(s.orders).where(eq(s.orders.id, charge.orderId)))[0];
  if (!order?.botId) return;
  const customer = (await ctx.db.select().from(s.customers).where(eq(s.customers.id, order.customerId)))[0]!;
  const account = (await ctx.db.select().from(s.accounts).where(eq(s.accounts.id, order.accountId)))[0]!;
  const bot = (await ctx.db.select().from(s.bots).where(eq(s.bots.id, order.botId)))[0];
  const itens = order.items.map((i) => i.name).join(" + ");
  const falta = charge.amountCents - info.paidCents;

  await logEvent(ctx, { accountId: order.accountId, botId: order.botId, customerId: customer.id, type: "underpaid", meta: { chargeId: charge.id, orderId: order.id, paidCents: info.paidCents, expectedCents: charge.amountCents } });

  // Conversa no Atendimento com o motivo (a equipe já vê o que aconteceu ao abrir).
  const { ticket } = await openTicket(ctx, { accountId: order.accountId, customerId: customer.id, botId: order.botId, topic: "pagamento com valor diferente" });
  await addMessage(ctx, ticket, {
    sender: "system",
    text: `Pagamento com valor diferente: o pedido (${itens}) era de ${brl(charge.amountCents)} e o cliente pagou ${brl(info.paidCents)} (faltam ${brl(falta)}). O acesso NÃO foi liberado.`,
  });

  // Explica ao cliente.
  try {
    const api = await rt.api(order.botId);
    const aberto = isSupportOpen(account.settings, ctx.now());
    await api.sendMessage(
      customer.telegramUserId,
      `⚠️ <b>Recebemos seu Pix, mas o valor foi diferente do pedido.</b>\n\nPedido: ${esc(itens)} — <b>${brl(charge.amountCents)}</b>\nVocê pagou: <b>${brl(info.paidCents)}</b>\n\nPor isso o acesso ainda não foi liberado. Já abrimos um atendimento para você: ${aberto ? "um atendente vai te responder aqui nesta conversa." : esc(offHoursText(account.settings))}`,
      { parse_mode: "HTML" },
    );
  } catch (err) {
    ctx.log.warn({ chargeId: charge.id, err: String(err) }, "falha ao avisar o cliente do valor divergente");
  }

  // Canal de avisos.
  const notifyChat = account.settings.notifyChatId;
  if (notifyChat) {
    try {
      const who = customer.username ? `@${customer.username}` : `${customer.firstName ?? ""} (${customer.telegramUserId})`;
      const api = await rt.api(account.settings.notifyBotId || order.botId);
      await api.sendMessage(
        notifyChat,
        `⚠️ <b>Valor divergente</b>\nCliente: ${esc(who)}\nPedido: ${esc(itens)} — cobrado <b>${brl(charge.amountCents)}</b>, recebido <b>${brl(info.paidCents)}</b>\nBot: @${esc(bot?.username ?? "?")} · ${charge.provider}\nAcesso não liberado. Atendimento aberto em painel.botlybrasil.tech/atendimento`,
        { parse_mode: "HTML" },
      );
    } catch (err) {
      ctx.log.warn({ chargeId: charge.id, err: String(err) }, "falha ao avisar o canal sobre valor divergente");
    }
  }
}
