// Ofertas: escolha do extra do order bump (respeitando o que o cliente já tem
// e o que recusou recentemente).
import { and, eq, gt, inArray } from "drizzle-orm";
import * as s from "../db/schema.js";
import type { Ctx } from "./context.js";
import { activeAccess } from "./customers.js";

export interface ExtraOffer {
  channel: typeof s.channels.$inferSelect;
  priceCents: number;
}

/** Primeiro canal extra que vale a pena oferecer, ou null. */
export async function pickOrderBump(ctx: Ctx, bot: typeof s.bots.$inferSelect, customerId: string, cooldownDays: number): Promise<ExtraOffer | null> {
  const ob = bot.upsell.orderBump;
  if (!ob?.enabled || !ob.channelIds?.length) return null;
  const ids = ob.channelIds.filter((id) => id !== bot.mainChannelId);
  if (!ids.length) return null;
  const chans = await ctx.db
    .select()
    .from(s.channels)
    .where(and(eq(s.channels.accountId, bot.accountId), eq(s.channels.active, true), inArray(s.channels.id, ids)));
  const since = new Date(ctx.now().getTime() - cooldownDays * 86_400_000);
  const declined = await ctx.db
    .select({ channelId: s.offerDeclines.channelId })
    .from(s.offerDeclines)
    .where(and(eq(s.offerDeclines.customerId, customerId), inArray(s.offerDeclines.channelId, ids), gt(s.offerDeclines.declinedAt, since)));
  for (const id of ids) {
    const ch = chans.find((c) => c.id === id);
    if (!ch || !ch.inviteLink) continue;
    if (declined.some((d) => d.channelId === id)) continue;
    if (await activeAccess(ctx, customerId, id)) continue;
    const price = ob.priceOverrides?.[id] ?? ch.extraPriceCents;
    if (!price || price <= 0) continue;
    return { channel: ch, priceCents: price };
  }
  return null;
}

export async function recordDecline(ctx: Ctx, customerId: string, channelId: string) {
  await ctx.db
    .insert(s.offerDeclines)
    .values({ customerId, channelId, declinedAt: ctx.now() })
    .onConflictDoUpdate({ target: [s.offerDeclines.customerId, s.offerDeclines.channelId], set: { declinedAt: ctx.now() } });
}
