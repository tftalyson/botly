// Escolha do gateway de cada Pix, conforme a regra do bot.
// O 1º da lista é o escolhido; os outros ficam de reserva se ele der erro.
import { and, eq, gte, inArray, ne, or, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import * as s from "../db/schema.js";
import type { BotRouting } from "../domain/types.js";
import { startOfDay } from "../lib/time.js";

type GatewayRow = typeof s.gateways.$inferSelect;

export async function gatewayOrder(db: Db, accountId: string, routing: BotRouting, now: Date, tz: string, opts: { avoid?: string | null } = {}): Promise<GatewayRow[]> {
  if (!routing.gatewayIds.length) return [];
  const rows = await db
    .select()
    .from(s.gateways)
    .where(and(eq(s.gateways.accountId, accountId), eq(s.gateways.active, true), inArray(s.gateways.id, routing.gatewayIds)));
  // Mantém a ordem definida no bot.
  let list = routing.gatewayIds.map((id) => rows.find((r) => r.id === id)).filter((r): r is GatewayRow => !!r);
  if (list.length > 1 && routing.mode !== "fixed") {
    const dayStart = startOfDay(now, tz);
    const stats = await db
      .select({
        gatewayId: s.charges.gatewayId,
        n: sql<number>`count(*) filter (where ${s.charges.createdAt} >= ${dayStart.toISOString()}::timestamptz)::int`,
        paid: sql<number>`coalesce(sum(${s.charges.amountCents}) filter (where ${s.charges.status} = 'paid' and ${s.charges.paidAt} >= ${dayStart.toISOString()}::timestamptz), 0)::int`,
      })
      .from(s.charges)
      .where(
        and(
          eq(s.charges.accountId, accountId),
          inArray(s.charges.gatewayId, list.map((g) => g.id)),
          ne(s.charges.status, "failed"),
          or(gte(s.charges.createdAt, dayStart), gte(s.charges.paidAt, dayStart)),
        ),
      )
      .groupBy(s.charges.gatewayId);
    const st = (id: string) => stats.find((x) => x.gatewayId === id) ?? { n: 0, paid: 0 };
    if (routing.mode === "alternar") list = stable(list, (a, b) => st(a.id).n - st(b.id).n || st(a.id).paid - st(b.id).paid);
    else if (routing.mode === "equilibrar") list = stable(list, (a, b) => st(a.id).paid - st(b.id).paid || st(a.id).n - st(b.id).n);
    else if (routing.mode === "limite") {
      // Usa na ordem do bot; quem bateu o limite do dia vai para o fim.
      const over = (g: GatewayRow) => {
        const lim = routing.dailyLimitCents?.[g.id];
        return lim !== undefined && lim > 0 && st(g.id).paid >= lim;
      };
      list = [...list.filter((g) => !over(g)), ...list.filter(over)];
    }
  }
  // "Gerar outro Pix": tenta primeiro um gateway diferente do anterior.
  if (opts.avoid && list.length > 1) list = [...list.filter((g) => g.id !== opts.avoid), ...list.filter((g) => g.id === opts.avoid)];
  return list;
}

function stable<T>(arr: T[], cmp: (a: T, b: T) => number): T[] {
  return arr
    .map((v, i) => ({ v, i }))
    .sort((a, b) => cmp(a.v, b.v) || a.i - b.i)
    .map((x) => x.v);
}
