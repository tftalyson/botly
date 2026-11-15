// Números do painel (Início): vendas, conversão, upsell, pacotes, renovação e projeções,
// sempre no fuso da conta e comparando com o período anterior de mesmo tamanho.
import { and, eq, gt, gte, inArray, isNotNull, lt, or, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import * as s from "../db/schema.js";
import { addDays, atLocal, DEFAULT_TZ, startOfDay, zoned } from "../lib/time.js";

export type RangeKey = "today" | "yesterday" | "7d" | "week" | "month" | "30d" | "all" | "custom";

/** Começo (inclusivo) e fim (exclusivo) do período, no fuso. */
export function rangeBounds(key: RangeKey, now: Date, tz = DEFAULT_TZ, custom?: { from?: string; to?: string }): { from: Date; to: Date } {
  const z = zoned(now, tz);
  const day = (n: number) => {
    const d = addDays(z.year, z.month, z.day, n);
    return atLocal(d.year, d.month, d.day, "00:00", tz);
  };
  const tomorrow = day(1);
  switch (key) {
    case "today":
      return { from: day(0), to: tomorrow };
    case "yesterday":
      return { from: day(-1), to: day(0) };
    case "7d":
      return { from: day(-6), to: tomorrow };
    case "30d":
      return { from: day(-29), to: tomorrow };
    case "week": {
      // Semana começa na segunda.
      const dow = (new Date(Date.UTC(z.year, z.month - 1, z.day)).getUTCDay() + 6) % 7;
      return { from: day(-dow), to: tomorrow };
    }
    case "month":
      return { from: atLocal(z.year, z.month, 1, "00:00", tz), to: tomorrow };
    case "all":
      return { from: new Date("2020-01-01T00:00:00Z"), to: tomorrow };
    case "custom": {
      const p = (v?: string) => v?.match(/^(\d{4})-(\d{2})-(\d{2})$/);
      const a = p(custom?.from);
      const b = p(custom?.to);
      if (!a || !b) return { from: day(-6), to: tomorrow };
      const from = atLocal(+a[1]!, +a[2]!, +a[3]!, "00:00", tz);
      const e = addDays(+b[1]!, +b[2]!, +b[3]!, 1);
      const to = atLocal(e.year, e.month, e.day, "00:00", tz);
      return to > from ? { from, to } : { from: to, to: from };
    }
  }
}

const pct = (a: number, b: number) => (b > 0 ? a / b : null);

interface PeriodNumbers {
  revenueCents: number;
  sales: number;
  newSales: number;
  renewals: number;
  bundles: number;
  bundleCents: number;
  extraCents: number;
  started: number;
  convertedFromStarted: number;
  pixOrders: number;
  pixPaid: number;
  bumpOffered: number;
  bumpAccepted: number;
  renewalsWithExtra: number;
  lost: number;
}

async function periodNumbers(db: Db, accountId: string, from: Date, to: Date): Promise<PeriodNumbers> {
  const paid = await db
    .select({ kind: s.orders.kind, total: s.orders.totalCents, items: s.orders.items })
    .from(s.orders)
    .where(and(eq(s.orders.accountId, accountId), eq(s.orders.status, "paid"), gte(s.orders.paidAt, from), lt(s.orders.paidAt, to)));
  let extraCents = 0;
  let renewalsWithExtra = 0;
  for (const o of paid) {
    const ex = o.items.filter((i) => i.type === "extra");
    extraCents += ex.reduce((x, i) => x + i.priceCents, 0);
    if (o.kind === "renewal" && ex.length) renewalsWithExtra++;
  }
  const bundles = paid.filter((o) => o.kind === "bundle");

  // Conversão: de quem deu /start no período, quantos compraram (até agora).
  const started = await db
    .selectDistinct({ c: s.events.customerId })
    .from(s.events)
    .where(and(eq(s.events.accountId, accountId), eq(s.events.type, "started"), gte(s.events.createdAt, from), lt(s.events.createdAt, to)));
  const startedIds = started.map((x) => x.c).filter((x): x is string => !!x);
  let convertedFromStarted = 0;
  for (let i = 0; i < startedIds.length; i += 1000) {
    const r = await db
      .select({ n: sql<number>`count(distinct ${s.orders.customerId})::int` })
      .from(s.orders)
      .where(and(eq(s.orders.status, "paid"), inArray(s.orders.customerId, startedIds.slice(i, i + 1000)), gte(s.orders.paidAt, from)));
    convertedFromStarted += r[0]?.n ?? 0;
  }

  // Pix gerados no período e quantos foram pagos.
  const [pix] = await db
    .select({
      orders: sql<number>`count(distinct ${s.orders.id})::int`,
      paid: sql<number>`count(distinct ${s.orders.id}) filter (where ${s.orders.status} = 'paid')::int`,
    })
    .from(s.orders)
    .innerJoin(s.charges, eq(s.charges.orderId, s.orders.id))
    .where(and(eq(s.orders.accountId, accountId), gte(s.orders.createdAt, from), lt(s.orders.createdAt, to)));

  const ev = await db
    .select({ type: s.events.type, n: sql<number>`count(*)::int` })
    .from(s.events)
    .where(and(eq(s.events.accountId, accountId), inArray(s.events.type, ["bump_offered", "bump_accepted"]), gte(s.events.createdAt, from), lt(s.events.createdAt, to)))
    .groupBy(s.events.type);

  // Vencimentos no período que não renovaram (perdidos).
  const [lost] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(s.accesses)
    .where(and(eq(s.accesses.accountId, accountId), inArray(s.accesses.status, ["expired", "removed"]), isNotNull(s.accesses.expiresAt), gte(s.accesses.expiresAt, from), lt(s.accesses.expiresAt, to)));

  return {
    revenueCents: paid.reduce((x, o) => x + o.total, 0),
    sales: paid.length,
    newSales: paid.filter((o) => o.kind === "new" || o.kind === "recovery" || o.kind === "upsell").length,
    renewals: paid.filter((o) => o.kind === "renewal").length,
    bundles: bundles.length,
    bundleCents: bundles.reduce((x, o) => x + o.total, 0),
    extraCents,
    started: startedIds.length,
    convertedFromStarted,
    pixOrders: pix?.orders ?? 0,
    pixPaid: pix?.paid ?? 0,
    bumpOffered: ev.find((e) => e.type === "bump_offered")?.n ?? 0,
    bumpAccepted: ev.find((e) => e.type === "bump_accepted")?.n ?? 0,
    renewalsWithExtra,
    lost: lost?.n ?? 0,
  };
}

function rates(p: PeriodNumbers) {
  return {
    conversion: pct(p.convertedFromStarted, p.started),
    pixConversion: pct(p.pixPaid, p.pixOrders),
    renewal: pct(p.renewals, p.renewals + p.lost),
    bumpTake: pct(p.bumpAccepted, p.bumpOffered),
    renewalUpsell: pct(p.renewalsWithExtra, p.renewals),
    bundleShare: pct(p.bundleCents, p.revenueCents),
    avgTicket: p.sales ? Math.round(p.revenueCents / p.sales) : null,
  };
}

export async function dashboard(db: Db, accountId: string, now: Date, tz: string, key: RangeKey, custom?: { from?: string; to?: string }) {
  let { from, to } = rangeBounds(key, now, tz, custom);
  if (key === "all") {
    const first = await db.select({ d: sql<Date | null>`min(${s.orders.paidAt})` }).from(s.orders).where(eq(s.orders.accountId, accountId));
    const f = first[0]?.d ? new Date(first[0].d) : null;
    if (f) from = startOfDay(f, tz);
  }
  const len = to.getTime() - from.getTime();
  const prevFrom = new Date(from.getTime() - len);
  const cur = await periodNumbers(db, accountId, from, to);
  const prev = key === "all" ? null : await periodNumbers(db, accountId, prevFrom, from);

  // Série por dia (ou por mês, em períodos longos).
  const byMonth = len > 95 * 86_400_000;
  const bucket = byMonth ? "month" : "day";
  const series = await db
    .select({
      day: sql<string>`to_char(date_trunc(${sql.raw(`'${bucket}'`)}, ${s.orders.paidAt} at time zone ${tz}), 'YYYY-MM-DD')`,
      kind: s.orders.kind,
      cents: sql<number>`sum(${s.orders.totalCents})::int`,
      n: sql<number>`count(*)::int`,
    })
    .from(s.orders)
    .where(and(eq(s.orders.accountId, accountId), eq(s.orders.status, "paid"), gte(s.orders.paidAt, from), lt(s.orders.paidAt, to)))
    .groupBy(sql`1`, s.orders.kind);
  const days: { day: string; newCents: number; renewalCents: number; bundleCents: number; count: number }[] = [];
  {
    const z = zoned(from, tz);
    let d = { year: z.year, month: z.month, day: byMonth ? 1 : z.day };
    for (let i = 0; i < 400; i++) {
      const key2 = `${d.year}-${String(d.month).padStart(2, "0")}-${String(d.day).padStart(2, "0")}`;
      if (atLocal(d.year, d.month, d.day, "00:00", tz) >= to) break;
      const rows = series.filter((r) => r.day === key2);
      days.push({
        day: key2,
        newCents: rows.filter((r) => r.kind !== "renewal" && r.kind !== "bundle").reduce((x, r) => x + r.cents, 0),
        renewalCents: rows.filter((r) => r.kind === "renewal").reduce((x, r) => x + r.cents, 0),
        bundleCents: rows.filter((r) => r.kind === "bundle").reduce((x, r) => x + r.cents, 0),
        count: rows.reduce((x, r) => x + r.n, 0),
      });
      d = byMonth ? { year: d.month === 12 ? d.year + 1 : d.year, month: d.month === 12 ? 1 : d.month + 1, day: 1 } : addDays(d.year, d.month, d.day, 1);
    }
  }

  // Funil (pessoas únicas com cada etapa no período).
  const funnelTypes = ["started", "viewed_plans", "chose_plan", "pix_generated"] as const;
  const fr = await db
    .select({ type: s.events.type, n: sql<number>`count(distinct ${s.events.customerId})::int` })
    .from(s.events)
    .where(and(eq(s.events.accountId, accountId), inArray(s.events.type, [...funnelTypes]), gte(s.events.createdAt, from), lt(s.events.createdAt, to)))
    .groupBy(s.events.type);
  const [paidPeople] = await db
    .select({ n: sql<number>`count(distinct ${s.orders.customerId})::int` })
    .from(s.orders)
    .where(and(eq(s.orders.accountId, accountId), eq(s.orders.status, "paid"), inArray(s.orders.kind, ["new", "bundle", "recovery"]), gte(s.orders.paidAt, from), lt(s.orders.paidAt, to)));
  const funnel = [
    { step: "Iniciaram o bot (/start)", n: fr.find((x) => x.type === "started")?.n ?? 0 },
    { step: "Viram os planos", n: fr.find((x) => x.type === "viewed_plans")?.n ?? 0 },
    { step: "Escolheram um plano", n: fr.find((x) => x.type === "chose_plan")?.n ?? 0 },
    { step: "Geraram o Pix", n: fr.find((x) => x.type === "pix_generated")?.n ?? 0 },
    { step: "Pagaram (compra nova)", n: paidPeople?.n ?? 0 },
  ];

  // Rankings.
  const paidOrders = await db
    .select({ botId: s.orders.botId, total: s.orders.totalCents, items: s.orders.items, kind: s.orders.kind })
    .from(s.orders)
    .where(and(eq(s.orders.accountId, accountId), eq(s.orders.status, "paid"), gte(s.orders.paidAt, from), lt(s.orders.paidAt, to)));
  const bots = await db.select({ id: s.bots.id, username: s.bots.username }).from(s.bots).where(eq(s.bots.accountId, accountId));
  const botRank = bots
    .map((b) => {
      const os = paidOrders.filter((o) => o.botId === b.id);
      return { bot: b.username, cents: os.reduce((x, o) => x + o.total, 0), sales: os.length, renewals: os.filter((o) => o.kind === "renewal").length };
    })
    .filter((b) => b.sales > 0)
    .sort((a, b) => b.cents - a.cents);
  const planMap = new Map<string, { name: string; bot: string; sales: number; cents: number }>();
  for (const o of paidOrders) {
    for (const it of o.items) {
      if (it.type === "extra") continue;
      const k = `${it.type}:${it.refId}`;
      const cur2 = planMap.get(k) ?? { name: it.type === "bundle" ? `📦 ${it.name}` : it.name, bot: bots.find((b) => b.id === o.botId)?.username ?? "?", sales: 0, cents: 0 };
      cur2.sales++;
      cur2.cents += it.priceCents;
      planMap.set(k, cur2);
    }
  }
  const planRank = [...planMap.values()].sort((a, b) => b.sales - a.sales).slice(0, 10);

  // Projeções.
  const d30 = rangeBounds("30d", now, tz);
  const last30 = rates(await periodNumbers(db, accountId, d30.from, d30.to));
  const renewalRate = last30.renewal ?? 0.5;
  const in30 = new Date(now.getTime() + 30 * 86_400_000);
  const [due] = await db
    .select({ cents: sql<number>`coalesce(sum(coalesce(${s.plans.priceCents}, ${s.accesses.lastPriceCents}, 0)), 0)::int`, n: sql<number>`count(*)::int` })
    .from(s.accesses)
    .leftJoin(s.plans, eq(s.plans.id, s.accesses.planId))
    .where(and(eq(s.accesses.accountId, accountId), eq(s.accesses.status, "active"), gt(s.accesses.expiresAt, now), lt(s.accesses.expiresAt, in30)));
  const monthB = rangeBounds("month", now, tz);
  const [mtd] = await db
    .select({ cents: sql<number>`coalesce(sum(${s.orders.totalCents}), 0)::int` })
    .from(s.orders)
    .where(and(eq(s.orders.accountId, accountId), eq(s.orders.status, "paid"), gte(s.orders.paidAt, monthB.from), lt(s.orders.paidAt, now)));
  const zNow = zoned(now, tz);
  const daysInMonth = new Date(Date.UTC(zNow.year, zNow.month, 0)).getUTCDate();
  const elapsed = Math.max(1 / 24, (now.getTime() - monthB.from.getTime()) / 86_400_000);
  const [actives] = await db
    .select({ n: sql<number>`count(distinct ${s.accesses.customerId})::int` })
    .from(s.accesses)
    .where(and(eq(s.accesses.accountId, accountId), eq(s.accesses.status, "active"), or(sql`${s.accesses.expiresAt} is null`, gt(s.accesses.expiresAt, now))));

  return {
    range: { key, from, to, bucket },
    current: { ...cur, ...rates(cur) },
    previous: prev ? { ...prev, ...rates(prev) } : null,
    series: days,
    funnel,
    botRank,
    planRank,
    activeSubscribers: actives?.n ?? 0,
    projections: {
      renewalsDue30: { count: due?.n ?? 0, potentialCents: due?.cents ?? 0, expectedCents: Math.round((due?.cents ?? 0) * renewalRate), rate: renewalRate, rateIsEstimate: last30.renewal === null },
      monthPace: { soFarCents: mtd?.cents ?? 0, projectedCents: Math.round(((mtd?.cents ?? 0) / elapsed) * daysInMonth), daysInMonth, dayOfMonth: zNow.day },
    },
  };
}
