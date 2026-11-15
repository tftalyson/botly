// Venda: pedido → Pix → pagamento confirmado → acesso liberado/estendido.
import { and, eq, inArray, sql } from "drizzle-orm";
import * as s from "../db/schema.js";
import type { OrderItem } from "./types.js";
import { FUNNEL, type Ctx, type FunnelStage } from "./context.js";
import { gatewayClient, type PixCreated } from "../payments/gateway.js";
import { gatewayOrder } from "../payments/routing.js";
import { platformFee } from "../lib/money.js";
import { extendExpiry, DEFAULT_TZ } from "../lib/time.js";

export const PIX_VALID_MINUTES = 30;

type Order = typeof s.orders.$inferSelect;
type Charge = typeof s.charges.$inferSelect;
type Access = typeof s.accesses.$inferSelect;

/** Avança a etapa do funil do cliente (nunca volta). */
export async function advanceFunnel(ctx: Ctx, customerId: string, stage: FunnelStage) {
  const idx = FUNNEL.indexOf(stage);
  const lower = FUNNEL.slice(0, idx);
  if (!lower.length) return;
  await ctx.db
    .update(s.customers)
    .set({ funnelStage: stage })
    .where(and(eq(s.customers.id, customerId), inArray(s.customers.funnelStage, lower as unknown as FunnelStage[])));
}

export async function logEvent(ctx: Ctx, e: { accountId: string; botId?: string | null; customerId?: string | null; type: string; meta?: Record<string, unknown> }) {
  await ctx.db.insert(s.events).values({ accountId: e.accountId, botId: e.botId ?? null, customerId: e.customerId ?? null, type: e.type, meta: e.meta ?? {} });
}

export async function createOrder(
  ctx: Ctx,
  a: { accountId: string; botId: string; customerId: string; kind: Order["kind"]; items: OrderItem[]; discountCents?: number; source?: string | null },
): Promise<Order> {
  const subtotal = a.items.reduce((t, i) => t + i.priceCents, 0);
  const discount = Math.min(subtotal, a.discountCents ?? 0);
  const [o] = await ctx.db
    .insert(s.orders)
    .values({ accountId: a.accountId, botId: a.botId, customerId: a.customerId, kind: a.kind, items: a.items, subtotalCents: subtotal, discountCents: discount, totalCents: subtotal - discount, source: a.source ?? null })
    .returning();
  return o!;
}

export class NoGatewayError extends Error {}

/**
 * Gera o Pix do pedido no gateway escolhido pela regra do bot. Se um gateway
 * falhar, tenta o próximo. avoidGatewayId = "gerar outro Pix" (outro banco primeiro).
 */
export async function createPixForOrder(ctx: Ctx, orderId: string, opts: { avoidGatewayId?: string | null } = {}): Promise<{ charge: Charge; pix: PixCreated }> {
  const order = (await ctx.db.select().from(s.orders).where(eq(s.orders.id, orderId)))[0];
  if (!order) throw new Error("pedido não encontrado");
  const bot = (await ctx.db.select().from(s.bots).where(eq(s.bots.id, order.botId!)))[0];
  const account = (await ctx.db.select().from(s.accounts).where(eq(s.accounts.id, order.accountId)))[0]!;
  if (!bot) throw new Error("bot não encontrado");
  const now = ctx.now();
  const tz = account.settings.timezone ?? DEFAULT_TZ;
  const list = await gatewayOrder(ctx.db, order.accountId, bot.routing, now, tz, { avoid: opts.avoidGatewayId });
  if (!list.length) throw new NoGatewayError("Nenhuma forma de pagamento ativa neste bot.");
  const expiresAt = new Date(now.getTime() + PIX_VALID_MINUTES * 60_000);
  const errors: string[] = [];
  for (const g of list) {
    const [charge] = await ctx.db
      .insert(s.charges)
      .values({
        accountId: order.accountId,
        orderId: order.id,
        gatewayId: g.id,
        provider: g.provider,
        amountCents: order.totalCents,
        platformFeeCents: platformFee(order.totalCents, account.platformFeeBps),
        expiresAt,
      })
      .returning();
    try {
      const client = gatewayClient(g, ctx.appSecret, ctx.fetch);
      const pix = await client.createPix({
        amountCents: order.totalCents,
        ref: `B${charge!.id}`,
        description: `Pedido ${order.id.slice(0, 8)}`,
        expiresAt,
        webhookUrl: `${ctx.publicUrl.replace(/\/+$/, "")}/pay/${g.provider}/${g.id}?token=${g.webhookToken}`,
      });
      const [saved] = await ctx.db.update(s.charges).set({ providerTxId: pix.txId, pixCode: pix.code }).where(eq(s.charges.id, charge!.id)).returning();
      return { charge: saved!, pix };
    } catch (err) {
      errors.push(`${g.label}: ${(err as Error).message}`);
      ctx.log.warn({ gateway: g.id, err: (err as Error).message }, "gateway falhou ao gerar Pix");
      await ctx.db.update(s.charges).set({ status: "failed", raw: { error: (err as Error).message } }).where(eq(s.charges.id, charge!.id));
    }
  }
  throw new NoGatewayError(`Não foi possível gerar o Pix (${errors.join(" | ")})`);
}

export interface PaidResult {
  order: Order;
  charge: Charge;
  accesses: Access[];
}

/**
 * Marca a cobrança como paga e libera/estende os acessos. Seguro contra avisos
 * repetidos: só a primeira chamada faz algo (as outras devolvem null).
 */
export async function markChargePaid(ctx: Ctx, chargeId: string, raw?: unknown): Promise<PaidResult | null> {
  const now = ctx.now();
  return ctx.db.transaction(async (tx) => {
    const [charge] = await tx
      .update(s.charges)
      .set({ status: "paid", paidAt: now, ...(raw !== undefined ? { raw } : {}) })
      .where(and(eq(s.charges.id, chargeId), sql`${s.charges.status} <> 'paid'`))
      .returning();
    if (!charge) return null;
    const [order] = await tx
      .update(s.orders)
      .set({ status: "paid", paidAt: now })
      .where(and(eq(s.orders.id, charge.orderId), sql`${s.orders.status} <> 'paid'`))
      .returning();
    // Pedido já pago por outra cobrança (cliente pagou dois Pix): fica registrado, sem liberar de novo.
    if (!order) return null;

    const accesses: Access[] = [];
    // O plano principal vem antes, para o extra "alinhar" no vencimento novo dele.
    const items = [...order.items].sort((a, b) => (a.type === "extra" ? 1 : 0) - (b.type === "extra" ? 1 : 0));
    let mainExpiry: Date | null | undefined;
    for (const item of items) {
      for (const channelId of item.channelIds) {
        const cur = (await tx.select().from(s.accesses).where(and(eq(s.accesses.customerId, order.customerId), eq(s.accesses.channelId, channelId))))[0];
        const active = cur && cur.status === "active";
        const hadLifetime = !!active && cur.expiresAt === null;
        let expiresAt: Date | null;
        if (item.type === "extra" && mainExpiry !== undefined) {
          // Extra comprado junto: vence junto com o plano.
          expiresAt = mainExpiry;
          if (active && (cur.expiresAt === null || (expiresAt && cur.expiresAt > expiresAt))) expiresAt = cur.expiresAt;
        } else if (item.type === "extra" && item.alignToExpiresAt) {
          expiresAt = new Date(item.alignToExpiresAt);
          if (active && (cur.expiresAt === null || cur.expiresAt > expiresAt)) expiresAt = cur.expiresAt;
        } else {
          expiresAt = extendExpiry(active ? cur.expiresAt : null, hadLifetime, now, item.durationUnit, item.durationValue);
        }
        if (item.type !== "extra" && mainExpiry === undefined) mainExpiry = expiresAt;
        const values = {
          status: "active" as const,
          expiresAt,
          planId: item.type === "plan" ? item.refId : (cur?.planId ?? null),
          lastPriceCents: item.type === "plan" ? item.priceCents : (cur?.lastPriceCents ?? item.priceCents),
          billingBotId: order.botId,
          lastOrderId: order.id,
          removedAt: null,
          updatedAt: now,
        };
        const [acc] = cur
          ? await tx.update(s.accesses).set(values).where(eq(s.accesses.id, cur.id)).returning()
          : await tx.insert(s.accesses).values({ accountId: order.accountId, customerId: order.customerId, channelId, source: "purchase", ...values }).returning();
        accesses.push(acc!);
      }
    }

    await tx
      .update(s.customers)
      .set({ totalSpentCents: sql`${s.customers.totalSpentCents} + ${order.totalCents}`, purchases: sql`${s.customers.purchases} + 1` })
      .where(eq(s.customers.id, order.customerId));
    await tx
      .update(s.customers)
      .set({ funnelStage: "paid" })
      .where(and(eq(s.customers.id, order.customerId), inArray(s.customers.funnelStage, ["started", "viewed_plans", "chose_plan", "pix_generated"])));
    await tx.insert(s.events).values({
      accountId: order.accountId,
      botId: order.botId,
      customerId: order.customerId,
      type: order.kind === "renewal" ? "renewed" : "paid",
      meta: { orderId: order.id, totalCents: order.totalCents, provider: charge.provider },
    });
    // Lembretes ainda agendados destes acessos: marcados como renovados.
    if (accesses.length) {
      const hasExtra = order.items.some((i) => i.type === "extra");
      await tx
        .update(s.outbox)
        .set({ outcome: hasExtra ? "renewed_upsell" : "renewed" })
        .where(and(inArray(s.outbox.accessId, accesses.map((a) => a.id)), eq(s.outbox.status, "sent"), sql`${s.outbox.outcome} is null`));
      await tx
        .update(s.outbox)
        .set({ status: "skipped" })
        .where(and(inArray(s.outbox.accessId, accesses.map((a) => a.id)), eq(s.outbox.status, "scheduled")));
    }
    return { order, charge, accesses };
  });
}

/** Confere uma cobrança no gateway e, se paga, confirma. */
export async function checkCharge(ctx: Ctx, chargeId: string): Promise<PaidResult | "pending" | null> {
  const charge = (await ctx.db.select().from(s.charges).where(eq(s.charges.id, chargeId)))[0];
  if (!charge || !charge.providerTxId || !charge.gatewayId) return null;
  if (charge.status === "paid") return null;
  const g = (await ctx.db.select().from(s.gateways).where(eq(s.gateways.id, charge.gatewayId)))[0];
  if (!g) return null;
  const st = await gatewayClient(g, ctx.appSecret, ctx.fetch).status(charge.providerTxId);
  if (!st.paid) return "pending";
  if (st.amountCents !== null && st.amountCents < charge.amountCents) {
    ctx.log.warn({ chargeId, paid: st.amountCents, expected: charge.amountCents }, "pago com valor menor: não liberado");
    return "pending";
  }
  return markChargePaid(ctx, charge.id, st);
}
