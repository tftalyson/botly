// Oferta pós-venda: quem recusou o canal extra e pagou recebe uma última chance com desconto.
import { desc, eq, sql } from "drizzle-orm";
import type { Transformer } from "grammy";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb } from "../src/db/client.js";
import { runMigrations } from "../src/db/migrate.js";
import * as s from "../src/db/schema.js";
import type { Ctx } from "../src/domain/context.js";
import { announcePaid } from "../src/bot/notify.js";
import { markChargePaid } from "../src/domain/sales.js";
import { encryptJson } from "../src/lib/crypto.js";
import { silentLog } from "../src/lib/log.js";
import { createRuntime } from "../src/bot/runtime.js";

const URL = process.env.DATABASE_URL ?? "postgres://postgres:dev@127.0.0.1:5432/botly_test";
const SECRET = "q".repeat(40);
const USER = 9292;
const { db, sql: pg } = createDb(URL);
let now = new Date("2026-11-15T16:00:00Z");
const calls: { method: string; payload: any }[] = [];
const tg: Transformer = async (_p, method, payload: any) => {
  calls.push({ method, payload });
  return { ok: true, result: method.startsWith("send") ? { message_id: calls.length, date: 0, chat: { id: USER, type: "private" } } : true } as any;
};
const fakeFetch = (async (input: any) => {
  const u = String(input);
  if (u.endsWith("/pix/cashIn")) return new Response(JSON.stringify({ id: "tx" + calls.length, qr_code: "000201PIX" }), { status: 200 });
  return new Response("{}", { status: 404 });
}) as typeof fetch;
const ctx: Ctx = { db, appSecret: SECRET, publicUrl: "https://api.t", fetch: fakeFetch, now: () => now, log: silentLog };
const rt = createRuntime(ctx, { transformer: tg });
const msgs = () => calls.filter((c) => c.method === "sendMessage" && c.payload.chat_id === USER);
let upd = 0;
const cb = (data: string) => ({ update_id: ++upd, callback_query: { id: String(upd), from: { id: USER, is_bot: false, first_name: "Ana" }, chat_instance: "x", data, message: { message_id: 1, date: 0, chat: { id: USER, type: "private" }, text: "x" } } });
const min = (m: number) => new Date(now.getTime() + m * 60_000);

let accountId = "";
let botId = "";
let customerId = "";
let monthlyId = "";
let weeklyId = "";
let channelId = "";
let gatewayId = "";
let extraId = "";


/** Pedido novo (só o plano) com Pix gerado; paga e anuncia como o sistema faz. */
async function buyAndPay() {
  const [o] = await db
    .insert(s.orders)
    .values({
      accountId, botId, customerId, kind: "new", subtotalCents: 2490, totalCents: 2490, createdAt: now,
      items: [{ type: "plan", refId: monthlyId, name: "Mensal", channelIds: [channelId], durationUnit: "month", durationValue: 1, priceCents: 2490 }],
    })
    .returning();
  const [ch] = await db.insert(s.charges).values({ accountId, orderId: o!.id, gatewayId, provider: "pushinpay", providerTxId: "t" + o!.id.slice(0, 6), amountCents: 2490, createdAt: now }).returning();
  const r = await markChargePaid(ctx, ch!.id);
  await announcePaid(ctx, rt, r!);
  return o!;
}
const decline = () => db.insert(s.events).values({ accountId, botId, customerId, type: "bump_declined", meta: { channelId: extraId }, createdAt: now });
const setPs = (ps: any) => db.update(s.bots).set({ upsell: { orderBump: { enabled: true, channelIds: [extraId] }, postSale: ps } }).where(eq(s.bots.id, botId));

beforeAll(async () => {
  await runMigrations(URL);
  await db.execute(sql`truncate accounts, super_admins cascade`);
  const [a] = await db.insert(s.accounts).values({ name: "PS", slug: "ps" }).returning();
  accountId = a!.id;
  const [g] = await db.insert(s.gateways).values({ accountId, provider: "pushinpay", label: "P", secret: encryptJson({ token: "t" }, SECRET), webhookToken: "w" }).returning();
  gatewayId = g!.id;
  const [ch] = await db.insert(s.channels).values({ accountId, telegramChatId: -100777, title: "VIP", type: "channel", rightsOk: true, inviteLink: "https://t.me/+a" }).returning();
  channelId = ch!.id;
  const [ex] = await db.insert(s.channels).values({ accountId, telegramChatId: -100778, title: "Extra", displayName: "VIP Extra", type: "channel", rightsOk: true, inviteLink: "https://t.me/+b", extraPriceCents: 1000 }).returning();
  extraId = ex!.id;
  const [b] = await db
    .insert(s.bots)
    .values({ accountId, telegramBotId: 77, username: "ps_bot", name: "PS", tokenEnc: encryptJson({ token: "77:" + "x".repeat(35) }, SECRET), webhookSecret: "s", mainChannelId: ch!.id, routing: { mode: "fixed", gatewayIds: [g!.id] } })
    .returning();
  botId = b!.id;
  const [m] = await db.insert(s.plans).values({ accountId, botId, name: "Mensal", durationUnit: "month", durationValue: 1, priceCents: 2490 }).returning();
  monthlyId = m!.id;
  const [c] = await db.insert(s.customers).values({ accountId, telegramUserId: USER, firstName: "Bia" }).returning();
  customerId = c!.id;
  await db.insert(s.customerBots).values({ customerId, botId });
});
afterAll(async () => {
  await pg.end();
});

const offerMsgs = () => msgs().filter((m) => String(m.payload.text).includes("Oferta só para você"));

describe("oferta pós-venda", () => {
  it("desligada por padrão: não manda", async () => {
    await decline();
    await buyAndPay();
    expect(offerMsgs().length).toBe(0);
  });

  it("quem recusou o extra recebe a oferta com desconto, uma vez só", async () => {
    calls.length = 0;
    await setPs({ enabled: true, discountPct: 20, validMinutes: 30 });
    await decline();
    const o = await buyAndPay();
    expect(offerMsgs().length).toBe(1);
    const t = String(offerMsgs()[0]!.payload.text);
    expect(t).toContain("8,00"); // R$ 10,00 − 20%
    expect(t).toContain("30 min");
    expect((await db.select().from(s.events).where(eq(s.events.type, "postsale_offered"))).length).toBe(1);
    // clique: pedido "upsell" com desconto, Pix gerado
    calls.length = 0;
    await rt.handle(botId, cb(`ps:${o.id}`) as any);
    const up = (await db.select().from(s.orders).where(eq(s.orders.kind, "upsell")))[0]!;
    expect(up.totalCents).toBe(800);
    expect(up.discountCents).toBe(200);
    expect(up.items[0]!.refId).toBe(extraId);
    expect((await db.select().from(s.charges).where(eq(s.charges.orderId, up.id))).length).toBe(1);
  });

  it("depois de pago, o extra é liberado e a oferta não se repete", async () => {
    calls.length = 0;
    const up = (await db.select().from(s.orders).where(eq(s.orders.kind, "upsell")))[0]!;
    const ch = (await db.select().from(s.charges).where(eq(s.charges.orderId, up.id)))[0]!;
    const r = await markChargePaid(ctx, ch.id);
    await announcePaid(ctx, rt, r!);
    expect(offerMsgs().length).toBe(0);
    const acc = await db.select().from(s.accesses).where(eq(s.accesses.channelId, extraId));
    expect(acc.length).toBe(1);
  });

  it("sem recusa recente do extra, não oferece", async () => {
    calls.length = 0;
    await db.delete(s.events).where(eq(s.events.type, "bump_declined"));
    await db.delete(s.accesses).where(eq(s.accesses.channelId, extraId));
    await buyAndPay();
    expect(offerMsgs().length).toBe(0);
  });

  it("oferta vencida: o botão avisa que expirou e não cria pedido", async () => {
    calls.length = 0;
    await db.delete(s.orders).where(eq(s.orders.kind, "upsell"));
    await decline();
    const o = await buyAndPay();
    expect(offerMsgs().length).toBe(1);
    now = new Date(now.getTime() + 31 * 60_000);
    calls.length = 0;
    await rt.handle(botId, cb(`ps:${o.id}`) as any);
    expect((await db.select().from(s.orders).where(eq(s.orders.kind, "upsell"))).length).toBe(0);
    expect(JSON.stringify(calls)).toContain("expirou");
  });
});
