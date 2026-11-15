// Remoção de um cliente do canal (corte por vencimento ou manual).
// Bane e logo desbane: a pessoa sai do canal, mas pode voltar se pagar de novo.
import { and, eq } from "drizzle-orm";
import type { Api } from "grammy";
import * as s from "../db/schema.js";
import type { Ctx } from "./context.js";
import { logEvent } from "./sales.js";

export async function removeFromChannel(ctx: Ctx, api: Api, a: { channel: typeof s.channels.$inferSelect; customer: typeof s.customers.$inferSelect; reason: "expired" | "manual" }) {
  const chatId = a.channel.telegramChatId;
  const userId = a.customer.telegramUserId;
  await api.banChatMember(chatId, userId);
  await api.unbanChatMember(chatId, userId, { only_if_banned: true });
  const now = ctx.now();
  await ctx.db
    .update(s.accesses)
    .set({ status: "removed", removedAt: now, updatedAt: now })
    .where(and(eq(s.accesses.customerId, a.customer.id), eq(s.accesses.channelId, a.channel.id)));
  await logEvent(ctx, { accountId: a.channel.accountId, customerId: a.customer.id, type: "removed", meta: { channelId: a.channel.id, reason: a.reason } });
}
