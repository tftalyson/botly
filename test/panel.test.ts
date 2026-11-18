// API do painel: primeiro acesso, login, bots, canais, planos, pacotes e pagamentos.
import { eq, sql } from "drizzle-orm";
import * as s from "../src/db/schema.js";
import type { Transformer } from "grammy";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb } from "../src/db/client.js";
import { runMigrations } from "../src/db/migrate.js";
import type { Ctx } from "../src/domain/context.js";
import { silentLog } from "../src/lib/log.js";
import { buildPanel } from "../src/panel/server.js";

const URL = process.env.DATABASE_URL ?? "postgres://postgres:dev@127.0.0.1:5432/botly_test";
const { db, sql: pg } = createDb(URL);
const tg: Transformer = async (_p, method, payload: any) => {
  const ok = (result: unknown) => ({ ok: true, result }) as any;
  if (method === "getMe") return ok({ id: 555, is_bot: true, first_name: "Painel Bot", username: "PainelBot" });
  if (method === "getChat") return ok({ id: payload.chat_id, type: "channel", title: `Canal ${payload.chat_id}` });
  if (method === "getChatMember") return ok({ status: "administrator", user: { id: 555 }, can_invite_users: true, can_restrict_members: true });
  if (method === "createChatInviteLink") return ok({ invite_link: `https://t.me/+x${payload.chat_id}` });
  return ok(true);
};
const ctx: Ctx = { db, appSecret: "y".repeat(40), publicUrl: "https://api.teste", fetch, now: () => new Date(), log: silentLog };
const app = buildPanel(ctx, { transformer: tg, webDir: "/nao-existe" });
let cookie = "";
const call = async (method: string, url: string, payload?: unknown) => {
  const r = await app.inject({ method: method as any, url, payload: payload as any, headers: { cookie, ...(method !== "GET" ? { "x-botly": "1" } : {}) } });
  const set = r.headers["set-cookie"];
  if (set) cookie = String(set).split(";")[0]!;
  return { status: r.statusCode, body: r.body ? JSON.parse(r.body) : null };
};

beforeAll(async () => {
  await runMigrations(URL);
  await db.execute(sql`truncate accounts, super_admins cascade`);
});
afterAll(async () => {
  await app.close();
  await pg.end();
});

describe("painel", () => {
  it("primeiro acesso cria conta e dono, e só funciona uma vez", async () => {
    expect((await call("GET", "/api/setup")).body.needed).toBe(true);
    expect((await call("POST", "/api/setup", { accountName: "Top", name: "Talyson", email: "t@x.com", password: "fraca" })).status).toBe(400);
    expect((await call("POST", "/api/setup", { accountName: "Top", name: "Talyson", email: "t@x.com", password: "senha1234" })).status).toBe(200);
    expect((await call("GET", "/api/me")).body.user.name).toBe("Talyson");
    expect((await call("POST", "/api/setup", { accountName: "B", name: "B", email: "b@x.com", password: "senha1234" })).status).toBe(403);
  });

  it("exige login e o cabeçalho do painel", async () => {
    const saved = cookie;
    cookie = "";
    expect((await call("GET", "/api/bots")).status).toBe(401);
    expect((await call("POST", "/api/login", { email: "t@x.com", password: "errada1" })).status).toBe(401);
    expect((await call("POST", "/api/login", { email: "T@X.com", password: "senha1234" })).status).toBe(200);
    const r = await app.inject({ method: "POST", url: "/api/bots", payload: { token: "x" }, headers: { cookie } });
    expect(r.statusCode).toBe(403);
    cookie = saved;
  });

  it("segurança: cabeçalhos, login antes do corpo e limite de tamanho", async () => {
    const h = await app.inject({ method: "GET", url: "/health" });
    expect(String(h.headers["content-security-policy"])).toContain("frame-ancestors 'none'");
    // Sem login, nem lê o arquivo grande: responde 401 direto.
    const big = Buffer.alloc(3 * 1024 * 1024);
    const anon = await app.inject({ method: "POST", url: "/api/media?name=a.png&mime=image/png", payload: big, headers: { "x-botly": "1", "content-type": "application/octet-stream" } });
    expect(anon.statusCode).toBe(401);
    // Logado, corpo grande fora das rotas de mídia/importação é recusado.
    const big2 = await app.inject({ method: "POST", url: "/api/bots", payload: big, headers: { cookie, "x-botly": "1", "content-type": "application/octet-stream" } });
    expect(big2.statusCode).toBe(413);
    // E-mail inexistente e senha errada dão a mesma resposta.
    const r1 = await app.inject({ method: "POST", url: "/api/login", payload: { email: "ninguem@x.com", password: "qualquer123" }, headers: { "x-botly": "1" } });
    expect(r1.statusCode).toBe(401);
  });

  it("bots, canais, planos, pacotes e pagamento", async () => {
    expect((await call("POST", "/api/bots", { token: "abc" })).body.error).toContain("Token inválido");
    const bot = await call("POST", "/api/bots", { token: "555:" + "B".repeat(35) });
    expect(bot.body.username).toBe("PainelBot");
    const c1 = await call("POST", "/api/channels", { botId: bot.body.id, chat: "-1001" });
    const c2 = await call("POST", "/api/channels", { botId: bot.body.id, chat: "-1002" });
    expect(c1.body.rights.ok).toBe(true);
    const chans = (await call("GET", "/api/channels")).body;
    expect(chans.length).toBe(2);
    expect(chans[0].managerBot.username).toBe("PainelBot");
    const plan = await call("POST", `/api/bots/${bot.body.id}/plans`, { name: "Mensal", durationUnit: "month", durationValue: 1, priceCents: 2490 });
    expect(plan.status).toBe(200);
    expect((await call("POST", "/api/bundles", { name: "Combo", durationUnit: "month", durationValue: 1, priceCents: 3990, channelIds: [c1.body.id] })).status).toBe(400);
    expect((await call("POST", "/api/bundles", { name: "Combo", durationUnit: "month", durationValue: 1, priceCents: 3990, channelIds: [c1.body.id, c2.body.id] })).status).toBe(200);
    const gw = await call("POST", "/api/gateways", { provider: "pushinpay", label: "Push", key: "token-de-teste-123" });
    const upd = await call("PUT", `/api/bots/${bot.body.id}`, { mainChannelId: c1.body.id, routing: { mode: "alternar", gatewayIds: [gw.body.id] }, welcome: { text: "Oi!", media: null } });
    expect(upd.status).toBe(200);
    const list = (await call("GET", "/api/bots")).body;
    expect(list[0].mainChannel).toBe("Canal -1001");
    expect(list[0].hasPayment).toBe(true);
    const gws = (await call("GET", "/api/gateways")).body;
    expect(gws[0].bots).toEqual(["PainelBot"]);
    expect(JSON.stringify(gws)).not.toContain("token-de-teste");
    // Upload de mídia com os limites do Telegram.
    const png = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
    const up = await app.inject({ method: "POST", url: "/api/media?name=a.png&mime=image/png", payload: png, headers: { cookie, "x-botly": "1", "content-type": "application/octet-stream" } });
    expect(up.statusCode).toBe(200);
    const big = await app.inject({ method: "POST", url: "/api/media?name=b.jpg&mime=image/jpeg", payload: Buffer.alloc(11 * 1024 * 1024), headers: { cookie, "x-botly": "1", "content-type": "application/octet-stream" } });
    expect(big.json().error).toContain("10 MB");
    const bad = await app.inject({ method: "POST", url: "/api/media?name=c.exe&mime=application/x-msdownload", payload: png, headers: { cookie, "x-botly": "1", "content-type": "application/octet-stream" } });
    expect(bad.statusCode).toBe(400);
    const w = await call("PUT", `/api/bots/${bot.body.id}`, { welcome: { text: "Oi!", media: { type: "photo", mediaId: up.json().id } } });
    expect(w.body.welcome.media.mediaId).toBe(up.json().id);
    const got = await app.inject({ method: "GET", url: `/api/media/${up.json().id}`, headers: { cookie } });
    expect(got.rawPayload.equals(png)).toBe(true);
    // Não apaga forma de pagamento com Pix em aberto: sugere desativar; depois de vencer, apaga.
    const gw2 = await call("POST", "/api/gateways", { provider: "pushinpay", label: "Reserva", key: "token-reserva-123" });
    const acct = (await db.select().from(s.accounts))[0]!;
    const [cu] = await db.insert(s.customers).values({ accountId: acct.id, telegramUserId: 777 }).returning();
    const [od] = await db.insert(s.orders).values({ accountId: acct.id, customerId: cu!.id, kind: "new", items: [], subtotalCents: 1000, totalCents: 1000 }).returning();
    const [ch] = await db.insert(s.charges).values({ accountId: acct.id, orderId: od!.id, gatewayId: gw2.body.id, provider: "pushinpay", providerTxId: "tx-aberto", amountCents: 1000 }).returning();
    const del = await call("DELETE", `/api/gateways/${gw2.body.id}`);
    expect(del.status).toBe(409);
    expect(del.body.error).toContain("1 Pix em aberto");
    expect((await call("GET", "/api/gateways")).body.length).toBe(2);
    await db.update(s.charges).set({ status: "expired" }).where(eq(s.charges.id, ch!.id));
    expect((await call("DELETE", `/api/gateways/${gw2.body.id}`)).status).toBe(200);
    expect((await call("GET", "/api/gateways")).body.length).toBe(1);
    const ov = (await call("GET", "/api/overview")).body;
    expect(ov.checklist).toEqual({ gateway: true, bot: true, channel: true, mainChannel: true, plans: true, routing: true });
  });
});
