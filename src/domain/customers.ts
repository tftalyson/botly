// Clientes: cadastro automático a cada contato e consulta de acessos.
import { and, eq, gt, isNull, or, sql } from "drizzle-orm";
import * as s from "../db/schema.js";
import type { Ctx } from "./context.js";

export type Customer = typeof s.customers.$inferSelect;

export interface TgUser {
  id: number;
  username?: string;
  first_name?: string;
  last_name?: string;
}

/** Cria ou atualiza o cliente e o vínculo com o bot. Devolve se era novo neste bot. */
export async function touchCustomer(ctx: Ctx, accountId: string, botId: string, u: TgUser, source?: string | null): Promise<{ customer: Customer; newInBot: boolean }> {
  const now = ctx.now();
  const [customer] = await ctx.db
    .insert(s.customers)
    .values({ accountId, telegramUserId: u.id, username: u.username ?? null, firstName: u.first_name ?? null, lastName: u.last_name ?? null, source: source ?? null, lastSeenAt: now })
    .onConflictDoUpdate({
      target: [s.customers.accountId, s.customers.telegramUserId],
      set: {
        username: u.username ?? null,
        firstName: u.first_name ?? null,
        lastName: u.last_name ?? null,
        lastSeenAt: now,
        source: sql`coalesce(${s.customers.source}, excluded.source)`,
      },
    })
    .returning();
  const link = await ctx.db
    .insert(s.customerBots)
    .values({ customerId: customer!.id, botId, source: source ?? null })
    .onConflictDoUpdate({ target: [s.customerBots.customerId, s.customerBots.botId], set: { lastInteractionAt: now, canMessage: true } })
    .returning({ inserted: sql<boolean>`(xmax = 0)` });
  const newInBot = !!link[0]?.inserted;
  return { customer: customer!, newInBot };
}

/** Acesso ativo (não vencido) do cliente a um canal. */
export async function activeAccess(ctx: Ctx, customerId: string, channelId: string) {
  const now = ctx.now();
  return (
    await ctx.db
      .select()
      .from(s.accesses)
      .where(
        and(
          eq(s.accesses.customerId, customerId),
          eq(s.accesses.channelId, channelId),
          eq(s.accesses.status, "active"),
          or(isNull(s.accesses.expiresAt), gt(s.accesses.expiresAt, now)),
        ),
      )
  )[0];
}
