// Recuperação de Pix: 15 min lembrete, 2 h com desconto, 24 h com plano mais barato.
import { desc, eq, sql } from "drizzle-orm";
import type { Transformer } from "grammy";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb } from "../src/db/client.js";
import { runMigrations } from "../src/db/migrate.js";
import * as s from "../src/db/schema.js";
import type { Ctx } from "../src/domain/context.js";
import { recoveryTick } from "../src/domain/recovery.js";
import { encryptJson } from "../src/lib/crypto.js";
import { silentLog } from "../src/lib/log.js";
import { createRuntime } from "../src/bot/runtime.js";

const URL = process.env.DATABASE_URL ?? "postgres://postgres:dev@127.0.0.1:5432/botly_test";
const SECRET = "q".repeat(40);
const USER = 9191;
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

/** Pedido pendente com Pix gerado `agoMin` minutos antes de `now`. */
async function pending(agoMin: number) {
  const t0 = min(-agoMin);
  const [o] = await db
    .insert(s.orders)
    .values({
      accountId, botId, customerId, kind: "new", subtotalCents: 2490, totalCents: 2490, createdAt: t0,
      items: [{ type: "plan", refId: monthlyId, name: "Mensal", channelIds: [channelId], durationUnit: "month", durationValue: 1, priceCents: 2490 }],
    })
    .returning();
  await db.insert(s.charges).values({ accountId, orderId: o!.id, gatewayId, provider: "pushinpay", providerTxId: "t" + o!.id.slice(0, 6), amountCents: 2490, createdAt: t0 });
  return o!;
}
const step = async (id: string) => (await db.select().from(s.orders).where(eq(s.orders.id, id)))[0]!.recoveryStep;

beforeAll(async () => {
  await runMigrations(URL);
  await db.execute(sql`truncate accounts, super_admins cascade`);
  const [a] = await db.insert(s.accounts).values({ name: "Rec", slug: "rec" }).returning();
  accountId = a!.id;
  const [g] = await db.insert(s.gateways).values({ accountId, provider: "pushinpay", label: "P", secret: encryptJson({ token: "t" }, SECRET), webhookToken: "w" }).returning();
  gatewayId = g!.id;
  const [ch] = await db.insert(s.channels).values({ accountId, telegramChatId: -100888, title: "VIP", type: "channel", rightsOk: true, inviteLink: "https://t.me/+a" }).returning();
  channelId = ch!.id;
  const [b] = await db
    .insert(s.bots)
    .values({ accountId, telegramBotId: 66, username: "rec_bot", name: "Rec", tokenEnc: encryptJson({ token: "66:" + "x".repeat(35) }, SECRET), webhookSecret: "s", mainChannelId: ch!.id, routing: { mode: "fixed", gatewayIds: [g!.id] } })
    .returning();
  botId = b!.id;
  const [m] = await db.insert(s.plans).values({ accountId, botId, name: "Mensal", durationUnit: "month", durationValue: 1, priceCents: 2490 }).returning();
  const [w] = await db.insert(s.plans).values({ accountId, botId, name: "Semanal", durationUnit: "day", durationValue: 7, priceCents: 990 }).returning();
  monthlyId = m!.id;
  weeklyId = w!.id;
  const [c] = await db.insert(s.customers).values({ accountId, telegramUserId: USER, firstName: "Ana" }).returning();
  customerId = c!.id;
  await db.insert(s.customerBots).values({ customerId, botId });
});
afterAll(async () => {
  await pg.end();
});

describe("recuperação de Pix", () => {
  it("desligada por padrão: não manda nada", async () => {
    const o = await pending(20);
    await recoveryTick(ctx, rt);
    expect(msgs().length).toBe(0);
    expect(await step(o.id)).toBe(0);
    await db.update(s.orders).set({ status: "canceled" }).where(eq(s.orders.id, o.id));
  });

  it("15 min: lembra do Pix uma vez só; o botão mostra o Pix de novo, sem desconto", async () => {
    await db.update(s.bots).set({ recovery: { enabled: true, downsellPlanId: weeklyId } }).where(eq(s.bots.id, botId));
    const o = await pending(10);
    await recoveryTick(ctx, rt);
    expect(msgs().length).toBe(0); // ainda não deu 15 min
    now = min(6);
    await recoveryTick(ctx, rt);
    await recoveryTick(ctx, rt); // rodar de novo não repete
    expect(msgs().length).toBe(1);
    expect(String(msgs()[0]!.payload.text)).toContain("ainda está esperando");
    const data = msgs()[0]!.payload.reply_markup.inline_keyboard[0][0].callback_data as string;
    expect(data.startsWith(`rc:${o.id}:`)).toBe(true);
    expect(await step(o.id)).toBe(1);
    calls.length = 0;
    await rt.handle(botId, cb(data) as any);
    expect((await db.select().from(s.orders).where(eq(s.orders.id, o.id)))[0]!.status).toBe("pending"); // mesmo pedido
    expect((await db.select().from(s.events).where(eq(s.events.type, "recovery_sent"))).length).toBe(1);
    await db.update(s.orders).set({ status: "canceled" }).where(eq(s.orders.id, o.id));
  });

  it("2 h: oferece 10% e o botão cria o pedido com desconto (e cancela o antigo)", async () => {
    calls.length = 0;
    const o = await pending(125);
    await db.update(s.orders).set({ recoveryStep: 1 }).where(eq(s.orders.id, o.id)); // 15 min já foi
    await recoveryTick(ctx, rt);
    const m = msgs()[0]!;
    expect(String(m.payload.text)).toContain("10% de desconto");
    expect(String(m.payload.text)).toContain("22,41");
    const data = m.payload.reply_markup.inline_keyboard[0][0].callback_data as string;
    calls.length = 0;
    await rt.handle(botId, cb(data) as any);
    const rec = (await db.select().from(s.orders).where(eq(s.orders.kind, "recovery")).orderBy(desc(s.orders.createdAt)))[0]!;
    expect(rec.totalCents).toBe(2241);
    expect(rec.discountCents).toBe(249);
    expect((await db.select().from(s.orders).where(eq(s.orders.id, o.id)))[0]!.status).toBe("canceled");
    expect((await db.select().from(s.charges).where(eq(s.charges.orderId, rec.id))).length).toBe(1); // Pix gerado
  });

  it("24 h: oferece o plano mais barato", async () => {
    calls.length = 0;
    const o = await pending(1445);
    await db.update(s.orders).set({ recoveryStep: 2 }).where(eq(s.orders.id, o.id));
    await recoveryTick(ctx, rt);
    const m = msgs()[0]!;
    expect(String(m.payload.text)).toContain("Semanal");
    expect(String(m.payload.text)).toContain("9,90");
    const data = m.payload.reply_markup.inline_keyboard[0][0].callback_data as string;
    await rt.handle(botId, cb(data) as any);
    const rec = (await db.select().from(s.orders).where(eq(s.orders.kind, "recovery")).orderBy(desc(s.orders.createdAt)))[0]!;
    expect(rec.items[0]!.name).toBe("Semanal");
    expect(rec.totalCents).toBe(990);
  });

  it("sistema parado: etapas muito atrasadas são puladas, não mandadas", async () => {
    calls.length = 0;
    const o = await pending(10 * 60); // 10 h depois do Pix: 15 min e 2 h já passaram faz tempo
    await recoveryTick(ctx, rt);
    expect(msgs().length).toBe(0);
    expect(await step(o.id)).toBe(2);
    await db.update(s.orders).set({ status: "canceled" }).where(eq(s.orders.id, o.id));
  });

  it("quem já pagou outra coisa depois não é incomodado", async () => {
    calls.length = 0;
    const o = await pending(20);
    await db.insert(s.orders).values({ accountId, botId, customerId, kind: "new", items: [], subtotalCents: 1, totalCents: 1, status: "paid", paidAt: min(-5) });
    await recoveryTick(ctx, rt);
    expect(msgs().length).toBe(0);
    expect(await step(o.id)).toBe(3);
  });
});
