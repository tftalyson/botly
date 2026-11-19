// Lista de planos: ao mandar uma nova, a anterior é apagada (os planos podem ter mudado).
import { desc, eq, sql } from "drizzle-orm";
import type { Transformer } from "grammy";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb } from "../src/db/client.js";
import { runMigrations } from "../src/db/migrate.js";
import * as s from "../src/db/schema.js";
import type { Ctx } from "../src/domain/context.js";
import { encryptJson } from "../src/lib/crypto.js";
import { silentLog } from "../src/lib/log.js";
import { createRuntime } from "../src/bot/runtime.js";

const URL = process.env.DATABASE_URL ?? "postgres://postgres:dev@127.0.0.1:5432/botly_test";
const SECRET = "q".repeat(40);
const USER = 9393;
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



beforeAll(async () => {
  await runMigrations(URL);
  await db.execute(sql`truncate accounts, super_admins cascade`);
  const [a] = await db.insert(s.accounts).values({ name: "CT", slug: "ct" }).returning();
  accountId = a!.id;
  const [g] = await db.insert(s.gateways).values({ accountId, provider: "pushinpay", label: "P", secret: encryptJson({ token: "t" }, SECRET), webhookToken: "w" }).returning();
  const [ch] = await db.insert(s.channels).values({ accountId, telegramChatId: -1003, title: "VIP", type: "channel", rightsOk: true, inviteLink: "https://t.me/+a" }).returning();
  const [b] = await db
    .insert(s.bots)
    .values({ accountId, telegramBotId: 93, username: "ct_bot", name: "CT", tokenEnc: encryptJson({ token: "93:" + "x".repeat(35) }, SECRET), webhookSecret: "s", mainChannelId: ch!.id, routing: { mode: "fixed", gatewayIds: [g!.id] } })
    .returning();
  botId = b!.id;
  await db.insert(s.plans).values({ accountId, botId, name: "Mensal", durationUnit: "month", durationValue: 1, priceCents: 2490 });
  const [c] = await db.insert(s.customers).values({ accountId, telegramUserId: USER, firstName: "Cris" }).returning();
  await db.insert(s.customerBots).values({ customerId: c!.id, botId });
});
afterAll(async () => {
  await pg.end();
});

const plansMsgs = () => calls.filter((c) => c.method === "sendMessage" && String(c.payload.text).includes("Escolha seu plano"));
const deleted = () => calls.filter((c) => c.method === "deleteMessage").map((c) => c.payload.message_id as number);

describe("lista de planos", () => {
  it("ao pedir os planos de novo, apaga a lista anterior", async () => {
    calls.length = 0;
    await rt.handle(botId, cb("plans") as any);
    expect(plansMsgs().length).toBe(1);
    expect(deleted().length).toBe(0); // a primeira não apaga nada
    const firstId = calls.findIndex((c) => c.method === "sendMessage") + 1; // message_id = posição na fila do teste
    await rt.handle(botId, cb("plans") as any);
    expect(plansMsgs().length).toBe(2);
    expect(deleted()).toEqual([firstId]);
  });

  it("os preços novos aparecem na lista nova (plano alterado entre as duas)", async () => {
    calls.length = 0;
    await db.update(s.plans).set({ priceCents: 1990 }).where(eq(s.plans.botId, botId));
    await rt.handle(botId, cb("plans") as any);
    const kb = JSON.stringify(plansMsgs()[0]!.payload.reply_markup);
    expect(kb).toContain("19,90");
    expect(deleted().length).toBe(1);
  });
  it("a cor escolhida no plano vai no botão (e sem cor não manda o campo)", async () => {
    await db.update(s.plans).set({ buttonStyle: "success" }).where(eq(s.plans.botId, botId));
    calls.length = 0;
    await rt.handle(botId, cb("plans") as any);
    const btn = plansMsgs()[0]!.payload.reply_markup.inline_keyboard[0][0];
    expect(btn.style).toBe("success");
    await db.update(s.plans).set({ buttonStyle: null }).where(eq(s.plans.botId, botId));
    calls.length = 0;
    await rt.handle(botId, cb("plans") as any);
    expect("style" in plansMsgs()[0]!.payload.reply_markup.inline_keyboard[0][0]).toBe(false);
  });
  it("apaga o Pix vencido, mas deixa o Pix ainda válido", async () => {
    const cust = (await db.select().from(s.customers).where(eq(s.customers.telegramUserId, USER)))[0]!;
    const gw = (await db.select().from(s.gateways))[0]!;
    const mk = async (status: "pending" | "paid", expiresAt: Date, ids: number[]) => {
      const [o] = await db.insert(s.orders).values({ accountId, botId, customerId: cust.id, kind: "new", items: [], subtotalCents: 1, totalCents: 1 }).returning();
      await db.insert(s.charges).values({ accountId, orderId: o!.id, gatewayId: gw.id, provider: "pushinpay", providerTxId: "x" + ids[0], amountCents: 1, status, expiresAt, chatMessageIds: ids });
    };
    await mk("pending", new Date(now.getTime() - 60_000), [701, 702]); // vencido
    await mk("pending", new Date(now.getTime() + 20 * 60_000), [703, 704]); // ainda vale
    await mk("paid", new Date(now.getTime() - 60_000), [705]); // pago: comprovante fica
    calls.length = 0;
    await rt.handle(botId, cb("plans") as any);
    expect(deleted().filter((m) => m >= 700).sort()).toEqual([701, 702]);
  });
});
