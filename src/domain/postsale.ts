// Oferta pós-venda: logo depois do pagamento, quem recusou o canal extra recebe
// uma última chance com desconto e prazo curto. Uma oferta por pedido.
import { and, desc, eq, gt, sql } from "drizzle-orm";
import * as s from "../db/schema.js";
import type { Ctx } from "./context.js";
import { activeAccess } from "./customers.js";

export interface PostSaleOffer {
  channel: typeof s.channels.$inferSelect;
  fullCents: number;
  priceCents: number;
  discountPct: number;
  validMinutes: number;
}

/** Janela em que a recusa do extra ainda conta para a oferta pós-venda. */
const DECLINE_WINDOW_MS = 48 * 3_600_000;

/** Qual oferta mandar depois deste pedido pago (ou null). */
export async function pickPostSale(ctx: Ctx, bot: typeof s.bots.$inferSelect, order: typeof s.orders.$inferSelect): Promise<PostSaleOffer | null> {
  const ps = bot.upsell.postSale;
  if (!ps?.enabled || ps.discountPct < 0) return null;
  if (order.kind !== "new" && order.kind !== "recovery") return null;
  if (order.items.some((i) => i.type === "extra")) return null; // já levou o extra
  const sent = await ctx.db
    .select({ id: s.events.id })
    .from(s.events)
    .where(and(eq(s.events.accountId, order.accountId), eq(s.events.type, "postsale_offered"), sql`${s.events.meta}->>'orderId' = ${order.id}`))
    .limit(1);
  if (sent.length) return null;
  const since = new Date(ctx.now().getTime() - DECLINE_WINDOW_MS);
  const declined = (
    await ctx.db
      .select()
      .from(s.events)
      .where(and(eq(s.events.customerId, order.customerId), eq(s.events.botId, bot.id), eq(s.events.type, "bump_declined"), gt(s.events.createdAt, since)))
      .orderBy(desc(s.events.createdAt))
      .limit(1)
  )[0];
  const channelId = declined?.meta?.channelId as string | undefined;
  if (!channelId) return null;
  const ch = (await ctx.db.select().from(s.channels).where(and(eq(s.channels.id, channelId), eq(s.channels.active, true))))[0];
  if (!ch || !ch.inviteLink) return null;
  if (await activeAccess(ctx, order.customerId, ch.id)) return null;
  const full = bot.upsell.orderBump?.priceOverrides?.[ch.id] ?? ch.extraPriceCents;
  if (!full || full <= 0) return null;
  const priceCents = Math.max(1, Math.round((full * (100 - ps.discountPct)) / 100));
  return { channel: ch, fullCents: full, priceCents, discountPct: ps.discountPct, validMinutes: ps.validMinutes };
}
