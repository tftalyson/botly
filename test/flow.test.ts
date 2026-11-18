// Fluxo completo com Telegram e PushinPay simulados:
// cadastro → /start → maioridade → planos → order bump → Pix → aviso de pagamento
// → acessos liberados → pedido de entrada aprovado/recusado.
import { randomBytes } from "node:crypto";
import { desc, eq, sql } from "drizzle-orm";
import type { Transformer } from "grammy";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb } from "../src/db/client.js";
import { runMigrations } from "../src/db/migrate.js";
import * as s from "../src/db/schema.js";
import type { Ctx } from "../src/domain/context.js";
import { registerBot, registerChannel } from "../src/domain/setup.js";
import { encryptJson } from "../src/lib/crypto.js";
import { silentLog } from "../src/lib/log.js";
import { addDuration, extendExpiry, startOfDay } from "../src/lib/time.js";
import { createRuntime } from "../src/bot/runtime.js";
import { announceUnderpaid } from "../src/bot/notify.js";
import { checkCharge } from "../src/domain/sales.js";
import { apiForToken } from "../src/bot/api.js";
import { buildApi } from "../src/api/server.js";
import { gatewayOrder } from "../src/payments/routing.js";
import { removeFromChannel } from "../src/domain/removal.js";
import { buildPanel } from "../src/panel/server.js";

const URL = process.env.DATABASE_URL ?? "postgres://postgres:dev@127.0.0.1:5432/botly_test";
const SECRET = "x".repeat(40);
const TOKEN = "123456:" + "A".repeat(35);
const BOT_TG_ID = 123456;
const VIP = -1001111;
const EXTRA = -1002222;
const USER = 777;

const { db, sql: pg } = createDb(URL);
let now = new Date("2026-11-15T13:00:00Z");
const calls: { method: string; payload: any }[] = [];
const pixPaid = new Set<string>();
const pixValue = new Map<string, number>(); // valor que o gateway diz ter recebido (padrão 3480)
let pixSeq = 0;

const tg: Transformer = async (_prev, method, payload: any) => {
  calls.push({ method, payload });
  const ok = (result: unknown) => ({ ok: true, result }) as any;
  switch (method) {
    case "getMe":
      return ok({ id: BOT_TG_ID, is_bot: true, first_name: "Top Teste", username: "TopTeste_bot" });
    case "getChat":
      return ok({ id: payload.chat_id, type: "channel", title: payload.chat_id === VIP ? "VIP Hotwifes" : "VIP Trans" });
    case "getChatMember":
      return ok({ status: "administrator", user: { id: BOT_TG_ID }, can_invite_users: true, can_restrict_members: true });
    case "createChatInviteLink":
      return ok({ invite_link: `https://t.me/+link${payload.chat_id}`, creates_join_request: true });
    case "sendMessage":
    case "sendPhoto":
    case "editMessageText":
      return ok({ message_id: calls.length, date: 0, chat: { id: payload.chat_id ?? USER, type: "private" }, text: payload.text ?? "" });
    default:
      return ok(true);
  }
};

const fakeFetch = (async (input: any, init?: any) => {
  const u = String(input);
  if (u.endsWith("/pix/cashIn")) {
    const id = `tx${++pixSeq}`;
    return new Response(JSON.stringify({ id, qr_code: "00020101021226PIXCODE" + id, qr_code_base64: "data:image/png;base64,iVBORw0KGgo=", status: "created", value: JSON.parse(init.body).value }), { status: 200 });
  }
  const m = u.match(/\/transactions\/(.+)$/);
  if (m) {
    const id = decodeURIComponent(m[1]!);
    return new Response(JSON.stringify({ id, status: pixPaid.has(id) ? "paid" : "created", value: pixValue.get(id) ?? 3480 }), { status: 200 });
  }
  return new Response("{}", { status: 404 });
}) as typeof fetch;

const ctx: Ctx = { db, appSecret: SECRET, publicUrl: "https://api.teste", fetch: fakeFetch, now: () => now, log: silentLog };
const rt = createRuntime(ctx, { transformer: tg });
ctx.onUnderpaid = (info) => announceUnderpaid(ctx, rt, info);
let upd = 0;
const user = { id: USER, is_bot: false, first_name: "João", username: "joao" };
const msg = (text: string) => ({ update_id: ++upd, message: { message_id: upd, date: 0, chat: { id: USER, type: "private" }, from: user, text, entities: text.startsWith("/") ? [{ type: "bot_command", offset: 0, length: text.split(" ")[0]!.length }] : undefined } });
const cb = (data: string) => ({ update_id: ++upd, callback_query: { id: String(upd), from: user, chat_instance: "x", data, message: { message_id: 1, date: 0, chat: { id: USER, type: "private" }, text: "tela" } } });
const sent = (method: string) => calls.filter((c) => c.method === method);
const lastText = () => [...calls].reverse().find((c) => c.method === "sendMessage" || c.method === "editMessageText")?.payload.text as string;

let botId = "";
let accountId = "";
let gatewayId = "";
let planId = "";

beforeAll(async () => {
  await runMigrations(URL);
  await db.execute(sql`truncate accounts, super_admins cascade`);
  const [a] = await db.insert(s.accounts).values({ name: "Teste", slug: "teste" + randomBytes(3).toString("hex"), settings: { ageGate: true } }).returning();
  accountId = a!.id;
  const [g] = await db.insert(s.gateways).values({ accountId, provider: "pushinpay", label: "Push", secret: encryptJson({ token: "tok" }, SECRET), webhookToken: "wtok" }).returning();
  gatewayId = g!.id;
});
afterAll(async () => {
  await pg.end();
});

describe("datas", () => {
  it("mês respeita o calendário e renovação soma ao vencimento", () => {
    expect(addDuration(new Date("2026-01-31T12:00:00Z"), "month", 1)!.toISOString()).toBe("2026-02-28T12:00:00.000Z");
    const cur = new Date("2026-11-20T00:00:00Z");
    expect(extendExpiry(cur, false, new Date("2026-11-15T00:00:00Z"), "day", 7)!.toISOString()).toBe("2026-11-27T00:00:00.000Z");
    expect(extendExpiry(new Date("2026-11-01T00:00:00Z"), false, new Date("2026-11-15T00:00:00Z"), "day", 7)!.toISOString()).toBe("2026-11-22T00:00:00.000Z");
    expect(extendExpiry(null, true, now, "day", 7)).toBeNull();
    expect(startOfDay(new Date("2026-11-15T02:00:00Z")).toISOString()).toBe("2026-11-14T03:00:00.000Z");
  });
});

describe("venda completa", () => {
  it("cadastra bot e canais", async () => {
    const b = await registerBot(ctx, accountId, TOKEN, { transformer: tg });
    botId = b.id;
    expect(sent("setWebhook")[0]!.payload.url).toBe(`https://api.teste/tg/${botId}`);
    const api = apiForToken(TOKEN, tg);
    const { channel: vip, rights } = await registerChannel(ctx, b, api, VIP);
    expect(rights.ok).toBe(true);
    expect(sent("createChatInviteLink")[0]!.payload.creates_join_request).toBe(true);
    const pub = await registerChannel(ctx, b, apiForToken(TOKEN, async (prev, m, pl: any) => (m === "getChat" ? ({ ok: true, result: { id: -1009, type: "channel", title: "Público", username: "publico" } } as any) : tg(prev, m, pl))), -1009);
    expect(pub.rights.ok).toBe(false);
    await db.delete(s.channels).where(eq(s.channels.id, pub.channel.id));
    const { channel: extra } = await registerChannel(ctx, b, api, EXTRA);
    await db.update(s.channels).set({ extraPriceCents: 990, displayName: "VIP Trans Brasil" }).where(eq(s.channels.id, extra.id));
    const [p] = await db.insert(s.plans).values({ accountId, botId, name: "Mensal", durationUnit: "month", durationValue: 1, priceCents: 2490 }).returning();
    planId = p!.id;
    await db
      .update(s.bots)
      .set({ mainChannelId: vip.id, routing: { mode: "alternar", gatewayIds: [gatewayId] }, upsell: { orderBump: { enabled: true, channelIds: [extra.id] } }, welcome: { text: "Bem-vindo!" } })
      .where(eq(s.bots.id, botId));
  });

  it("/start pede maioridade e depois mostra a boas-vindas", async () => {
    await rt.handle(botId, msg("/start insta") as any);
    expect(lastText()).toContain("18 anos");
    await rt.handle(botId, cb("age:ok") as any);
    expect(lastText()).toBe("Bem-vindo!");
    const c = (await db.select().from(s.customers))[0]!;
    expect(c.source).toBe("insta");
    expect(c.ageConfirmedAt).not.toBeNull();
  });

  it("planos → order bump → Pix", async () => {
    const edits = sent("editMessageText").length;
    await rt.handle(botId, cb("plans") as any);
    expect(lastText()).toContain("Escolha seu plano");
    expect(sent("editMessageText").length).toBe(edits); // nova mensagem, histórico preservado
    await rt.handle(botId, cb(`p:${planId}`) as any);
    expect(lastText()).toContain("VIP Trans Brasil"); // nome que o cliente vê
    const order = (await db.select().from(s.orders))[0]!;
    await rt.handle(botId, cb(`bump:y:${order.id}`) as any);
    const o2 = (await db.select().from(s.orders).where(eq(s.orders.id, order.id)))[0]!;
    expect(o2.totalCents).toBe(3480);
    expect(sent("sendPhoto").length).toBe(1);
    expect(lastText()).toContain("PIXCODE");
    const c = (await db.select().from(s.customers))[0]!;
    expect(c.funnelStage).toBe("pix_generated");
    // Escolher o mesmo plano de novo (ou "gerar outro" com um banco só) reenvia o MESMO Pix.
    await rt.handle(botId, cb(`p:${planId}`) as any);
    await rt.handle(botId, cb(`new:${order.id}`) as any);
    expect((await db.select().from(s.charges)).length).toBe(1);
    expect((await db.select().from(s.orders)).length).toBe(1);
    expect(lastText()).toContain("PIXCODE");
  });

  it("aviso da PushinPay libera os dois canais, uma vez só", async () => {
    const app = buildApi(ctx, rt);
    const charge = (await db.select().from(s.charges))[0]!;
    const bad = await app.inject({ method: "POST", url: `/pay/pushinpay/${gatewayId}?token=errado`, payload: { id: charge.providerTxId } });
    expect(bad.statusCode).toBe(401);
    // Aviso antes de pagar: confere na API e não libera.
    const early = await app.inject({ method: "POST", url: `/pay/pushinpay/${gatewayId}?token=wtok`, payload: { id: charge.providerTxId } });
    expect(early.json().paid).toBe(false);
    pixPaid.add(charge.providerTxId!);
    // Token no caminho e id em maiúsculas (como alguns gateways mandam).
    const r = await app.inject({ method: "POST", url: `/pay/pushinpay/${gatewayId}/wtok`, payload: `id=${charge.providerTxId!.toUpperCase()}&status=paid`, headers: { "content-type": "application/x-www-form-urlencoded" } });
    expect(r.json().paid).toBe(true);
    const again = await app.inject({ method: "POST", url: `/pay/pushinpay/${gatewayId}?token=wtok`, payload: { id: charge.providerTxId } });
    expect(again.json().paid).toBe(false);
    const accs = await db.select().from(s.accesses);
    expect(accs.length).toBe(2);
    expect(accs[0]!.expiresAt!.toISOString()).toBe(accs[1]!.expiresAt!.toISOString());
    expect(accs[0]!.expiresAt!.toISOString()).toBe("2026-12-15T13:00:00.000Z");
    const c = (await db.select().from(s.customers))[0]!;
    expect(c.totalSpentCents).toBe(3480);
    expect(c.purchases).toBe(1);
    expect(lastText()).toContain("Pagamento confirmado");
    // O Pix (QR + código) some da conversa na confirmação.
    expect(sent("deleteMessage").map((c) => c.payload.message_id)).toEqual(expect.arrayContaining(charge.chatMessageIds));
    expect(charge.chatMessageIds.length).toBe(2);
    await app.close();
  });

  it("pedido de entrada: assinante aprovado, estranho recusado", async () => {
    const join = (from: any) => ({ update_id: ++upd, chat_join_request: { chat: { id: VIP, type: "channel", title: "VIP Hotwifes" }, from, user_chat_id: from.id, date: 0 } });
    await rt.handle(botId, join(user) as any);
    expect(sent("approveChatJoinRequest").length).toBe(1);
    const c = (await db.select().from(s.customers))[0]!;
    expect(c.funnelStage).toBe("joined");
    await rt.handle(botId, join({ id: 999, is_bot: false, first_name: "X" }) as any);
    expect(sent("declineChatJoinRequest").length).toBe(1);
    expect(lastText()).toContain("plano ativo");
  });

  it("três toques seguidos no plano geram um Pix só", async () => {
    const u2 = { id: 888, is_bot: false, first_name: "Ana" };
    const cb2 = (data: string) => ({ update_id: ++upd, callback_query: { id: String(upd), from: u2, chat_instance: "y", data, message: { message_id: 1, date: 0, chat: { id: 888, type: "private" }, text: "planos" } } });
    // Sem extra para simplificar.
    await db.update(s.bots).set({ upsell: {} }).where(eq(s.bots.id, botId));
    await Promise.all([rt.handle(botId, cb2(`p:${planId}`) as any), rt.handle(botId, cb2(`p:${planId}`) as any), rt.handle(botId, cb2(`p:${planId}`) as any)]);
    const cust = (await db.select().from(s.customers).where(eq(s.customers.telegramUserId, 888)))[0]!;
    const orders = await db.select().from(s.orders).where(eq(s.orders.customerId, cust.id));
    expect(orders.length).toBe(1);
    expect((await db.select().from(s.charges).where(eq(s.charges.orderId, orders[0]!.id))).length).toBe(1);
    expect(sent("answerCallbackQuery").some((c) => /aguarde/i.test(c.payload.text ?? ""))).toBe(true);
  });

  it("renovar soma ao vencimento e não oferece extra que já tem", async () => {
    now = new Date("2026-12-10T13:00:00Z");
    await rt.handle(botId, cb(`p:${planId}`) as any);
    const orders = await db.select().from(s.orders).where(eq(s.orders.kind, "renewal"));
    expect(orders.length).toBe(1);
    expect(lastText()).toContain("PIXCODE"); // foi direto ao Pix, sem order bump
    const ch = (await db.select().from(s.charges).where(eq(s.charges.orderId, orders[0]!.id)))[0]!;
    pixPaid.add(ch.providerTxId!);
    const app = buildApi(ctx, rt);
    await app.inject({ method: "POST", url: `/pay/pushinpay/${gatewayId}?token=wtok`, payload: { id: ch.providerTxId } });
    await app.close();
    const vip = (await db.select().from(s.channels).where(eq(s.channels.telegramChatId, VIP)))[0]!;
    const acc = (await db.select().from(s.accesses).where(eq(s.accesses.channelId, vip.id)))[0]!;
    expect(acc.expiresAt!.toISOString()).toBe("2027-01-15T13:00:00.000Z");
  });
});

describe("atendimento", () => {
  const panel = () => buildPanel(ctx, { transformer: tg, webDir: "/nao-existe" });
  let cookie = "";
  const call = async (app: ReturnType<typeof buildPanel>, method: string, url: string, payload?: unknown) =>
    app.inject({ method: method as any, url, payload: payload as any, headers: { cookie, ...(method !== "GET" ? { "x-botly": "1" } : {}) } });

  it("assinante vê o menu com acessos, renovar e suporte", async () => {
    await rt.handle(botId, msg("/start") as any);
    const m = [...calls].reverse().find((c) => c.method === "sendMessage")!;
    expect(m.payload.text).toContain("Seus acessos");
    const btns = JSON.stringify(m.payload.reply_markup);
    expect(btns).toContain("Renovar / mudar de plano");
    expect(btns).toContain('"sup"');
  });

  it("pede atendente, escreve, e o painel responde com o nome escolhido", async () => {
    await rt.handle(botId, cb("sup") as any);
    expect(lastText()).toContain("Como podemos ajudar");
    await rt.handle(botId, cb("sup:human") as any);
    expect(lastText()).toContain("atendente já vai responder");
    await rt.handle(botId, msg("não consigo entrar") as any);
    await rt.handle(botId, { update_id: ++upd, message: { message_id: upd, date: 0, chat: { id: USER, type: "private" }, from: user, photo: [{ file_id: "F1", file_unique_id: "u", width: 1, height: 1 }], caption: "comprovante" } } as any);

    const app = panel();
    const r = await app.inject({ method: "POST", url: "/api/setup", payload: { name: "Talyson", email: "t@t.com", password: "senha-forte-1", accountName: "Teste" }, headers: { "x-botly": "1" } });
    cookie = String(r.headers["set-cookie"]).split(";")[0]!;
    expect((await call(app, "PUT", "/api/support-settings", { start: "10:00", end: "22:00", offMessage: "", supportName: "Suporte Top" })).statusCode).toBe(200);

    const list = (await call(app, "GET", "/api/support")).json();
    expect(list.counts.open).toBe(1);
    const tk = list.tickets[0];
    expect(tk.unread).toBe(2);
    expect(tk.preview.text).toBe("comprovante");
    const det = (await call(app, "GET", `/api/support/${tk.id}`)).json();
    expect(det.messages.filter((m: any) => m.sender === "customer").length).toBe(2);
    expect(det.messages.some((m: any) => m.mediaType === "photo")).toBe(true);
    expect(det.accesses.length).toBeGreaterThan(0);

    calls.length = 0;
    expect((await call(app, "POST", `/api/support/${tk.id}/reply`, { text: "Oi, já te ajudo" })).statusCode).toBe(200);
    const texts = sent("sendMessage").map((c) => c.payload.text);
    expect(texts[0]).toContain("Suporte Top</b> entrou na conversa");
    expect(texts[1]).toBe("<b>Suporte Top:</b> Oi, já te ajudo");
    expect((await call(app, "GET", "/api/support?status=active")).json().tickets.length).toBe(1);

    expect((await call(app, "POST", `/api/support/${tk.id}/send-links`)).statusCode).toBe(200);
    expect(JSON.stringify(sent("sendMessage").at(-1)!.payload.reply_markup)).toContain("Entrar no");

    expect((await call(app, "POST", `/api/support/${tk.id}/close`)).statusCode).toBe(200);
    expect(lastText()).toContain("Atendimento encerrado");
    // Depois de encerrado, mensagem solta não vai para o painel.
    await rt.handle(botId, msg("obrigado") as any);
    expect(lastText()).toContain("toque em 💬 Suporte");
    const det2 = (await call(app, "GET", `/api/support/${tk.id}`)).json();
    expect(det2.ticket.status).toBe("closed");
    expect(det2.messages.filter((m: any) => m.sender === "customer").length).toBe(2);
    await app.close();
  });

  it("fora do horário avisa o cliente", async () => {
    const before = now;
    now = new Date("2026-12-11T03:00:00Z"); // 00:00 em São Paulo
    await rt.handle(botId, cb("sup:human") as any);
    expect(lastText()).toContain("atendimento é das 10:00 às 22:00");
    // Pode seguir comprando sozinho com a conversa aberta.
    await rt.handle(botId, cb("plans") as any);
    expect(JSON.stringify([...calls].reverse().find((c) => c.method === "sendMessage" || c.method === "editMessageText")!.payload.reply_markup)).toContain('"p:');
    await rt.handle(botId, cb("sup:end") as any);
    now = before;
  });
});

describe("remoção", () => {
  it("bane e desbane, e o acesso fica removido", async () => {
    const vip = (await db.select().from(s.channels).where(eq(s.channels.telegramChatId, VIP)))[0]!;
    const cust = (await db.select().from(s.customers).where(eq(s.customers.telegramUserId, USER)))[0]!;
    await removeFromChannel(ctx, apiForToken(TOKEN, tg), { channel: vip, customer: cust, reason: "manual" });
    expect(sent("banChatMember").at(-1)!.payload.user_id).toBe(USER);
    expect(sent("unbanChatMember").at(-1)!.payload.only_if_banned).toBe(true);
    const acc = (await db.select().from(s.accesses).where(eq(s.accesses.channelId, vip.id)))[0]!;
    expect(acc.status).toBe("removed");
  });
});

describe("rotação de gateways", () => {
  it("alternar escolhe o que gerou menos cobranças hoje", async () => {
    const [g2] = await db.insert(s.gateways).values({ accountId, provider: "pushinpay", label: "Push 2", secret: encryptJson({ token: "t2" }, SECRET), webhookToken: "w2" }).returning();
    const list = await gatewayOrder(db, accountId, { mode: "alternar", gatewayIds: [gatewayId, g2!.id] }, now, "America/Sao_Paulo");
    expect(list[0]!.id).toBe(g2!.id);
    const fixed = await gatewayOrder(db, accountId, { mode: "fixed", gatewayIds: [gatewayId, g2!.id] }, now, "America/Sao_Paulo");
    expect(fixed[0]!.id).toBe(gatewayId);
    const avoid = await gatewayOrder(db, accountId, { mode: "fixed", gatewayIds: [gatewayId, g2!.id] }, now, "America/Sao_Paulo", { avoid: gatewayId });
    expect(avoid[0]!.id).toBe(g2!.id);
  });
});

describe("valor diferente do pedido", () => {
  it("não libera, explica ao cliente, abre atendimento, avisa o canal (uma vez) e mostra o rastro", async () => {
    await db.update(s.accounts).set({ settings: { ageGate: true, notifyChatId: -555 } }).where(eq(s.accounts.id, accountId));
    now = new Date("2027-02-01T13:00:00Z");
    await rt.handle(botId, cb(`p:${planId}`) as any);
    const order = (await db.select().from(s.orders).where(eq(s.orders.status, "pending")).orderBy(desc(s.orders.createdAt)))[0]!;
    const ch = (await db.select().from(s.charges).where(eq(s.charges.orderId, order.id)))[0]!;
    pixPaid.add(ch.providerTxId!);
    pixValue.set(ch.providerTxId!, 100); // pagou R$ 1,00 em vez do valor do plano
    calls.length = 0;

    expect(await checkCharge(ctx, ch.id)).toBe("pending");
    expect(await checkCharge(ctx, ch.id)).toBe("pending"); // conferência repetida não avisa de novo

    expect((await db.select().from(s.orders).where(eq(s.orders.id, order.id)))[0]!.status).toBe("pending");
    const msgs = sent("sendMessage");
    expect(msgs.filter((m) => m.payload.chat_id === USER && String(m.payload.text).includes("valor foi diferente")).length).toBe(1);
    expect(msgs.filter((m) => m.payload.chat_id === -555 && String(m.payload.text).includes("Valor divergente")).length).toBe(1);

    const tk = (await db.select().from(s.supportTickets).where(eq(s.supportTickets.topic, "pagamento com valor diferente")))[0]!;
    expect(["open", "active"]).toContain(tk.status);
    const sys = await db.select().from(s.supportMessages).where(eq(s.supportMessages.ticketId, tk.id));
    expect(sys.some((m) => m.sender === "system" && String(m.text).includes("O acesso NÃO foi liberado"))).toBe(true);

    const app = buildPanel(ctx, { transformer: tg, webDir: "/nao-existe" });
    const login = await app.inject({ method: "POST", url: "/api/login", payload: { email: "t@t.com", password: "senha-forte-1" }, headers: { "x-botly": "1" } });
    const cookie = String(login.headers["set-cookie"]).split(";")[0]!;
    const det = (await app.inject({ method: "GET", url: `/api/support/${tk.id}`, headers: { cookie } })).json();
    expect(det.trail.steps.find((x: any) => x.key === "started").reached).toBe(true);
    expect(det.trail.events.some((e: any) => e.type === "underpaid" && e.label.includes("valor diferente"))).toBe(true);
    expect(det.trail.stoppedAt).toBeNull(); // este cliente já tinha passado por todas as etapas
    await app.close();
  });
});
