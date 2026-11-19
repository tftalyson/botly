// Transmissões: público filtrado, agendamento, envio sem repetir, bloqueio e oferta com desconto.
import { eq, sql } from "drizzle-orm";
import type { Transformer } from "grammy";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb } from "../src/db/client.js";
import { runMigrations } from "../src/db/migrate.js";
import * as s from "../src/db/schema.js";
import type { Ctx } from "../src/domain/context.js";
import { audienceRows, broadcastStats, broadcastTick } from "../src/domain/broadcast.js";
import { encryptJson } from "../src/lib/crypto.js";
import { silentLog } from "../src/lib/log.js";
import { createRuntime } from "../src/bot/runtime.js";

const URL = process.env.DATABASE_URL ?? "postgres://postgres:dev@127.0.0.1:5432/botly_test";
const SECRET = "q".repeat(40);
const { db, sql: pg } = createDb(URL);
let now = new Date("2026-11-20T15:00:00Z");
const calls: { method: string; payload: any }[] = [];
const BLOCKED = 4004;
const tg: Transformer = async (_p, method, payload: any) => {
  if (method === "sendMessage" && payload.chat_id === BLOCKED) throw new Error("Forbidden: bot was blocked by the user (403)");
  calls.push({ method, payload });
  return { ok: true, result: method.startsWith("send") ? { message_id: calls.length, date: 0, chat: { id: payload.chat_id, type: "private" } } : true } as any;
};
const fakeFetch = (async (input: any) => {
  if (String(input).endsWith("/pix/cashIn")) return new Response(JSON.stringify({ id: "tx" + calls.length, qr_code: "000201PIX" }), { status: 200 });
  return new Response("{}", { status: 404 });
}) as typeof fetch;
const ctx: Ctx = { db, appSecret: SECRET, publicUrl: "https://api.t", fetch: fakeFetch, now: () => now, log: silentLog };
const rt = createRuntime(ctx, { transformer: tg });
const sentTo = () => calls.filter((c) => c.method === "sendMessage").map((c) => c.payload.chat_id as number);
let upd = 0;
const cb = (user: number, data: string) => ({ update_id: ++upd, callback_query: { id: String(upd), from: { id: user, is_bot: false, first_name: "X" }, chat_instance: "x", data, message: { message_id: 1, date: 0, chat: { id: user, type: "private" }, text: "x" } } });
const day = (n: number) => new Date(now.getTime() + n * 86_400_000);

let accountId = "", botId = "", bot2Id = "", chId = "", ch2Id = "", planId = "";
const U = { active: 1001, expired: 1002, never: 1003, blocked: BLOCKED, both: 1005, expiring: 1006 };
const cust: Record<string, string> = {};

async function person(key: keyof typeof U, opts: { bot?: string; canMessage?: boolean; access?: { channelId: string; status: "active" | "expired"; expiresAt: Date | null }[] } = {}) {
  const [c] = await db.insert(s.customers).values({ accountId, telegramUserId: U[key], firstName: key, purchases: opts.access?.length ? 1 : 0 }).returning();
  cust[key] = c!.id;
  await db.insert(s.customerBots).values({ customerId: c!.id, botId: opts.bot ?? botId, canMessage: opts.canMessage ?? true });
  for (const a of opts.access ?? []) await db.insert(s.accesses).values({ accountId, customerId: c!.id, ...a });
}
const make = (over: Partial<typeof s.broadcasts.$inferInsert>) =>
  db.insert(s.broadcasts).values({ accountId, name: "t", botIds: [botId], audience: { segment: "all" }, content: { text: "Oi {nome}" }, scheduledAt: now, ...over }).returning().then((r) => r[0]!);
const ids = async (aud: any, bots = [botId]) => (await audienceRows(ctx, accountId, bots, aud)).map((r) => r.telegramUserId).sort();

beforeAll(async () => {
  await runMigrations(URL);
  await db.execute(sql`truncate accounts, super_admins cascade`);
  const [a] = await db.insert(s.accounts).values({ name: "BC", slug: "bc" }).returning();
  accountId = a!.id;
  const [g] = await db.insert(s.gateways).values({ accountId, provider: "pushinpay", label: "P", secret: encryptJson({ token: "t" }, SECRET), webhookToken: "w" }).returning();
  const [c1] = await db.insert(s.channels).values({ accountId, telegramChatId: -1001, title: "VIP", type: "channel", rightsOk: true, inviteLink: "https://t.me/+a" }).returning();
  const [c2] = await db.insert(s.channels).values({ accountId, telegramChatId: -1002, title: "Extra", type: "channel", rightsOk: true, inviteLink: "https://t.me/+b" }).returning();
  chId = c1!.id;
  ch2Id = c2!.id;
  const mk = async (n: number, name: string) =>
    (await db.insert(s.bots).values({ accountId, telegramBotId: n, username: name, name, tokenEnc: encryptJson({ token: `${n}:` + "x".repeat(35) }, SECRET), webhookSecret: "s" + n, mainChannelId: chId, routing: { mode: "fixed", gatewayIds: [g!.id] } }).returning())[0]!.id;
  botId = await mk(81, "bc_bot");
  bot2Id = await mk(82, "bc_bot2");
  planId = (await db.insert(s.plans).values({ accountId, botId, name: "Mensal", durationUnit: "month", durationValue: 1, priceCents: 3000 }).returning())[0]!.id;
  await person("active", { access: [{ channelId: chId, status: "active", expiresAt: day(20) }] });
  await person("expiring", { access: [{ channelId: chId, status: "active", expiresAt: day(2) }, { channelId: ch2Id, status: "active", expiresAt: day(2) }] });
  await person("expired", { access: [{ channelId: chId, status: "expired", expiresAt: day(-5) }] });
  await person("never");
  await person("blocked", { canMessage: false });
  await person("both");
  await db.insert(s.customerBots).values({ customerId: cust.both!, botId: bot2Id });
});
afterAll(async () => {
  await pg.end();
});

describe("público da transmissão", () => {
  it("filtra por segmento e nunca inclui quem bloqueou o bot", async () => {
    expect(await ids({ segment: "all" })).toEqual([1001, 1002, 1003, 1005, 1006]);
    expect(await ids({ segment: "active" })).toEqual([1001, 1006]);
    expect(await ids({ segment: "expired" })).toEqual([1002]);
    expect(await ids({ segment: "never" })).toEqual([1003, 1005]);
  });
  it("filtra por canal e por vencimento próximo", async () => {
    expect(await ids({ segment: "active", channelId: ch2Id, channelMode: "has" })).toEqual([1006]);
    expect(await ids({ segment: "active", channelId: ch2Id, channelMode: "hasnt" })).toEqual([1001]);
    expect(await ids({ segment: "active", expiringDays: 3 })).toEqual([1006]);
  });
  it("com dois bots, cada pessoa aparece uma vez só", async () => {
    const rows = await audienceRows(ctx, accountId, [botId, bot2Id], { segment: "all" });
    expect(rows.filter((r) => r.telegramUserId === 1005).length).toBe(1);
    expect(rows.length).toBe(5);
  });
});

describe("envio", () => {
  it("agendada para depois: não manda nada; na hora, manda uma vez para cada um", async () => {
    calls.length = 0;
    const b = await make({ audience: { segment: "all" }, scheduledAt: new Date(now.getTime() + 3_600_000) });
    await broadcastTick(ctx, rt);
    expect(sentTo().length).toBe(0);
    now = new Date(now.getTime() + 3_700_000);
    await broadcastTick(ctx, rt);
    await broadcastTick(ctx, rt); // rodar de novo não repete
    expect(sentTo().sort()).toEqual([1001, 1002, 1003, 1005, 1006]);
    expect(calls.find((c) => c.payload.chat_id === 1001)!.payload.text).toBe("Oi active");
    const st = await broadcastStats(ctx, b.id);
    expect(st).toMatchObject({ total: 5, sent: 5, pending: 0 });
    expect((await db.select().from(s.broadcasts).where(eq(s.broadcasts.id, b.id)))[0]!.status).toBe("done");
  });

  it("quem bloqueou o bot durante o envio vira 'bloqueou' e sai das próximas listas", async () => {
    calls.length = 0;
    await db.update(s.customerBots).set({ canMessage: true }).where(eq(s.customerBots.customerId, cust.blocked!));
    const b = await make({ audience: { segment: "all" } });
    await broadcastTick(ctx, rt);
    const st = await broadcastStats(ctx, b.id);
    expect(st.blocked).toBe(1);
    expect(st.sent).toBe(5);
    expect(await ids({ segment: "all" })).not.toContain(BLOCKED);
  });

  it("cancelada antes de começar não envia", async () => {
    calls.length = 0;
    const b = await make({ audience: { segment: "all" } });
    await db.update(s.broadcasts).set({ status: "canceled" }).where(eq(s.broadcasts.id, b.id));
    await broadcastTick(ctx, rt);
    expect(sentTo().length).toBe(0);
  });
});

describe("oferta na transmissão", () => {
  it("botão cria pedido com desconto marcado com a transmissão; vencida, avisa", async () => {
    calls.length = 0;
    const b = await make({ audience: { segment: "never" }, content: { text: "Promo", button: { kind: "offer", planId, discountPct: 20, validMinutes: 60 } } });
    await broadcastTick(ctx, rt);
    expect(sentTo().sort()).toEqual([1003, 1005]);
    const kb = calls.find((c) => c.payload.chat_id === 1003)!.payload.reply_markup.inline_keyboard[0][0];
    expect(kb.callback_data).toBe(`bo:${b.id}`);
    calls.length = 0;
    await rt.handle(botId, cb(1003, kb.callback_data) as any);
    const o = (await db.select().from(s.orders).where(eq(s.orders.source, `bc:${b.id}`)))[0]!;
    expect(o.totalCents).toBe(2400);
    expect(o.discountCents).toBe(600);
    expect((await db.select().from(s.charges).where(eq(s.charges.orderId, o.id))).length).toBe(1);
    expect((await broadcastStats(ctx, b.id)).clicks).toBe(1);
    // passou do prazo
    now = new Date(now.getTime() + 61 * 60_000);
    calls.length = 0;
    await rt.handle(botId, cb(1005, kb.callback_data) as any);
    expect(JSON.stringify(calls)).toContain("expirou");
    expect((await db.select().from(s.orders).where(eq(s.orders.source, `bc:${b.id}`))).length).toBe(1);
  });
});
