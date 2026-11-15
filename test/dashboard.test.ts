// Números do painel: vendas, conversão, upsell, pacotes, renovação e períodos.
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb } from "../src/db/client.js";
import { runMigrations } from "../src/db/migrate.js";
import * as s from "../src/db/schema.js";
import { encryptJson } from "../src/lib/crypto.js";
import { dashboard, funnelPeople, rangeBounds } from "../src/panel/dashboard.js";
import type { OrderItem } from "../src/domain/types.js";

const URL = process.env.DATABASE_URL ?? "postgres://postgres:dev@127.0.0.1:5432/botly_test";
const { db, sql: pg } = createDb(URL);
const now = new Date("2026-11-15T18:00:00Z"); // 15/11 15:00 em SP
const TZ = "America/Sao_Paulo";
let accountId = "";
let botId = "";

beforeAll(async () => {
  await runMigrations(URL);
  await db.execute(sql`truncate accounts, super_admins cascade`);
  const [a] = await db.insert(s.accounts).values({ name: "D", slug: "d", settings: {} }).returning();
  accountId = a!.id;
  const [ch] = await db.insert(s.channels).values({ accountId, telegramChatId: -1, title: "VIP", type: "channel" }).returning();
  const [bot] = await db.insert(s.bots).values({ accountId, telegramBotId: 1, username: "vip_bot", name: "V", tokenEnc: encryptJson({ token: "1:x" }, "k".repeat(40)), webhookSecret: "w" }).returning();
  botId = bot!.id;
  const [bot2] = await db.insert(s.bots).values({ accountId, telegramBotId: 2, username: "outro_bot", name: "O", tokenEnc: encryptJson({ token: "2:x" }, "k".repeat(40)), webhookSecret: "w2" }).returning();
  const plan = (id: string, cents: number): OrderItem => ({ type: "plan", refId: id, name: "Mensal", channelIds: [ch!.id], durationUnit: "month", durationValue: 1, priceCents: cents });
  const cust = async (tg: number) => (await db.insert(s.customers).values({ accountId, telegramUserId: tg }).returning())[0]!;
  const today = new Date("2026-11-15T14:00:00Z");
  const yesterday = new Date("2026-11-14T14:00:00Z");
  // 4 pessoas deram /start hoje; 2 compraram (uma com extra); 1 gerou Pix e não pagou.
  const cs = await Promise.all([1, 2, 3, 4].map(cust));
  for (const c of cs) await db.insert(s.events).values({ accountId, customerId: c.id, botId: bot!.id, type: "started", createdAt: today });
  await db.insert(s.events).values([
    { accountId, botId: bot!.id, customerId: cs[0]!.id, type: "bump_offered", createdAt: today },
    { accountId, botId: bot!.id, customerId: cs[1]!.id, type: "bump_offered", createdAt: today },
    { accountId, botId: bot!.id, customerId: cs[0]!.id, type: "bump_accepted", createdAt: today },
  ]);
  const order = async (c: string, kind: "new" | "renewal" | "bundle", items: OrderItem[], status: "paid" | "pending", at: Date) => {
    const total = items.reduce((x, i) => x + i.priceCents, 0);
    const [o] = await db.insert(s.orders).values({ accountId, botId: bot!.id, customerId: c, kind, items, subtotalCents: total, totalCents: total, status, createdAt: at, paidAt: status === "paid" ? at : null }).returning();
    await db.insert(s.charges).values({ accountId, orderId: o!.id, provider: "pushinpay", amountCents: total, status: status === "paid" ? "paid" : "pending", createdAt: at, paidAt: status === "paid" ? at : null });
  };
  await order(cs[0]!.id, "new", [plan("p1", 2490), { ...plan("x", 990), type: "extra", name: "Extra" }], "paid", today);
  await order(cs[1]!.id, "bundle", [{ ...plan("b1", 3990), type: "bundle", name: "Combo" }], "paid", today);
  await order(cs[2]!.id, "new", [plan("p1", 2490)], "pending", today);
  // Outro bot: 1 /start e 1 venda hoje.
  const o2 = await cust(50);
  await db.insert(s.events).values({ accountId, customerId: o2.id, botId: bot2!.id, type: "started", createdAt: today });
  {
    const [o] = await db.insert(s.orders).values({ accountId, botId: bot2!.id, customerId: o2.id, kind: "new", items: [plan("p9", 1000)], subtotalCents: 1000, totalCents: 1000, status: "paid", createdAt: today, paidAt: today }).returning();
    await db.insert(s.charges).values({ accountId, orderId: o!.id, provider: "pushinpay", amountCents: 1000, status: "paid", createdAt: today, paidAt: today });
  }
  // Ontem: 1 renovação e 1 vencido que não renovou.
  const old = await cust(9);
  await order(old.id, "renewal", [plan("p1", 2490)], "paid", yesterday);
  await db.insert(s.accesses).values({ accountId, billingBotId: bot!.id, customerId: cs[3]!.id, channelId: ch!.id, status: "removed", expiresAt: yesterday });
});
afterAll(async () => {
  await pg.end();
});

describe("dashboard", () => {
  it("períodos no fuso de São Paulo", () => {
    const t = rangeBounds("today", now, TZ);
    expect(t.from.toISOString()).toBe("2026-11-15T03:00:00.000Z");
    expect(rangeBounds("week", now, TZ).from.toISOString()).toBe("2026-11-09T03:00:00.000Z"); // segunda
    expect(rangeBounds("month", now, TZ).from.toISOString()).toBe("2026-11-01T03:00:00.000Z");
  });

  it("hoje: vendas, conversão, upsell e pacotes", async () => {
    const d = await dashboard(db, accountId, now, TZ, "today", undefined, [botId]);
    expect(d.current.revenueCents).toBe(2490 + 990 + 3990);
    expect(d.current.sales).toBe(2);
    expect(d.current.avgTicket).toBe(Math.round(7470 / 2));
    expect(d.current.conversion).toBe(0.5); // 2 de 4 que deram /start
    expect(d.current.pixConversion).toBeCloseTo(2 / 3);
    expect(d.current.bumpTake).toBe(0.5);
    expect(d.current.extraCents).toBe(990);
    expect(d.current.bundles).toBe(1);
    expect(d.current.bundleShare).toBeCloseTo(3990 / 7470);
    expect(d.previous!.revenueCents).toBe(2490);
  });

  it("ontem: taxa de renovação (1 renovou, 1 perdido)", async () => {
    const d = await dashboard(db, accountId, now, TZ, "yesterday", undefined, [botId]);
    expect(d.current.renewal).toBe(0.5);
    expect(d.planRank[0]!.name).toBe("Mensal");
  });

  it("7 dias: série diária com 7 pontos e ranking de bots", async () => {
    const d = await dashboard(db, accountId, now, TZ, "7d", undefined, [botId]);
    expect(d.series.length).toBe(7);
    expect(d.series.at(-1)!.day).toBe("2026-11-15");
    expect(d.series.at(-1)!.bundleCents).toBe(3990);
    expect(d.botRank[0]!.bot).toBe("vip_bot");
    expect(d.funnel[0]!.n).toBe(4);
  });
  it("filtro por bot", async () => {
    const all = await dashboard(db, accountId, now, TZ, "today");
    const one = await dashboard(db, accountId, now, TZ, "today", undefined, [botId]);
    const none = await dashboard(db, accountId, now, TZ, "today", undefined, []);
    expect(all.current.started).toBe(one.current.started + 1);
    expect(all.current.revenueCents).toBe(one.current.revenueCents + 1000);
    expect(one.botRank.map((b) => b.bot)).toEqual(["vip_bot"]);
    expect(none.current.sales).toBe(0);
    expect(none.funnel[0]!.n).toBe(0);
  });
  it("pessoas do funil: quem gerou Pix, qual plano e se pagou", async () => {
    const started = await funnelPeople(db, accountId, now, TZ, "today", undefined, [botId], "started");
    expect(started.total).toBe(4);
    const paid = await funnelPeople(db, accountId, now, TZ, "today", undefined, null, "paid");
    expect(paid.total).toBe(3); // 2 do vip_bot + 1 do outro bot
    expect(paid.people.every((p) => p.reached === "paid" && p.paid)).toBe(true);
    const stopped = started.people.filter((p) => p.reached === "started");
    expect(stopped.length).toBe(2);
    // Ninguém entrou ainda: todos os pagantes ficam em "Pagou, não entrou".
    expect(paid.people.every((p) => p.reached === "paid")).toBe(true);
    const d = await dashboard(db, accountId, now, TZ, "today");
    expect(d.funnel.at(-1)).toEqual({ step: "Entraram no canal", n: 0 });
    // Entrou no canal depois de pagar.
    const buyer = paid.people[0]!;
    const [ch] = await db.select().from(s.channels);
    await db.insert(s.accesses).values({ accountId, customerId: buyer.customerId, channelId: ch!.id, status: "active", expiresAt: new Date("2026-12-15T00:00:00Z"), joinedAt: new Date("2026-11-15T17:00:00Z") });
    const d2 = await dashboard(db, accountId, now, TZ, "today");
    expect(d2.funnel.at(-1)!.n).toBe(1);
    const joined = await funnelPeople(db, accountId, now, TZ, "today", undefined, null, "joined");
    expect(joined.people.map((p) => p.customerId)).toEqual([buyer.customerId]);
    expect(joined.people[0]!.reached).toBe("joined");
  });
});
