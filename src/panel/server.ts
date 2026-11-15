// Servidor do painel das contas (BOTLY_ROLE=panel): API em /api e as telas (dist-web).
import { randomBytes } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";
import { and, asc, count, desc, eq, gt, gte, inArray, isNull, or, sql, sum } from "drizzle-orm";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import { z, ZodError } from "zod";
import * as s from "../db/schema.js";
import type { Ctx } from "../domain/context.js";
import { checkRights, registerBot, registerChannel, SetupError, ALLOWED_UPDATES } from "../domain/setup.js";
import { encryptJson } from "../lib/crypto.js";
import { DEFAULT_TZ, startOfDay } from "../lib/time.js";
import { apiForToken } from "../bot/api.js";
import { botToken } from "../bot/runtime.js";
import type { Transformer } from "grammy";
import { gatewayClient } from "../payments/gateway.js";
import { dashboard, type RangeKey } from "./dashboard.js";
import { analyze, applyImport, readSheet, suggestPlans } from "../domain/importer.js";
import { ensureTemplates, pendingRemovals, planOutbox, retentionWindow } from "../domain/retention.js";
import { hashPassword, LoginLimiter, newToken, passwordProblem, tokenHash, verifyPassword } from "./auth.js";

const COOKIE = "botly_sess";
const SESSION_DAYS = 30;

interface SessionUser {
  id: string;
  accountId: string;
  name: string;
  email: string;
  role: string;
}
declare module "fastify" {
  interface FastifyRequest {
    user?: SessionUser;
  }
}

class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
const notFound = (what: string) => new HttpError(404, `${what} não encontrado.`);

function parseCookies(h?: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (h ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".json": "application/json",
};

const cents = z.number().int().min(0).max(10_000_000);
const unit = z.enum(["day", "month", "year", "lifetime"]);

export function buildPanel(ctx: Ctx, opts: { webDir?: string; secureCookies?: boolean; logger?: boolean; transformer?: Transformer } = {}) {
  const { db } = ctx;
  const limiter = new LoginLimiter();
  const app = Fastify({ logger: opts.logger ?? false, bodyLimit: 1_000_000, trustProxy: true });
  const webDir = resolve(opts.webDir ?? "dist-web");
  const cookie = (token: string, maxAge: number) => `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${opts.secureCookies ? "; Secure" : ""}`;
  const tgApi = (row: typeof s.bots.$inferSelect) => apiForToken(botToken(row, ctx.appSecret), opts.transformer);

  app.addHook("onSend", async (_req, reply) => {
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("X-Frame-Options", "DENY");
    reply.header("Referrer-Policy", "same-origin");
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ZodError) return reply.code(400).send({ error: "Confira os campos: " + err.issues.map((i) => i.path.join(".") || i.message).join(", ") });
    if (err instanceof HttpError) return reply.code(err.status).send({ error: err.message });
    if (err instanceof SetupError) return reply.code(400).send({ error: err.message });
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status < 500) return reply.code(status).send({ error: (err as Error).message });
    ctx.log.error({ url: req.url, err: String(err) }, "painel: erro");
    return reply.code(500).send({ error: "Algo deu errado do nosso lado. Tente de novo em instantes." });
  });

  app.addContentTypeParser("application/octet-stream", { parseAs: "buffer", bodyLimit: 52 * 1024 * 1024 }, (_req, body, done) => done(null, body));

  app.get("/health", async () => ({ ok: true }));

  // ─── Sessão ───

  async function loadUser(req: FastifyRequest): Promise<SessionUser | null> {
    const token = parseCookies(req.headers.cookie)[COOKIE];
    if (!token) return null;
    const [row] = await db
      .select({ u: s.users })
      .from(s.sessions)
      .innerJoin(s.users, eq(s.users.id, s.sessions.userId))
      .where(and(eq(s.sessions.tokenHash, tokenHash(token)), eq(s.sessions.kind, "user"), gt(s.sessions.expiresAt, ctx.now())));
    if (!row || !row.u.active) return null;
    return { id: row.u.id, accountId: row.u.accountId, name: row.u.name, email: row.u.email, role: row.u.role };
  }

  async function startSession(reply: FastifyReply, userId: string) {
    const token = newToken();
    await db.insert(s.sessions).values({ tokenHash: tokenHash(token), kind: "user", userId, expiresAt: new Date(ctx.now().getTime() + SESSION_DAYS * 86400_000) });
    await db.update(s.users).set({ lastLoginAt: ctx.now() }).where(eq(s.users.id, userId));
    reply.header("Set-Cookie", cookie(token, SESSION_DAYS * 86400));
  }

  const PUBLIC = new Set(["/api/login", "/api/setup"]);
  app.addHook("preHandler", async (req, reply) => {
    if (!req.url.startsWith("/api/")) return;
    // Proteção contra formulários de outros sites: alterações exigem o cabeçalho do painel.
    if (req.method !== "GET" && req.headers["x-botly"] !== "1") return reply.code(403).send({ error: "Requisição recusada." });
    const path = req.url.split("?")[0]!;
    if (PUBLIC.has(path)) return;
    const u = await loadUser(req);
    if (!u) return reply.code(401).send({ error: "Entre de novo para continuar." });
    req.user = u;
  });
  const acc = (req: FastifyRequest) => req.user!.accountId;

  app.get("/api/setup", async () => {
    const [{ n }] = (await db.select({ n: count() }).from(s.users)) as [{ n: number }];
    return { needed: n === 0 };
  });

  app.post("/api/setup", async (req, reply) => {
    const [{ n }] = (await db.select({ n: count() }).from(s.users)) as [{ n: number }];
    if (n > 0) throw new HttpError(403, "O primeiro acesso já foi feito. Entre com seu e-mail e senha.");
    const b = z.object({ accountName: z.string().trim().min(2).max(80), name: z.string().trim().min(2).max(80), email: z.string().trim().email(), password: z.string() }).parse(req.body);
    const prob = passwordProblem(b.password);
    if (prob) throw new HttpError(400, prob);
    // Usa a conta criada pelo Console, se já existir.
    let account = (await db.select().from(s.accounts).orderBy(asc(s.accounts.createdAt)).limit(1))[0];
    if (!account) {
      const slug = b.accountName.toLowerCase().normalize("NFD").replace(/[^\w]+/g, "-").replace(/^-|-$/g, "") || "conta";
      [account] = await db.insert(s.accounts).values({ name: b.accountName, slug, platformFeeBps: 0, settings: { timezone: DEFAULT_TZ, ageGate: true, autoRemove: false } }).returning();
    }
    const [u] = await db.insert(s.users).values({ accountId: account!.id, email: b.email.toLowerCase(), name: b.name, passwordHash: await hashPassword(b.password), role: "owner" }).returning();
    await startSession(reply, u!.id);
    return { ok: true };
  });

  app.post("/api/login", async (req, reply) => {
    const b = z.object({ email: z.string().trim(), password: z.string() }).parse(req.body);
    const key = `${req.ip}|${b.email.toLowerCase()}`;
    if (limiter.blocked(key)) throw new HttpError(429, "Muitas tentativas. Espere 15 minutos e tente de novo.");
    const u = (await db.select().from(s.users).where(sql`lower(${s.users.email}) = ${b.email.toLowerCase()}`))[0];
    if (!u || !u.active || !(await verifyPassword(b.password, u.passwordHash))) {
      limiter.fail(key);
      throw new HttpError(401, "E-mail ou senha incorretos.");
    }
    limiter.reset(key);
    await startSession(reply, u.id);
    return { ok: true };
  });

  app.post("/api/logout", async (req, reply) => {
    const token = parseCookies(req.headers.cookie)[COOKIE];
    if (token) await db.delete(s.sessions).where(eq(s.sessions.tokenHash, tokenHash(token)));
    reply.header("Set-Cookie", cookie("", 0));
    return { ok: true };
  });

  app.get("/api/me", async (req) => {
    const a = (await db.select().from(s.accounts).where(eq(s.accounts.id, acc(req))))[0]!;
    return { user: req.user, account: { id: a.id, name: a.name } };
  });

  // ─── Início ───

  app.get("/api/overview", async (req) => {
    const id = acc(req);
    const a = (await db.select().from(s.accounts).where(eq(s.accounts.id, id)))[0]!;
    const today = startOfDay(ctx.now(), a.settings.timezone ?? DEFAULT_TZ);
    const [sales] = await db
      .select({ n: count(), total: sum(s.charges.amountCents) })
      .from(s.charges)
      .where(and(eq(s.charges.accountId, id), eq(s.charges.status, "paid"), gte(s.charges.paidAt, today)));
    const [active] = await db
      .select({ n: sql<number>`count(distinct ${s.accesses.customerId})::int` })
      .from(s.accesses)
      .where(and(eq(s.accesses.accountId, id), eq(s.accesses.status, "active"), or(isNull(s.accesses.expiresAt), gt(s.accesses.expiresAt, ctx.now()))));
    const bots = await db.select().from(s.bots).where(eq(s.bots.accountId, id));
    const chans = await db.select().from(s.channels).where(eq(s.channels.accountId, id));
    const gws = await db.select({ id: s.gateways.id }).from(s.gateways).where(and(eq(s.gateways.accountId, id), eq(s.gateways.active, true)));
    const plansN = bots.length ? ((await db.select({ n: count() }).from(s.plans).where(inArray(s.plans.botId, bots.map((b) => b.id))))[0]!.n as number) : 0;
    return {
      salesToday: { count: Number(sales?.n ?? 0), cents: Number(sales?.total ?? 0) },
      activeSubscribers: active?.n ?? 0,
      checklist: {
        gateway: gws.length > 0,
        bot: bots.length > 0,
        channel: chans.some((c) => c.rightsOk),
        mainChannel: bots.some((b) => b.mainChannelId),
        plans: plansN > 0,
        routing: bots.some((b) => b.routing.gatewayIds.length > 0),
      },
    };
  });

  app.get<{ Querystring: { range?: string; from?: string; to?: string } }>("/api/dashboard", async (req) => {
    const a = (await db.select().from(s.accounts).where(eq(s.accounts.id, acc(req))))[0]!;
    const keys: RangeKey[] = ["today", "yesterday", "7d", "week", "month", "30d", "all", "custom"];
    const key = (keys as string[]).includes(req.query.range ?? "") ? (req.query.range as RangeKey) : "7d";
    return dashboard(db, a.id, ctx.now(), a.settings.timezone ?? DEFAULT_TZ, key, { from: req.query.from, to: req.query.to });
  });

  // ─── Bots ───

  app.get("/api/bots", async (req) => {
    const rows = await db.select().from(s.bots).where(eq(s.bots.accountId, acc(req))).orderBy(asc(s.bots.createdAt));
    const chans = await db.select({ id: s.channels.id, title: s.channels.title }).from(s.channels).where(eq(s.channels.accountId, acc(req)));
    const plans = rows.length ? await db.select({ botId: s.plans.botId, n: count() }).from(s.plans).where(inArray(s.plans.botId, rows.map((r) => r.id))).groupBy(s.plans.botId) : [];
    const subs = rows.length
      ? await db
          .select({ botId: s.accesses.billingBotId, n: sql<number>`count(distinct ${s.accesses.customerId})::int` })
          .from(s.accesses)
          .where(and(inArray(s.accesses.billingBotId, rows.map((r) => r.id)), eq(s.accesses.status, "active"), or(isNull(s.accesses.expiresAt), gt(s.accesses.expiresAt, ctx.now()))))
          .groupBy(s.accesses.billingBotId)
      : [];
    return rows.map((b) => ({
      id: b.id,
      username: b.username,
      name: b.name,
      status: b.status,
      statusDetail: b.statusDetail,
      mainChannel: chans.find((c) => c.id === b.mainChannelId)?.title ?? null,
      plans: Number(plans.find((p) => p.botId === b.id)?.n ?? 0),
      subscribers: subs.find((x) => x.botId === b.id)?.n ?? 0,
      hasPayment: b.routing.gatewayIds.length > 0,
    }));
  });

  app.post("/api/bots", async (req) => {
    const b = z.object({ token: z.string() }).parse(req.body);
    const row = await registerBot(ctx, acc(req), b.token, { transformer: opts.transformer });
    return { id: row.id, username: row.username };
  });

  async function ownBot(req: FastifyRequest, id: string) {
    const row = (await db.select().from(s.bots).where(and(eq(s.bots.id, id), eq(s.bots.accountId, acc(req)))))[0];
    if (!row) throw notFound("Bot");
    return row;
  }

  app.get<{ Params: { id: string } }>("/api/bots/:id", async (req) => {
    const b = await ownBot(req, req.params.id);
    const plans = await db.select().from(s.plans).where(eq(s.plans.botId, b.id)).orderBy(asc(s.plans.sortOrder), asc(s.plans.priceCents));
    const { tokenEnc: _t, webhookSecret: _w, ...safe } = b;
    return { bot: safe, plans };
  });

  const botPatch = z.object({
    welcome: z
      .object({
        text: z.string().max(1024),
        media: z.object({ type: z.enum(["photo", "video", "animation"]), url: z.string().url().nullable().optional(), mediaId: z.string().uuid().nullable().optional(), fileId: z.string().nullable().optional() }).nullable().optional(),
      })
      .optional(),
    previewUrl: z.string().url().nullable().or(z.literal("")).optional(),
    previewButton: z.string().max(40).nullable().optional(),
    mainChannelId: z.string().uuid().nullable().optional(),
    routing: z.object({ mode: z.enum(["fixed", "alternar", "equilibrar", "limite"]), gatewayIds: z.array(z.string().uuid()), dailyLimitCents: z.record(z.string(), cents).optional() }).optional(),
    upsell: z
      .object({
        orderBump: z.object({ enabled: z.boolean(), channelIds: z.array(z.string().uuid()), priceOverrides: z.record(z.string(), cents).optional() }).optional(),
        postSale: z.object({ enabled: z.boolean(), discountPct: z.number().int().min(0).max(90), validMinutes: z.number().int().min(1).max(1440) }).optional(),
        renewal: z.object({ enabled: z.boolean(), extraChannelId: z.string().uuid().nullable().optional(), longPlanId: z.string().uuid().nullable().optional(), longPlanDiscountPct: z.number().int().min(0).max(90).optional() }).optional(),
      })
      .optional(),
    showBundles: z.boolean().optional(),
    status: z.enum(["active", "paused"]).optional(),
  });

  app.put<{ Params: { id: string } }>("/api/bots/:id", async (req) => {
    const bot = await ownBot(req, req.params.id);
    const p = botPatch.parse(req.body);
    if (p.mainChannelId) {
      const ch = (await db.select().from(s.channels).where(and(eq(s.channels.id, p.mainChannelId), eq(s.channels.accountId, bot.accountId))))[0];
      if (!ch) throw notFound("Canal");
    }
    if (p.routing?.gatewayIds.length) {
      const ok = await db.select({ id: s.gateways.id }).from(s.gateways).where(and(eq(s.gateways.accountId, bot.accountId), inArray(s.gateways.id, p.routing.gatewayIds)));
      if (ok.length !== p.routing.gatewayIds.length) throw notFound("Forma de pagamento");
    }
    if (p.welcome?.media?.mediaId) {
      const m = (await db.select({ id: s.media.id, kind: s.media.kind }).from(s.media).where(and(eq(s.media.id, p.welcome.media.mediaId), eq(s.media.accountId, bot.accountId))))[0];
      if (!m) throw notFound("Arquivo");
      p.welcome.media.type = m.kind;
    }
    const prevMedia = bot.welcome.media;
    const sameMedia = (x: typeof p.welcome extends undefined ? never : NonNullable<NonNullable<typeof p.welcome>["media"]>) =>
      !!prevMedia && (x.mediaId ? x.mediaId === prevMedia.mediaId : !!x.url && x.url === prevMedia.url);
    const welcome = p.welcome
      ? {
          text: p.welcome.text,
          media: p.welcome.media && (p.welcome.media.mediaId || p.welcome.media.url)
            ? {
                type: p.welcome.media.type,
                url: p.welcome.media.mediaId ? null : (p.welcome.media.url ?? null),
                mediaId: p.welcome.media.mediaId ?? null,
                // Mesmo arquivo de antes: reaproveita o file_id do Telegram.
                fileId: sameMedia(p.welcome.media) ? (prevMedia?.fileId ?? null) : null,
              }
            : null,
        }
      : undefined;
    const [row] = await db
      .update(s.bots)
      .set({
        ...(welcome ? { welcome } : {}),
        ...(p.previewUrl !== undefined ? { previewUrl: p.previewUrl || null } : {}),
        ...(p.previewButton !== undefined ? { previewButton: p.previewButton || null } : {}),
        ...(p.mainChannelId !== undefined ? { mainChannelId: p.mainChannelId } : {}),
        ...(p.routing ? { routing: p.routing } : {}),
        ...(p.upsell ? { upsell: { ...bot.upsell, ...p.upsell } } : {}),
        ...(p.showBundles !== undefined ? { showBundles: p.showBundles } : {}),
        ...(p.status ? { status: p.status } : {}),
        updatedAt: ctx.now(),
      })
      .where(eq(s.bots.id, bot.id))
      .returning();
    const { tokenEnc: _t, webhookSecret: _w, ...safe } = row!;
    return safe;
  });

  app.post<{ Params: { id: string } }>("/api/bots/:id/reconnect", async (req) => {
    const bot = await ownBot(req, req.params.id);
    const api = tgApi(bot);
    try {
      await api.setWebhook(`${ctx.publicUrl.replace(/\/+$/, "")}/tg/${bot.id}`, { secret_token: bot.webhookSecret, allowed_updates: [...ALLOWED_UPDATES] });
    } catch (err) {
      await db.update(s.bots).set({ status: "error", statusDetail: "O Telegram recusou o token. Gere um novo no @BotFather e cadastre de novo." }).where(eq(s.bots.id, bot.id));
      throw new HttpError(400, "O Telegram recusou o token deste bot. Gere um novo no @BotFather (/revoke) e cadastre de novo.");
    }
    await db.update(s.bots).set({ status: bot.status === "error" ? "active" : bot.status, statusDetail: null }).where(eq(s.bots.id, bot.id));
    return { ok: true };
  });

  app.delete<{ Params: { id: string } }>("/api/bots/:id", async (req) => {
    const bot = await ownBot(req, req.params.id);
    await tgApi(bot).deleteWebhook().catch(() => {});
    await db.delete(s.bots).where(eq(s.bots.id, bot.id));
    return { ok: true };
  });

  // ─── Mídias (upload pelo painel) ───
  // Limites do Telegram para bots: foto até 10 MB; vídeo e GIF até 50 MB.
  const MEDIA_RULES: Record<string, { kind: "photo" | "video" | "animation"; max: number }> = {
    "image/jpeg": { kind: "photo", max: 10 * 1024 * 1024 },
    "image/png": { kind: "photo", max: 10 * 1024 * 1024 },
    "image/webp": { kind: "photo", max: 10 * 1024 * 1024 },
    "image/gif": { kind: "animation", max: 50 * 1024 * 1024 },
    "video/mp4": { kind: "video", max: 50 * 1024 * 1024 },
    "video/quicktime": { kind: "video", max: 50 * 1024 * 1024 },
  };

  app.post<{ Querystring: { name?: string; mime?: string } }>("/api/media", { bodyLimit: 52 * 1024 * 1024 }, async (req) => {
    const data = req.body as Buffer;
    if (!Buffer.isBuffer(data) || !data.length) throw new HttpError(400, "Arquivo vazio.");
    const mime = String(req.query.mime ?? "").toLowerCase();
    const rule = MEDIA_RULES[mime];
    if (!rule) throw new HttpError(400, "Formato não aceito. Use foto (JPG, PNG, WEBP), vídeo (MP4, MOV) ou GIF.");
    if (data.length > rule.max) throw new HttpError(400, `Arquivo grande demais: o Telegram aceita até ${rule.max / 1024 / 1024} MB para ${rule.kind === "photo" ? "fotos" : "vídeos e GIFs"}.`);
    const name = String(req.query.name ?? "arquivo").replace(/[^\w.\- ]+/g, "_").slice(0, 80) || "arquivo";
    const [row] = await db.insert(s.media).values({ accountId: acc(req), kind: rule.kind, mime, fileName: name, size: data.length, data }).returning({ id: s.media.id, kind: s.media.kind });
    return { id: row!.id, kind: row!.kind, size: data.length, name };
  });

  app.get<{ Params: { id: string } }>("/api/media/:id", async (req, reply) => {
    const m = (await db.select().from(s.media).where(and(eq(s.media.id, req.params.id), eq(s.media.accountId, acc(req)))).catch(() => []))[0];
    if (!m) throw notFound("Arquivo");
    reply.header("Cache-Control", "private, max-age=86400");
    return reply.type(m.mime).send(m.data);
  });

  // ─── Planos ───

  const planBody = z.object({ name: z.string().trim().min(1).max(60), durationUnit: unit, durationValue: z.number().int().min(1).max(3650), priceCents: cents.min(100), highlight: z.boolean().optional(), active: z.boolean().optional() });

  app.post<{ Params: { id: string } }>("/api/bots/:id/plans", async (req) => {
    const bot = await ownBot(req, req.params.id);
    const p = planBody.parse(req.body);
    const n = (await db.select({ n: count() }).from(s.plans).where(eq(s.plans.botId, bot.id)))[0]!.n as number;
    const [row] = await db.insert(s.plans).values({ ...p, accountId: bot.accountId, botId: bot.id, sortOrder: n }).returning();
    return row;
  });

  app.put<{ Params: { id: string } }>("/api/plans/:id", async (req) => {
    const p = planBody.partial().extend({ sortOrder: z.number().int().optional() }).parse(req.body);
    const [row] = await db.update(s.plans).set(p).where(and(eq(s.plans.id, req.params.id), eq(s.plans.accountId, acc(req)))).returning();
    if (!row) throw notFound("Plano");
    return row;
  });

  app.delete<{ Params: { id: string } }>("/api/plans/:id", async (req) => {
    await db.delete(s.plans).where(and(eq(s.plans.id, req.params.id), eq(s.plans.accountId, acc(req))));
    return { ok: true };
  });

  // ─── Canais ───

  app.get("/api/channels", async (req) => {
    const rows = await db.select().from(s.channels).where(eq(s.channels.accountId, acc(req))).orderBy(asc(s.channels.title));
    const bots = await db.select({ id: s.bots.id, username: s.bots.username, mainChannelId: s.bots.mainChannelId }).from(s.bots).where(eq(s.bots.accountId, acc(req)));
    const subs = rows.length
      ? await db
          .select({ channelId: s.accesses.channelId, n: count() })
          .from(s.accesses)
          .where(and(inArray(s.accesses.channelId, rows.map((r) => r.id)), eq(s.accesses.status, "active"), or(isNull(s.accesses.expiresAt), gt(s.accesses.expiresAt, ctx.now()))))
          .groupBy(s.accesses.channelId)
      : [];
    return rows.map((c) => ({
      id: c.id,
      title: c.title,
      displayName: c.displayName,
      type: c.type,
      telegramChatId: c.telegramChatId,
      inviteLink: c.inviteLink,
      rightsOk: c.rightsOk,
      rightsCheckedAt: c.rightsCheckedAt,
      extraPriceCents: c.extraPriceCents,
      active: c.active,
      managerBot: bots.find((b) => b.id === c.managerBotId) ?? null,
      sellingBots: bots.filter((b) => b.mainChannelId === c.id).map((b) => b.username),
      subscribers: Number(subs.find((x) => x.channelId === c.id)?.n ?? 0),
    }));
  });

  async function ownChannel(req: FastifyRequest, id: string) {
    const row = (await db.select().from(s.channels).where(and(eq(s.channels.id, id), eq(s.channels.accountId, acc(req)))))[0];
    if (!row) throw notFound("Canal");
    return row;
  }

  /** Cadastro manual (quando o canal não apareceu sozinho). */
  app.post("/api/channels", async (req) => {
    const b = z.object({ botId: z.string().uuid(), chat: z.string().trim().min(2) }).parse(req.body);
    const bot = await ownBot(req, b.botId);
    const ref = /^-?\d+$/.test(b.chat) ? Number(b.chat) : b.chat.startsWith("@") ? b.chat : `@${b.chat}`;
    try {
      const r = await registerChannel(ctx, bot, tgApi(bot), ref);
      return { id: r.channel.id, rights: r.rights };
    } catch (err) {
      if (err instanceof SetupError) throw err;
      throw new HttpError(400, "Não encontrei esse canal. Confira se o bot já é administrador dele e se o ID está certo.");
    }
  });

  app.post<{ Params: { id: string } }>("/api/channels/:id/check", async (req) => {
    const ch = await ownChannel(req, req.params.id);
    if (!ch.managerBotId) throw new HttpError(400, "Escolha o bot gestor deste canal antes.");
    const bot = await ownBot(req, ch.managerBotId);
    try {
      const r = await registerChannel(ctx, bot, tgApi(bot), ch.telegramChatId);
      return { rights: r.rights };
    } catch {
      await db.update(s.channels).set({ rightsOk: false, rightsCheckedAt: ctx.now() }).where(eq(s.channels.id, ch.id));
      return { rights: { ok: false, missing: ["ser administrador do canal"] } };
    }
  });

  app.put<{ Params: { id: string } }>("/api/channels/:id", async (req) => {
    const ch = await ownChannel(req, req.params.id);
    const p = z
      .object({ extraPriceCents: cents.nullable().optional(), managerBotId: z.string().uuid().optional(), active: z.boolean().optional(), displayName: z.string().trim().max(80).nullable().optional() })
      .parse(req.body);
    if (p.managerBotId && p.managerBotId !== ch.managerBotId) {
      const bot = await ownBot(req, p.managerBotId);
      const rights = await checkRights(tgApi(bot), ch.telegramChatId, bot.telegramBotId, ch.type === "channel").catch(() => ({ ok: false, missing: ["ser administrador do canal"] }));
      if (!rights.ok) throw new HttpError(400, `O @${bot.username} precisa ${rights.missing.join(" e ")} antes de virar gestor.`);
      // O novo gestor cria o próprio link com aprovação.
      await db.update(s.channels).set({ managerBotId: bot.id }).where(eq(s.channels.id, ch.id));
      await registerChannel(ctx, { ...bot }, tgApi(bot), ch.telegramChatId);
    }
    const [row] = await db
      .update(s.channels)
      .set({
        ...(p.extraPriceCents !== undefined ? { extraPriceCents: p.extraPriceCents } : {}),
        ...(p.active !== undefined ? { active: p.active } : {}),
        ...(p.displayName !== undefined ? { displayName: p.displayName || null } : {}),
      })
      .where(eq(s.channels.id, ch.id))
      .returning();
    return row;
  });

  /**
   * Remove o canal do Botly (o canal no Telegram não é apagado). Com assinantes, só
   * com confirmação explícita (?confirmar=1): os acessos e lembretes dele somem junto.
   */
  app.delete<{ Params: { id: string }; Querystring: { confirmar?: string } }>("/api/channels/:id", async (req) => {
    const ch = await ownChannel(req, req.params.id);
    const [{ n }] = (await db
      .select({ n: count() })
      .from(s.accesses)
      .where(and(eq(s.accesses.channelId, ch.id), eq(s.accesses.status, "active"), or(isNull(s.accesses.expiresAt), gt(s.accesses.expiresAt, ctx.now()))))) as [{ n: number }];
    if (n > 0 && req.query.confirmar !== "1") throw new HttpError(409, `Este canal tem ${n} assinantes ativos.`);
    // Bots que vendiam este canal ficam sem canal principal.
    await db.update(s.bots).set({ mainChannelId: null }).where(eq(s.bots.mainChannelId, ch.id));
    await db.delete(s.channels).where(eq(s.channels.id, ch.id));
    await db.insert(s.auditLog).values({ accountId: ch.accountId, userId: req.user!.id, action: "canal_removido", meta: { title: ch.title, telegramChatId: ch.telegramChatId, activeSubscribers: n } });
    return { ok: true };
  });

  // ─── Pacotes ───

  const bundleBody = z.object({
    name: z.string().trim().min(1).max(60),
    description: z.string().max(200).nullable().optional(),
    durationUnit: unit,
    durationValue: z.number().int().min(1).max(3650),
    priceCents: cents.min(100),
    active: z.boolean().optional(),
    channelIds: z.array(z.string().uuid()).min(2, "Um pacote precisa de pelo menos 2 canais."),
  });

  app.get("/api/bundles", async (req) => {
    const rows = await db.select().from(s.bundles).where(eq(s.bundles.accountId, acc(req))).orderBy(asc(s.bundles.sortOrder), asc(s.bundles.priceCents));
    const links = rows.length ? await db.select().from(s.bundleChannels).where(inArray(s.bundleChannels.bundleId, rows.map((r) => r.id))) : [];
    return rows.map((b) => ({ ...b, channelIds: links.filter((l) => l.bundleId === b.id).map((l) => l.channelId) }));
  });

  async function saveBundleChannels(req: FastifyRequest, bundleId: string, ids: string[]) {
    const ok = await db.select({ id: s.channels.id }).from(s.channels).where(and(eq(s.channels.accountId, acc(req)), inArray(s.channels.id, ids)));
    if (ok.length !== new Set(ids).size) throw notFound("Canal");
    await db.delete(s.bundleChannels).where(eq(s.bundleChannels.bundleId, bundleId));
    await db.insert(s.bundleChannels).values([...new Set(ids)].map((channelId) => ({ bundleId, channelId })));
  }

  app.post("/api/bundles", async (req) => {
    const { channelIds, ...p } = bundleBody.parse(req.body);
    const n = (await db.select({ n: count() }).from(s.bundles).where(eq(s.bundles.accountId, acc(req))))[0]!.n as number;
    const [row] = await db.insert(s.bundles).values({ ...p, accountId: acc(req), sortOrder: n }).returning();
    await saveBundleChannels(req, row!.id, channelIds);
    return row;
  });

  app.put<{ Params: { id: string } }>("/api/bundles/:id", async (req) => {
    const { channelIds, ...p } = bundleBody.partial().parse(req.body);
    const [row] = await db.update(s.bundles).set(p).where(and(eq(s.bundles.id, req.params.id), eq(s.bundles.accountId, acc(req)))).returning();
    if (!row) throw notFound("Pacote");
    if (channelIds) await saveBundleChannels(req, row.id, channelIds);
    return row;
  });

  app.delete<{ Params: { id: string } }>("/api/bundles/:id", async (req) => {
    await db.delete(s.bundles).where(and(eq(s.bundles.id, req.params.id), eq(s.bundles.accountId, acc(req))));
    return { ok: true };
  });

  // ─── Formas de pagamento ───

  app.get("/api/gateways", async (req) => {
    const rows = await db.select().from(s.gateways).where(eq(s.gateways.accountId, acc(req))).orderBy(asc(s.gateways.createdAt));
    const a = (await db.select().from(s.accounts).where(eq(s.accounts.id, acc(req))))[0]!;
    const today = startOfDay(ctx.now(), a.settings.timezone ?? DEFAULT_TZ);
    const stats = rows.length
      ? await db
          .select({ id: s.charges.gatewayId, paid: sum(s.charges.amountCents), n: count() })
          .from(s.charges)
          .where(and(inArray(s.charges.gatewayId, rows.map((r) => r.id)), eq(s.charges.status, "paid"), gte(s.charges.paidAt, today)))
          .groupBy(s.charges.gatewayId)
      : [];
    const bots = await db.select({ username: s.bots.username, routing: s.bots.routing }).from(s.bots).where(eq(s.bots.accountId, acc(req)));
    return rows.map((g) => ({
      id: g.id,
      provider: g.provider,
      label: g.label,
      active: g.active,
      sandbox: !!g.config.sandbox,
      todayCents: Number(stats.find((x) => x.id === g.id)?.paid ?? 0),
      todayCount: Number(stats.find((x) => x.id === g.id)?.n ?? 0),
      bots: bots.filter((b) => b.routing.gatewayIds.includes(g.id)).map((b) => b.username),
    }));
  });

  app.post("/api/gateways", async (req) => {
    const b = z.object({ provider: z.enum(["pushinpay", "paggone"]), label: z.string().trim().min(1).max(40), key: z.string().trim().min(8), sandbox: z.boolean().optional() }).parse(req.body);
    const secret = encryptJson(b.provider === "pushinpay" ? { token: b.key } : { apiKey: b.key }, ctx.appSecret);
    const [row] = await db
      .insert(s.gateways)
      .values({ accountId: acc(req), provider: b.provider, label: b.label, secret, config: { sandbox: !!b.sandbox }, webhookToken: randomBytes(16).toString("hex") })
      .returning({ id: s.gateways.id });
    return row;
  });

  app.put<{ Params: { id: string } }>("/api/gateways/:id", async (req) => {
    const b = z.object({ label: z.string().trim().min(1).max(40).optional(), key: z.string().trim().min(8).optional(), active: z.boolean().optional(), sandbox: z.boolean().optional() }).parse(req.body);
    const g = (await db.select().from(s.gateways).where(and(eq(s.gateways.id, req.params.id), eq(s.gateways.accountId, acc(req)))))[0];
    if (!g) throw notFound("Forma de pagamento");
    await db
      .update(s.gateways)
      .set({
        ...(b.label ? { label: b.label } : {}),
        ...(b.active !== undefined ? { active: b.active } : {}),
        ...(b.sandbox !== undefined ? { config: { ...g.config, sandbox: b.sandbox } } : {}),
        ...(b.key ? { secret: encryptJson(g.provider === "pushinpay" ? { token: b.key } : { apiKey: b.key }, ctx.appSecret) } : {}),
      })
      .where(eq(s.gateways.id, g.id));
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>("/api/gateways/:id/test", async (req) => {
    const g = (await db.select().from(s.gateways).where(and(eq(s.gateways.id, req.params.id), eq(s.gateways.accountId, acc(req)))))[0];
    if (!g) throw notFound("Forma de pagamento");
    try {
      await gatewayClient(g, ctx.appSecret, ctx.fetch).status("teste-conexao-botly");
      return { ok: true };
    } catch (err) {
      const st = (err as { status?: number }).status;
      // 404/422 = a chave foi aceita (só a cobrança de teste não existe).
      if (st === 404 || st === 422 || st === 400) return { ok: true };
      return { ok: false, error: st === 401 || st === 403 ? "A chave foi recusada. Confira se copiou o token inteiro." : `Sem resposta do gateway (${(err as Error).message}).` };
    }
  });

  app.delete<{ Params: { id: string } }>("/api/gateways/:id", async (req) => {
    const id = req.params.id;
    const bots = await db.select().from(s.bots).where(eq(s.bots.accountId, acc(req)));
    for (const b of bots)
      if (b.routing.gatewayIds.includes(id)) await db.update(s.bots).set({ routing: { ...b.routing, gatewayIds: b.routing.gatewayIds.filter((x) => x !== id) } }).where(eq(s.bots.id, b.id));
    await db.delete(s.gateways).where(and(eq(s.gateways.id, id), eq(s.gateways.accountId, acc(req))));
    return { ok: true };
  });

  // ─── Retenção e lembretes ───

  app.get<{ Querystring: { range?: string } }>("/api/retention", async (req) => {
    const id = acc(req);
    const a = (await db.select().from(s.accounts).where(eq(s.accounts.id, id)))[0]!;
    const tz = a.settings.timezone ?? DEFAULT_TZ;
    const today = startOfDay(ctx.now(), tz);
    const day = 86_400_000;
    const range = req.query.range === "tomorrow" ? [1, 2] : req.query.range === "week" ? [0, 8] : [0, 1];
    // Começo/fim de dia somando 26 h e recortando no dia certo (horário de verão não quebra).
    const from = range[0] ? startOfDay(new Date(today.getTime() + range[0] * day + 2 * 3600_000), tz) : today;
    const to = startOfDay(new Date(today.getTime() + range[1]! * day + 2 * 3600_000), tz);
    const rows = await retentionWindow(ctx, id, from, to);
    const items = rows.map((r) => ({
      id: r.o.id,
      when: r.o.scheduledFor,
      kind: r.kind,
      days: r.offset != null ? Math.round(r.offset / 1440) : null,
      discountPct: r.discountPct ?? 0,
      status: r.o.status,
      outcome: r.o.outcome,
      error: r.o.error,
      expectedCents: r.o.expectedCents,
      customer: { tg: r.customer.tg, name: r.customer.username ? "@" + r.customer.username : (r.customer.firstName ?? String(r.customer.tg)) },
      channel: r.channel,
      expiresAt: r.expiresAt,
      bot: r.bot,
    }));
    const rem = items.filter((i) => i.kind === "reminder");
    const renewed = items.filter((i) => i.outcome === "renewed" || i.outcome === "renewed_upsell");
    const removals = await pendingRemovals(ctx, id);
    return {
      items,
      totals: {
        expectedCents: rem.filter((i) => i.status !== "skipped" || i.outcome).reduce((x, i) => x + i.expectedCents, 0),
        customers: new Set(rem.map((i) => i.customer.tg)).size,
        sent: items.filter((i) => i.status === "sent").length,
        scheduled: items.filter((i) => i.status === "scheduled").length,
        renewed: renewed.length,
        upsell: items.filter((i) => i.outcome === "renewed_upsell").length,
      },
      autoRemove: !!a.settings.autoRemove,
      removals: removals.map((r) => ({ id: r.id, expiresAt: r.expiresAt, channel: r.channel, name: r.username ? "@" + r.username : (r.firstName ?? String(r.tg)) })),
    };
  });

  /** Manda de novo uma mensagem que falhou (volta para a fila). */
  app.post<{ Params: { id: string } }>("/api/retention/:id/retry", async (req) => {
    const [row] = await db
      .update(s.outbox)
      .set({ status: "scheduled", error: null, scheduledFor: ctx.now() })
      .where(and(eq(s.outbox.id, req.params.id), eq(s.outbox.accountId, acc(req)), eq(s.outbox.status, "failed")))
      .returning();
    if (!row) throw notFound("Mensagem com falha");
    return { ok: true };
  });

  app.post("/api/retention/refresh", async (req) => {
    await planOutbox(ctx, acc(req));
    return { ok: true };
  });

  app.get("/api/templates", async (req) => {
    const rows = await ensureTemplates(ctx, acc(req));
    const a = (await db.select().from(s.accounts).where(eq(s.accounts.id, acc(req))))[0]!;
    return {
      reminderTime: a.settings.reminderTime ?? "10:00",
      removeGraceHours: a.settings.removeGraceHours ?? 0,
      autoRemove: !!a.settings.autoRemove,
      templates: rows
        .filter((r) => !r.botId)
        .map((r) => ({ id: r.id, kind: r.kind, days: Math.round(r.offsetMinutes / 1440), text: r.text, discountPct: r.discountPct, enabled: r.enabled, mediaUrl: r.media?.url ?? null }))
        .sort((x, y) => x.days - y.days),
    };
  });

  const tplBody = z.object({
    kind: z.enum(["reminder", "winback"]),
    days: z.number().int().min(-30).max(60),
    text: z.string().trim().min(1).max(1024),
    discountPct: z.number().int().min(0).max(90).optional(),
    enabled: z.boolean().optional(),
    mediaUrl: z.string().url().nullable().or(z.literal("")).optional(),
  });
  function tplValues(p: Partial<z.infer<typeof tplBody>>) {
    if (p.kind === "reminder" && p.days !== undefined && p.days > 0) throw new HttpError(400, "Lembrete é antes ou no dia do vencimento (0 ou menos).");
    if (p.kind === "winback" && p.days !== undefined && p.days < 1) throw new HttpError(400, "A mensagem de “volte” sai pelo menos 1 dia depois do vencimento.");
    return {
      ...(p.kind ? { kind: p.kind } : {}),
      ...(p.days !== undefined ? { offsetMinutes: p.days * 1440 } : {}),
      ...(p.text ? { text: p.text } : {}),
      ...(p.discountPct !== undefined ? { discountPct: p.discountPct } : {}),
      ...(p.enabled !== undefined ? { enabled: p.enabled } : {}),
      ...(p.mediaUrl !== undefined ? { media: p.mediaUrl ? { type: /\.(mp4|mov|webm)(\?|$)/i.test(p.mediaUrl) ? ("video" as const) : ("photo" as const), url: p.mediaUrl } : null } : {}),
    };
  }
  /** Mudou o modelo: refaz a fila ainda não enviada dele. */
  async function replan(templateId: string, accountId: string) {
    await db.delete(s.outbox).where(and(eq(s.outbox.templateId, templateId), eq(s.outbox.status, "scheduled")));
    await planOutbox(ctx, accountId);
  }

  app.post("/api/templates", async (req) => {
    const p = tplBody.parse(req.body);
    const [row] = await db.insert(s.templates).values({ accountId: acc(req), offsetMinutes: 0, text: p.text, kind: p.kind, ...tplValues(p) }).returning();
    await planOutbox(ctx, acc(req));
    return row;
  });

  app.put<{ Params: { id: string } }>("/api/templates/:id", async (req) => {
    const cur = (await db.select().from(s.templates).where(and(eq(s.templates.id, req.params.id), eq(s.templates.accountId, acc(req)))))[0];
    if (!cur) throw notFound("Mensagem");
    const p = tplBody.partial().parse(req.body);
    await db.update(s.templates).set(tplValues({ kind: cur.kind as "reminder", ...p })).where(eq(s.templates.id, cur.id));
    await replan(cur.id, acc(req));
    return { ok: true };
  });

  app.delete<{ Params: { id: string } }>("/api/templates/:id", async (req) => {
    const cur = (await db.select().from(s.templates).where(and(eq(s.templates.id, req.params.id), eq(s.templates.accountId, acc(req)))))[0];
    if (!cur) throw notFound("Mensagem");
    await db.delete(s.outbox).where(and(eq(s.outbox.templateId, cur.id), eq(s.outbox.status, "scheduled")));
    await db.delete(s.templates).where(eq(s.templates.id, cur.id));
    return { ok: true };
  });

  app.put("/api/reminder-settings", async (req) => {
    const p = z
      .object({ reminderTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional(), removeGraceHours: z.number().int().min(0).max(168).optional(), autoRemove: z.boolean().optional() })
      .parse(req.body);
    const a = (await db.select().from(s.accounts).where(eq(s.accounts.id, acc(req))))[0]!;
    await db.update(s.accounts).set({ settings: { ...a.settings, ...p }, updatedAt: ctx.now() }).where(eq(s.accounts.id, a.id));
    if (p.reminderTime && p.reminderTime !== a.settings.reminderTime) {
      // Horário mudou: refaz tudo o que ainda não saiu.
      await db.delete(s.outbox).where(and(eq(s.outbox.accountId, a.id), eq(s.outbox.status, "scheduled")));
      await planOutbox(ctx, a.id);
    }
    return { ok: true };
  });

  // ─── Importação de assinantes ───

  const importBody = z.object({
    botId: z.string().uuid(),
    channelId: z.string().uuid(),
    fileName: z.string().min(1).max(200),
    data: z.string().min(10), // arquivo em base64
    planMap: z.record(z.string(), z.string().uuid().nullable()).optional(),
    onlyActive: z.boolean().optional(),
  });
  async function readImport(req: FastifyRequest) {
    const b = importBody.parse(req.body);
    const bot = await ownBot(req, b.botId);
    const channel = await ownChannel(req, b.channelId);
    const a = (await db.select().from(s.accounts).where(eq(s.accounts.id, acc(req))))[0]!;
    const tz = a.settings.timezone ?? DEFAULT_TZ;
    let parsed;
    try {
      parsed = await readSheet(Buffer.from(b.data, "base64"), b.fileName, tz);
    } catch (err) {
      throw new HttpError(400, err instanceof Error && /coluna|planilha/i.test(err.message) ? err.message : "Não consegui ler o arquivo. Envie a planilha .xlsx exportada (ou um .csv).");
    }
    const analysis = analyze(parsed.rows, ctx.now());
    analysis.columns = parsed.columns;
    return { b, bot, channel, analysis };
  }

  app.post("/api/import/preview", { bodyLimit: 20 * 1024 * 1024 }, async (req) => {
    const { bot, channel, analysis } = await readImport(req);
    const plans = await db.select().from(s.plans).where(eq(s.plans.botId, bot.id)).orderBy(asc(s.plans.sortOrder));
    const existing = analysis.customers.length
      ? (
          await db
            .select({ n: count() })
            .from(s.accesses)
            .innerJoin(s.customers, eq(s.customers.id, s.accesses.customerId))
            .where(and(eq(s.accesses.channelId, channel.id), inArray(s.customers.telegramUserId, analysis.customers.slice(0, 5000).map((c) => c.telegramId))))
        )[0]!.n
      : 0;
    return {
      columns: analysis.columns,
      lines: analysis.lines,
      customers: analysis.customers.length,
      active: analysis.active,
      expired: analysis.expired,
      alreadyInBotly: Number(existing),
      invalid: analysis.invalid.slice(0, 20),
      invalidCount: analysis.invalid.length,
      unpaid: analysis.unpaid,
      groups: analysis.groups,
      suggested: suggestPlans(analysis.groups, plans),
      plans: plans.map((p) => ({ id: p.id, name: p.name, priceCents: p.priceCents })),
      sample: analysis.customers
        .filter((c) => c.expiresAt > ctx.now())
        .sort((x, y) => x.expiresAt.getTime() - y.expiresAt.getTime())
        .slice(0, 8)
        .map((c) => ({ telegramId: c.telegramId, username: c.username, expiresAt: c.expiresAt, amountCents: c.amountCents, purchases: c.purchases })),
    };
  });

  app.post("/api/import/confirm", { bodyLimit: 20 * 1024 * 1024 }, async (req) => {
    const { b, bot, channel, analysis } = await readImport(req);
    if (b.onlyActive) {
      // Só os ativos: vencidos ficam de fora (não viram clientes no Botly).
      const now = ctx.now();
      analysis.customers = analysis.customers.filter((c) => c.expiresAt > now);
      analysis.expired = 0;
    }
    if (!analysis.customers.length) throw new HttpError(400, "Nenhum cliente válido para importar.");
    const r = await applyImport(ctx, { accountId: acc(req), botId: bot.id, channelId: channel.id, analysis, planMap: b.planMap ?? {}, fileName: b.fileName, userId: req.user!.id });
    // Já monta os lembretes dos importados.
    await planOutbox(ctx, acc(req));
    return r;
  });

  app.get("/api/imports", async (req) => {
    const rows = await db.select().from(s.imports).where(eq(s.imports.accountId, acc(req))).orderBy(desc(s.imports.createdAt)).limit(30);
    const bots = await db.select({ id: s.bots.id, username: s.bots.username }).from(s.bots).where(eq(s.bots.accountId, acc(req)));
    const chans = await db.select({ id: s.channels.id, title: s.channels.title }).from(s.channels).where(eq(s.channels.accountId, acc(req)));
    return rows.map((r) => ({ id: r.id, fileName: r.fileName, createdAt: r.createdAt, stats: r.stats, bot: bots.find((x) => x.id === r.botId)?.username ?? null, channel: chans.find((x) => x.id === r.channelId)?.title ?? null }));
  });

  // ─── Configurações da conta ───

  app.get("/api/settings", async (req) => {
    const a = (await db.select().from(s.accounts).where(eq(s.accounts.id, acc(req))))[0]!;
    return { name: a.name, ...a.settings };
  });

  app.put("/api/settings", async (req) => {
    const p = z
      .object({
        name: z.string().trim().min(2).max(80).optional(),
        ageGate: z.boolean().optional(),
        notifyChatId: z.number().int().nullable().optional(),
        notifyBotId: z.string().uuid().nullable().optional(),
        offerCooldownDays: z.number().int().min(0).max(365).optional(),
      })
      .parse(req.body);
    const a = (await db.select().from(s.accounts).where(eq(s.accounts.id, acc(req))))[0]!;
    const { name, ...settings } = p;
    await db.update(s.accounts).set({ ...(name ? { name } : {}), settings: { ...a.settings, ...settings }, updatedAt: ctx.now() }).where(eq(s.accounts.id, a.id));
    return { ok: true };
  });

  // ─── Telas ───

  app.get("/*", async (req, reply) => {
    const path = normalize(decodeURIComponent(req.url.split("?")[0]!)).replace(/^(\.\.[/\\])+/, "");
    if (path.startsWith("/api/")) return reply.code(404).send({ error: "Não encontrado." });
    const file = join(webDir, path);
    if (file.startsWith(webDir)) {
      const st = await stat(file).catch(() => null);
      if (st?.isFile()) {
        if (path.startsWith("/assets/")) reply.header("Cache-Control", "public, max-age=31536000, immutable");
        return reply.type(MIME[extname(file)] ?? "application/octet-stream").send(await readFile(file));
      }
    }
    const html = await readFile(join(webDir, "index.html")).catch(() => null);
    if (!html) return reply.code(503).type("text/plain").send("Painel ainda não foi gerado (npm run build:web).");
    reply.header("Cache-Control", "no-store");
    return reply.type("text/html; charset=utf-8").send(html);
  });

  return app;
}
