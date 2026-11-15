// Lembretes, renovação pelo botão, corte (simulação e real) e "volte" com desconto.
import { and, eq, sql } from "drizzle-orm";
import type { Transformer } from "grammy";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb } from "../src/db/client.js";
import { runMigrations } from "../src/db/migrate.js";
import * as s from "../src/db/schema.js";
import type { Ctx } from "../src/domain/context.js";
import { cutExpired, planOutbox, sendDue } from "../src/domain/retention.js";
import { encryptJson } from "../src/lib/crypto.js";
import { silentLog } from "../src/lib/log.js";
import { createRuntime } from "../src/bot/runtime.js";

const URL = process.env.DATABASE_URL ?? "postgres://postgres:dev@127.0.0.1:5432/botly_test";
const SECRET = "r".repeat(40);
const USER = 4242;
const { db, sql: pg } = createDb(URL);
// 15/11/2026 13:00 em São Paulo
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
const sent = (m: string) => calls.filter((c) => c.method === m);
let upd = 0;
const cb = (data: string) => ({ update_id: ++upd, callback_query: { id: String(upd), from: { id: USER, is_bot: false, first_name: "Ana" }, chat_instance: "x", data, message: { message_id: 1, date: 0, chat: { id: USER, type: "private" }, text: "x" } } });

let accountId = "";
let botId = "";
let accessId = "";
let customerId = "";

beforeAll(async () => {
  await runMigrations(URL);
  await db.execute(sql`truncate accounts, super_admins cascade`);
  const [a] = await db.insert(s.accounts).values({ name: "R", slug: "r", settings: { reminderTime: "10:00" } }).returning();
  accountId = a!.id;
  const [g] = await db.insert(s.gateways).values({ accountId, provider: "pushinpay", label: "P", secret: encryptJson({ token: "t" }, SECRET), webhookToken: "w" }).returning();
  const [ch] = await db.insert(s.channels).values({ accountId, telegramChatId: -100777, title: "VIP Hot", type: "channel", rightsOk: true, inviteLink: "https://t.me/+a" }).returning();
  const [b] = await db
    .insert(s.bots)
    .values({ accountId, telegramBotId: 55, username: "hot_bot", name: "Hot", tokenEnc: encryptJson({ token: "55:" + "x".repeat(35) }, SECRET), webhookSecret: "s", mainChannelId: ch!.id, routing: { mode: "fixed", gatewayIds: [g!.id] } })
    .returning();
  botId = b!.id;
  await db.update(s.channels).set({ managerBotId: botId }).where(eq(s.channels.id, ch!.id));
  const [p] = await db.insert(s.plans).values({ accountId, botId, name: "Mensal", durationUnit: "month", durationValue: 1, priceCents: 2490 }).returning();
  const [c] = await db.insert(s.customers).values({ accountId, telegramUserId: USER, firstName: "Ana" }).returning();
  customerId = c!.id;
  await db.insert(s.customerBots).values({ customerId, botId });
  // Vence 18/11 às 15:00 (São Paulo) = 18:00Z.
  const [acc] = await db
    .insert(s.accesses)
    .values({ accountId, customerId, channelId: ch!.id, expiresAt: new Date("2026-11-18T18:00:00Z"), planId: p!.id, lastPriceCents: 2490, billingBotId: botId })
    .returning();
  accessId = acc!.id;
});
afterAll(async () => {
  await pg.end();
});

describe("lembretes", () => {
  it("monta a fila dos próximos 8 dias (D-3, D-1, D0, D+1), sem duplicar", async () => {
    await planOutbox(ctx);
    await planOutbox(ctx);
    const rows = await db.select().from(s.outbox).where(eq(s.outbox.accessId, accessId));
    expect(rows.length).toBe(4); // D+7 (25/11) ainda está fora da janela de 8 dias
    const times = rows.map((r) => r.scheduledFor.toISOString()).sort();
    // D-3 = hoje 10:00 SP (13:00Z), D-1 = 17/11 10:00, D0 = 18/11 10:00, D+1 = 19/11 10:00
    expect(times).toEqual(["2026-11-15T13:00:00.000Z", "2026-11-17T13:00:00.000Z", "2026-11-18T13:00:00.000Z", "2026-11-19T13:00:00.000Z"]);
    expect(rows.every((r) => r.expectedCents > 0)).toBe(true);
  });

  it("manda o lembrete que está na hora, com botão de renovar", async () => {
    await sendDue(ctx, rt);
    const m = sent("sendMessage").at(-1)!;
    expect(m.payload.text).toContain("vence em <b>3 dias</b> (18/11/2026)");
    expect(JSON.stringify(m.payload.reply_markup)).toContain(`rn:${accessId}`);
    const o = await db.select().from(s.outbox).where(and(eq(s.outbox.accessId, accessId), eq(s.outbox.status, "sent")));
    expect(o.length).toBe(1);
  });

  it("botão Renovar gera Pix de renovação do mesmo plano", async () => {
    await rt.handle(botId, cb(`rn:${accessId}`) as any);
    const order = (await db.select().from(s.orders))[0]!;
    expect(order.kind).toBe("renewal");
    expect(order.totalCents).toBe(2490);
    expect(sent("sendMessage").at(-1)!.payload.text).toContain("000201PIX");
  });
});

describe("corte", () => {
  it("modo simulação: vence, fica expirado, ninguém é removido", async () => {
    now = new Date("2026-11-19T12:00:00Z");
    await cutExpired(ctx, rt);
    const a = (await db.select().from(s.accesses).where(eq(s.accesses.id, accessId)))[0]!;
    expect(a.status).toBe("expired");
    expect(sent("banChatMember").length).toBe(0);
  });

  it("lembrete de 'vence hoje' que ficou para trás não é mandado para quem já venceu", async () => {
    await sendDue(ctx, rt);
    const d0 = (await db.select().from(s.outbox).where(eq(s.outbox.accessId, accessId))).find((r) => r.scheduledFor.toISOString() === "2026-11-18T13:00:00.000Z")!;
    expect(d0.status).toBe("skipped");
  });

  it("corte ligado: remove do canal", async () => {
    const a = (await db.select().from(s.accounts))[0]!;
    await db.update(s.accounts).set({ settings: { ...a.settings, autoRemove: true } }).where(eq(s.accounts.id, a.id));
    await cutExpired(ctx, rt);
    expect(sent("banChatMember").at(-1)!.payload.user_id).toBe(USER);
    expect(sent("unbanChatMember").length).toBe(1);
    const acc = (await db.select().from(s.accesses).where(eq(s.accesses.id, accessId)))[0]!;
    expect(acc.status).toBe("removed");
  });

  it("'volte' com 15% de desconto no D+7", async () => {
    now = new Date("2026-11-25T13:05:00Z");
    await planOutbox(ctx);
    await sendDue(ctx, rt);
    // O "volte" do D+1 ficou para trás (sistema parado?): não sai atrasado.
    const d1 = (await db.select().from(s.outbox).where(eq(s.outbox.accessId, accessId))).find((r) => r.scheduledFor.toISOString() === "2026-11-19T13:00:00.000Z")!;
    expect(d1.status).toBe("skipped");
    const m = sent("sendMessage").at(-1)!;
    expect(m.payload.text).toContain("15% de desconto");
    const ob = (await db.select().from(s.outbox).where(and(eq(s.outbox.accessId, accessId), eq(s.outbox.status, "sent")))).find((r) => r.scheduledFor.toISOString() === "2026-11-25T13:00:00.000Z")!;
    await rt.handle(botId, cb(`wb:${ob.id}`) as any);
    const orders = await db.select().from(s.orders).where(eq(s.orders.source, "volte"));
    expect(orders[0]!.totalCents).toBe(2490 - 374);
  });
});
