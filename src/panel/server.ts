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
import { dashboard, funnelPeople, FUNNEL_STEPS, type FunnelStep, type RangeKey } from "./dashboard.js";
import { analyze, applyImport, suggestPlans } from "../domain/importer.js";
import { FILE_ERR, IMPORT_SOURCES, sourceById } from "../domain/import-sources.js";
import { audienceRows, broadcastStats } from "../domain/broadcast.js";
import { ensureRecoveryTemplates } from "../domain/recovery.js";
import { ensureTemplates, pendingRemovals, planOutbox, retentionWindow } from "../domain/retention.js";
import { agentReply, assume, closeTicket, customerTrail, isSupportOpen, supportHours } from "../domain/support.js";
import { InlineKeyboard } from "grammy";
import { DUMMY_HASH, hashPassword, LoginLimiter, newToken, passwordProblem, tokenHash, verifyPassword } from "./auth.js";

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
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".mp4": "video/mp4",
  ".oga": "audio/ogg",
  ".ogg": "audio/ogg",
  ".pdf": "application/pdf",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".json": "application/json",
};

const cents = z.number().int().min(0).max(10_000_000);
const unit = z.enum(["day", "month", "year", "lifetime"]);

export function buildPanel(ctx: Ctx, opts: { webDir?: string; secureCookies?: boolean; logger?: boolean; transformer?: Transformer } = {}) {
  const { db } = ctx;
  const limiter = new LoginLimiter();
  const ipLimiter = new LoginLimiter(40);
  const app = Fastify({ logger: opts.logger ?? false, bodyLimit: 1_000_000, trustProxy: true });
  const webDir = resolve(opts.webDir ?? "dist-web");
  const cookie = (token: string, maxAge: number) => `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${opts.secureCookies ? "; Secure" : ""}`;
  const tgApi = (row: typeof s.bots.$inferSelect) => apiForToken(botToken(row, ctx.appSecret), opts.transformer);

  const CSP = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data: blob: https:",
    "media-src 'self' blob: https:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
  app.addHook("onSend", async (_req, reply) => {
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("X-Frame-Options", "DENY");
    reply.header("Referrer-Policy", "same-origin");
    reply.header("Content-Security-Policy", CSP);
    reply.header("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    if (opts.secureCookies) reply.header("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
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
  // Roda ANTES de ler o corpo da requisição: quem não está logado não consegue nem enviar arquivos grandes.
  app.addHook("onRequest", async (req, reply) => {
    if (!req.url.startsWith("/api/")) return;
    // Proteção contra formulários de outros sites: alterações exigem o cabeçalho do painel.
    if (req.method !== "GET" && req.headers["x-botly"] !== "1") return reply.code(403).send({ error: "Requisição recusada." });
    const path = req.url.split("?")[0]!;
    if (PUBLIC.has(path)) return;
    const u = await loadUser(req);
    if (!u) return reply.code(401).send({ error: "Entre de novo para continuar." });
    req.user = u;
    // Corpo binário grande só nos envios de mídia; nas outras rotas o limite é o padrão (1 MB).
    const len = Number(req.headers["content-length"] ?? 0);
    if (len > 1_000_000 && !(path === "/api/media" || path.startsWith("/api/import/"))) return reply.code(413).send({ error: "Arquivo grande demais para esta ação." });
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
    if (limiter.blocked(key) || ipLimiter.blocked(req.ip)) throw new HttpError(429, "Muitas tentativas. Espere 15 minutos e tente de novo.");
    const u = (await db.select().from(s.users).where(sql`lower(${s.users.email}) = ${b.email.toLowerCase()}`))[0];
    // E-mail que não existe gasta o mesmo tempo (não revela quais e-mails têm conta).
    const ok = await verifyPassword(b.password, u?.passwordHash ?? DUMMY_HASH);
    if (!u || !u.active || !ok) {
      limiter.fail(key);
      ipLimiter.fail(req.ip);
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

  app.get<{ Querystring: { range?: string; from?: string; to?: string; bots?: string } }>("/api/dashboard", async (req) => {
    const a = (await db.select().from(s.accounts).where(eq(s.accounts.id, acc(req))))[0]!;
    const keys: RangeKey[] = ["today", "yesterday", "7d", "week", "month", "30d", "all", "custom"];
    const key = (keys as string[]).includes(req.query.range ?? "") ? (req.query.range as RangeKey) : "7d";
    // bots=id1,id2 (vazio/ausente = todos). Só ids de bots desta conta.
    let bf: string[] | null = null;
    if (req.query.bots) {
      const want = req.query.bots.split(",").map((x) => x.trim()).filter(Boolean);
      const mine = (await db.select({ id: s.bots.id }).from(s.bots).where(eq(s.bots.accountId, a.id))).map((b) => b.id);
      bf = want.filter((x) => mine.includes(x));
    }
    return dashboard(db, a.id, ctx.now(), a.settings.timezone ?? DEFAULT_TZ, key, { from: req.query.from, to: req.query.to }, bf);
  });

  // Quem passou por uma etapa do funil (mesmos filtros do Início).
  app.get<{ Querystring: { range?: string; from?: string; to?: string; bots?: string; step?: string } }>("/api/dashboard/people", async (req) => {
    const a = (await db.select().from(s.accounts).where(eq(s.accounts.id, acc(req))))[0]!;
    const keys: RangeKey[] = ["today", "yesterday", "7d", "week", "month", "30d", "all", "custom"];
    const key = (keys as string[]).includes(req.query.range ?? "") ? (req.query.range as RangeKey) : "7d";
    const step = (FUNNEL_STEPS as readonly string[]).includes(req.query.step ?? "") ? (req.query.step as FunnelStep) : "started";
    let bf: string[] | null = null;
    if (req.query.bots) {
      const want = req.query.bots.split(",").map((x) => x.trim()).filter(Boolean);
      const mine = (await db.select({ id: s.bots.id }).from(s.bots).where(eq(s.bots.accountId, a.id))).map((b) => b.id);
      bf = want.filter((x) => mine.includes(x));
    }
    return funnelPeople(db, a.id, ctx.now(), a.settings.timezone ?? DEFAULT_TZ, key, { from: req.query.from, to: req.query.to }, bf, step);
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
    recovery: z.object({ enabled: z.boolean(), downsellPlanId: z.string().uuid().nullable().optional() }).optional(),
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
    if (p.recovery?.downsellPlanId) {
      const pl = (await db.select().from(s.plans).where(and(eq(s.plans.id, p.recovery.downsellPlanId), eq(s.plans.botId, bot.id))))[0];
      if (!pl) throw notFound("Plano");
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
        ...(p.recovery ? { recovery: { ...bot.recovery, ...p.recovery } } : {}),
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

  // ─── Transmissões (mailing) ───

  const audienceBody = z.object({
    segment: z.enum(["all", "active", "expired", "never"]),
    channelId: z.string().uuid().nullish(),
    channelMode: z.enum(["has", "hasnt"]).optional(),
    expiringDays: z.number().int().min(1).max(365).nullish(),
  });
  const broadcastBody = z.object({
    name: z.string().trim().max(80).optional(),
    botIds: z.array(z.string().uuid()).min(1).max(20),
    audience: audienceBody,
    content: z.object({
      text: z.string().trim().min(1).max(4000),
      media: z.object({ type: z.enum(["photo", "video", "animation"]), mediaId: z.string().uuid().nullish(), url: z.string().url().max(500).nullish() }).nullish(),
      button: z
        .object({
          kind: z.enum(["none", "plans", "url", "offer"]),
          label: z.string().trim().max(60).optional(),
          url: z.string().url().max(500).optional(),
          planId: z.string().uuid().optional(),
          discountPct: z.number().int().min(0).max(90).optional(),
          validMinutes: z.number().int().min(1).max(10080).optional(),
        })
        .nullish(),
    }),
    /** Vazio = enviar agora. */
    scheduledAt: z.string().datetime().nullish(),
  });
  const myBots = async (req: FastifyRequest, ids: string[]) => {
    const rows = await db.select().from(s.bots).where(and(eq(s.bots.accountId, acc(req)), inArray(s.bots.id, ids)));
    if (rows.length !== new Set(ids).size) throw new HttpError(400, "Escolha apenas bots da sua conta.");
    return rows;
  };

  app.post("/api/broadcasts/audience", async (req) => {
    const p = z.object({ botIds: z.array(z.string().uuid()).max(20), audience: audienceBody }).parse(req.body);
    if (p.botIds.length) await myBots(req, p.botIds);
    const rows = await audienceRows(ctx, acc(req), p.botIds, p.audience);
    return { count: rows.length };
  });

  app.get("/api/broadcasts", async (req) => {
    const rows = await db.select().from(s.broadcasts).where(eq(s.broadcasts.accountId, acc(req))).orderBy(desc(s.broadcasts.scheduledAt)).limit(100);
    const out = [];
    for (const b of rows) out.push({ id: b.id, name: b.name, status: b.status, scheduledAt: b.scheduledAt, startedAt: b.startedAt, finishedAt: b.finishedAt, audience: b.audience, botIds: b.botIds, button: b.content.button?.kind ?? "none", stats: await broadcastStats(ctx, b.id) });
    return { broadcasts: out };
  });

  app.get<{ Params: { id: string } }>("/api/broadcasts/:id", async (req) => {
    const b = (await db.select().from(s.broadcasts).where(and(eq(s.broadcasts.id, req.params.id), eq(s.broadcasts.accountId, acc(req)))))[0];
    if (!b) throw notFound("Transmissão");
    return { ...b, stats: await broadcastStats(ctx, b.id) };
  });

  app.post("/api/broadcasts", async (req) => {
    const p = broadcastBody.parse(req.body);
    const bots = await myBots(req, p.botIds);
    const btn = p.content.button;
    if (btn?.kind === "url" && !btn.url) throw new HttpError(400, "Informe o link do botão.");
    if (btn?.kind === "offer") {
      if (bots.length !== 1) throw new HttpError(400, "A oferta com plano e desconto só funciona com um bot escolhido.");
      const plan = btn.planId ? (await db.select().from(s.plans).where(and(eq(s.plans.id, btn.planId), eq(s.plans.botId, bots[0]!.id), eq(s.plans.active, true))))[0] : undefined;
      if (!plan) throw new HttpError(400, "Escolha um plano ativo deste bot para a oferta.");
    }
    if (p.audience.channelId) {
      const ch = (await db.select({ id: s.channels.id }).from(s.channels).where(and(eq(s.channels.id, p.audience.channelId), eq(s.channels.accountId, acc(req)))))[0];
      if (!ch) throw new HttpError(400, "Canal não encontrado.");
    }
    if (p.content.media?.mediaId) {
      const m = (await db.select({ id: s.media.id }).from(s.media).where(and(eq(s.media.id, p.content.media.mediaId), eq(s.media.accountId, acc(req)))))[0];
      if (!m) throw new HttpError(400, "Arquivo de mídia não encontrado.");
    }
    if (p.content.media && p.content.text.length > 1024) throw new HttpError(400, "Com imagem ou vídeo, o texto pode ter no máximo 1024 caracteres (limite do Telegram).");
    const when = p.scheduledAt ? new Date(p.scheduledAt) : ctx.now();
    const at = when.getTime() < ctx.now().getTime() ? ctx.now() : when;
    const name = p.name || `Transmissão de ${at.toLocaleDateString("pt-BR", { timeZone: DEFAULT_TZ })}`;
    const [row] = await db.insert(s.broadcasts).values({ accountId: acc(req), name, botIds: p.botIds, audience: p.audience, content: p.content, scheduledAt: at }).returning();
    return row;
  });

  app.post<{ Params: { id: string } }>("/api/broadcasts/:id/cancel", async (req) => {
    const [row] = await db
      .update(s.broadcasts)
      .set({ status: "canceled", finishedAt: ctx.now() })
      .where(and(eq(s.broadcasts.id, req.params.id), eq(s.broadcasts.accountId, acc(req)), inArray(s.broadcasts.status, ["scheduled", "sending"])))
      .returning();
    if (!row) throw notFound("Transmissão em andamento");
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
    const g = (await db.select().from(s.gateways).where(and(eq(s.gateways.id, id), eq(s.gateways.accountId, acc(req)))))[0];
    if (!g) throw new HttpError(404, "Forma de pagamento não encontrada.");
    // Pix ainda em aberto (24 h) precisa dessa forma de pagamento para ser conferido e liberar o acesso.
    const [{ n: abertos }] = (await db
      .select({ n: count() })
      .from(s.charges)
      .where(and(eq(s.charges.gatewayId, id), eq(s.charges.status, "pending"), gt(s.charges.createdAt, new Date(ctx.now().getTime() - 24 * 3600_000))))) as [{ n: number }];
    if (abertos > 0) throw new HttpError(409, `Esta forma de pagamento tem ${abertos} Pix em aberto que ainda podem ser pagos. Desative em vez de apagar (os bots param de usar, mas os Pix pendentes continuam sendo conferidos). Para apagar, espere 24 horas.`);
    await db.insert(s.auditLog).values({ accountId: g.accountId, userId: req.user!.id, action: "pagamento_removido", meta: { label: g.label, provider: g.provider } });
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
      removalsNoManager: removals.filter((r) => r.noManager).length,
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
    const rows = [...(await ensureTemplates(ctx, acc(req))), ...(await ensureRecoveryTemplates(ctx, acc(req)))];
    const a = (await db.select().from(s.accounts).where(eq(s.accounts.id, acc(req))))[0]!;
    return {
      reminderTime: a.settings.reminderTime ?? "10:00",
      removeGraceHours: a.settings.removeGraceHours ?? 0,
      autoRemove: !!a.settings.autoRemove,
      templates: rows
        .filter((r) => !r.botId)
        .map((r) => ({ id: r.id, kind: r.kind, days: Math.round(r.offsetMinutes / 1440), minutes: r.offsetMinutes, text: r.text, discountPct: r.discountPct, enabled: r.enabled, mediaUrl: r.media?.url ?? null }))
        .sort((x, y) => x.days - y.days),
    };
  });

  const tplBody = z.object({
    kind: z.enum(["reminder", "winback", "recovery"]),
    days: z.number().int().min(-30).max(60).optional(),
    minutes: z.number().int().min(5).max(2880).optional(), // só recuperação: minutos depois de gerar o Pix
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
      ...(p.kind === "recovery" ? (p.minutes !== undefined ? { offsetMinutes: p.minutes } : {}) : p.days !== undefined ? { offsetMinutes: p.days * 1440 } : {}),
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
    if (p.kind === "recovery" && p.minutes === undefined) throw new HttpError(400, "Informe quantos minutos depois do Pix esta mensagem sai.");
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
    source: z.string().max(40).optional(), // sistema de origem (padrão: automatizzebot)
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
    const source = sourceById(b.source);
    if (!source) throw new HttpError(400, "Sistema de origem desconhecido.");
    let parsed;
    try {
      parsed = await source.parse(Buffer.from(b.data, "base64"), b.fileName, tz);
    } catch (err) {
      throw new HttpError(400, err instanceof Error && /coluna|planilha/i.test(err.message) ? err.message : FILE_ERR);
    }
    const analysis = analyze(parsed.rows, ctx.now());
    analysis.columns = parsed.columns;
    return { b, bot, channel, analysis, source };
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
    const { b, bot, channel, analysis, source } = await readImport(req);
    if (b.onlyActive) {
      // Só os ativos: vencidos ficam de fora (não viram clientes no Botly).
      const now = ctx.now();
      analysis.customers = analysis.customers.filter((c) => c.expiresAt > now);
      analysis.expired = 0;
    }
    if (!analysis.customers.length) throw new HttpError(400, "Nenhum cliente válido para importar.");
    const r = await applyImport(ctx, { accountId: acc(req), botId: bot.id, channelId: channel.id, analysis, planMap: b.planMap ?? {}, fileName: b.fileName, source: source.id, userId: req.user!.id });
    // Já monta os lembretes dos importados.
    await planOutbox(ctx, acc(req));
    return r;
  });

  app.get("/api/import/sources", async () =>
    IMPORT_SOURCES.map((x) => ({ id: x.id, name: x.name, tagline: x.tagline, steps: x.steps, warnings: x.warnings, accept: x.accept, fileHint: x.fileHint })),
  );

  app.get("/api/imports", async (req) => {
    const rows = await db.select().from(s.imports).where(eq(s.imports.accountId, acc(req))).orderBy(desc(s.imports.createdAt)).limit(30);
    const bots = await db.select({ id: s.bots.id, username: s.bots.username }).from(s.bots).where(eq(s.bots.accountId, acc(req)));
    const chans = await db.select({ id: s.channels.id, title: s.channels.title }).from(s.channels).where(eq(s.channels.accountId, acc(req)));
    return rows.map((r) => ({ id: r.id, fileName: r.fileName, source: sourceById(r.source)?.name ?? r.source, createdAt: r.createdAt, stats: r.stats, bot: bots.find((x) => x.id === r.botId)?.username ?? null, channel: chans.find((x) => x.id === r.channelId)?.title ?? null }));
  });

  // ─── Atendimento ───

  const ticketOf = async (req: FastifyRequest, id: string) => {
    const t = (await db.select().from(s.supportTickets).where(and(eq(s.supportTickets.id, id), eq(s.supportTickets.accountId, acc(req)))))[0];
    if (!t) throw new HttpError(404, "Conversa não encontrada.");
    return t;
  };
  const ticketApi = async (t: typeof s.supportTickets.$inferSelect) => {
    const b = t.botId ? (await db.select().from(s.bots).where(eq(s.bots.id, t.botId)))[0] : undefined;
    if (!b) throw new HttpError(400, "O bot desta conversa não existe mais.");
    return { bot: b, api: tgApi(b) };
  };
  const agentOf = async (req: FastifyRequest) => {
    const u = (await db.select().from(s.users).where(eq(s.users.id, req.user!.id)))[0]!;
    return { id: u.id, name: u.supportName?.trim() || u.name };
  };

  app.get("/api/support", async (req) => {
    const q = z.object({ status: z.enum(["open", "active", "closed"]).optional() }).parse(req.query);
    const rows = await db
      .select({ t: s.supportTickets, c: s.customers, bot: s.bots.username })
      .from(s.supportTickets)
      .innerJoin(s.customers, eq(s.customers.id, s.supportTickets.customerId))
      .leftJoin(s.bots, eq(s.bots.id, s.supportTickets.botId))
      .where(and(eq(s.supportTickets.accountId, acc(req)), q.status ? eq(s.supportTickets.status, q.status) : undefined))
      .orderBy(desc(s.supportTickets.lastMessageAt))
      .limit(q.status === "closed" ? 50 : 200);
    const ids = rows.map((r) => r.t.id);
    const last = ids.length
      ? await db.execute(sql`select distinct on (ticket_id) ticket_id, sender, text, media_type from support_messages where ticket_id in (${sql.join(ids.map((i) => sql`${i}::uuid`), sql`, `)}) order by ticket_id, created_at desc`)
      : [];
    const lastBy = new Map((last as unknown as { ticket_id: string; sender: string; text: string | null; media_type: string | null }[]).map((m) => [m.ticket_id, m]));
    const counts = await db
      .select({ status: s.supportTickets.status, n: count() })
      .from(s.supportTickets)
      .where(and(eq(s.supportTickets.accountId, acc(req)), inArray(s.supportTickets.status, ["open", "active"])))
      .groupBy(s.supportTickets.status);
    const a = (await db.select().from(s.accounts).where(eq(s.accounts.id, acc(req))))[0]!;
    return {
      counts: { open: counts.find((c) => c.status === "open")?.n ?? 0, active: counts.find((c) => c.status === "active")?.n ?? 0 },
      isOpenNow: isSupportOpen(a.settings, ctx.now()),
      hours: supportHours(a.settings),
      tickets: rows.map((r) => {
        const m = lastBy.get(r.t.id);
        return {
          id: r.t.id,
          status: r.t.status,
          topic: r.t.topic,
          agentName: r.t.agentName,
          unread: r.t.unread,
          lastMessageAt: r.t.lastMessageAt,
          bot: r.bot,
          customer: { name: [r.c.firstName, r.c.lastName].filter(Boolean).join(" ") || null, username: r.c.username, telegramUserId: r.c.telegramUserId },
          preview: m ? { sender: m.sender, text: m.text ?? (m.media_type === "photo" ? "📷 Foto" : m.media_type ? "📎 Arquivo" : "") } : null,
        };
      }),
    };
  });

  // Contador leve para o menu (aguardando + mensagens não lidas).
  app.get("/api/support-count", async (req) => {
    const r = await db
      .select({ waiting: sql<number>`count(*) filter (where ${s.supportTickets.status} = 'open')::int`, unread: sql<number>`coalesce(sum(${s.supportTickets.unread}), 0)::int` })
      .from(s.supportTickets)
      .where(and(eq(s.supportTickets.accountId, acc(req)), inArray(s.supportTickets.status, ["open", "active"])));
    return r[0] ?? { waiting: 0, unread: 0 };
  });

  app.get("/api/support/:id", async (req) => {
    const t = await ticketOf(req, (req.params as { id: string }).id);
    const c = (await db.select().from(s.customers).where(eq(s.customers.id, t.customerId)))[0]!;
    const msgs = await db.select().from(s.supportMessages).where(eq(s.supportMessages.ticketId, t.id)).orderBy(asc(s.supportMessages.createdAt));
    const accesses = await db
      .select({ a: s.accesses, ch: s.channels })
      .from(s.accesses)
      .innerJoin(s.channels, eq(s.channels.id, s.accesses.channelId))
      .where(eq(s.accesses.customerId, c.id));
    const orders = await db
      .select({ o: s.orders, bot: s.bots.username })
      .from(s.orders)
      .leftJoin(s.bots, eq(s.bots.id, s.orders.botId))
      .where(eq(s.orders.customerId, c.id))
      .orderBy(desc(s.orders.createdAt))
      .limit(10);
    const past = await db
      .select({ n: count() })
      .from(s.supportTickets)
      .where(and(eq(s.supportTickets.customerId, c.id), eq(s.supportTickets.status, "closed")));
    if (t.unread) await db.update(s.supportTickets).set({ unread: 0 }).where(eq(s.supportTickets.id, t.id));
    const bot = t.botId ? (await db.select({ username: s.bots.username }).from(s.bots).where(eq(s.bots.id, t.botId)))[0]?.username : null;
    return {
      ticket: { id: t.id, status: t.status, topic: t.topic, agentName: t.agentName, createdAt: t.createdAt, bot },
      customer: {
        id: c.id,
        name: [c.firstName, c.lastName].filter(Boolean).join(" ") || null,
        username: c.username,
        telegramUserId: c.telegramUserId,
        totalSpentCents: c.totalSpentCents,
        purchases: c.purchases,
        since: c.firstSeenAt,
        pastTickets: past[0]?.n ?? 0,
      },
      accesses: accesses.map((r) => ({ id: r.a.id, channel: r.ch.displayName?.trim() || r.ch.title, status: r.a.status, expiresAt: r.a.expiresAt })),
      orders: orders.map((r) => ({ id: r.o.id, createdAt: r.o.createdAt, status: r.o.status, kind: r.o.kind, totalCents: r.o.totalCents, items: r.o.items.map((i) => i.name), bot: r.bot })),
      trail: await customerTrail(ctx, t.accountId, c.id),
      messages: msgs.map((m) => ({ id: m.id, sender: m.sender, text: m.text, mediaType: m.mediaType, agentName: m.agentName, createdAt: m.createdAt })),
    };
  });

  app.post("/api/support/:id/reply", async (req) => {
    const t = await ticketOf(req, (req.params as { id: string }).id);
    const p = z.object({ text: z.string().trim().min(1, "Escreva a mensagem.").max(3500) }).parse(req.body);
    if (t.status === "closed") throw new HttpError(400, "Esta conversa já foi encerrada.");
    const { api } = await ticketApi(t);
    try {
      await agentReply(ctx, api, t, await agentOf(req), p.text);
    } catch (err) {
      if (/blocked|deactivated|chat not found/i.test(String(err))) throw new HttpError(400, "O cliente bloqueou o bot, a mensagem não foi entregue.");
      throw err;
    }
    return { ok: true };
  });

  app.post("/api/support/:id/assume", async (req) => {
    const t = await ticketOf(req, (req.params as { id: string }).id);
    if (t.status === "closed") throw new HttpError(400, "Esta conversa já foi encerrada.");
    const { api } = await ticketApi(t);
    await assume(ctx, api, t, await agentOf(req));
    return { ok: true };
  });

  app.post("/api/support/:id/close", async (req) => {
    const t = await ticketOf(req, (req.params as { id: string }).id);
    if (t.status === "closed") return { ok: true };
    const { api } = await ticketApi(t).catch(() => ({ api: null }));
    await closeTicket(ctx, api, t, "agent", (await agentOf(req)).name);
    return { ok: true };
  });

  // Ação rápida: reenviar os botões de entrada nos canais ativos.
  app.post("/api/support/:id/send-links", async (req) => {
    const t = await ticketOf(req, (req.params as { id: string }).id);
    const { api } = await ticketApi(t);
    const c = (await db.select().from(s.customers).where(eq(s.customers.id, t.customerId)))[0]!;
    const rows = await db
      .select({ a: s.accesses, ch: s.channels })
      .from(s.accesses)
      .innerJoin(s.channels, eq(s.channels.id, s.accesses.channelId))
      .where(and(eq(s.accesses.customerId, c.id), eq(s.accesses.status, "active")));
    const now = ctx.now();
    const kb = new InlineKeyboard();
    let n = 0;
    for (const r of rows)
      if ((!r.a.expiresAt || r.a.expiresAt > now) && r.ch.inviteLink) {
        kb.url(`🔓 Entrar no ${r.ch.displayName?.trim() || r.ch.title}`, r.ch.inviteLink).row();
        n++;
      }
    if (!n) throw new HttpError(400, "O cliente não tem nenhum acesso ativo com link.");
    await api.sendMessage(c.telegramUserId, "Aqui estão os links dos seus canais. Toque e depois em “Pedir para entrar”:", { reply_markup: kb });
    const { addMessage } = await import("../domain/support.js");
    await addMessage(ctx, t, { sender: "system", text: "Links dos canais reenviados." });
    return { ok: true };
  });

  // Ação rápida: estender um acesso por N dias.
  app.post("/api/support/:id/extend", async (req) => {
    const t = await ticketOf(req, (req.params as { id: string }).id);
    const p = z.object({ accessId: z.string().uuid(), days: z.number().int().min(1).max(365) }).parse(req.body);
    const a = (await db.select().from(s.accesses).where(and(eq(s.accesses.id, p.accessId), eq(s.accesses.customerId, t.customerId))))[0];
    if (!a) throw new HttpError(404, "Acesso não encontrado.");
    if (!a.expiresAt) throw new HttpError(400, "Este acesso é vitalício.");
    const base = a.expiresAt > ctx.now() ? a.expiresAt : ctx.now();
    const exp = new Date(base.getTime() + p.days * 86_400_000);
    await db.update(s.accesses).set({ expiresAt: exp, status: "active" }).where(eq(s.accesses.id, a.id));
    const { addMessage } = await import("../domain/support.js");
    await addMessage(ctx, t, { sender: "system", text: `Acesso estendido em ${p.days} dia(s).` });
    return { ok: true, expiresAt: exp };
  });

  // Foto/arquivo enviado pelo cliente (baixa do Telegram pelo bot da conversa).
  app.get("/api/support/file/:messageId", async (req, reply) => {
    const m = (await db.select().from(s.supportMessages).where(and(eq(s.supportMessages.id, (req.params as { messageId: string }).messageId), eq(s.supportMessages.accountId, acc(req)))))[0];
    if (!m?.tgFileId) throw new HttpError(404, "Arquivo não encontrado.");
    const t = (await db.select().from(s.supportTickets).where(eq(s.supportTickets.id, m.ticketId)))[0]!;
    const { bot, api } = await ticketApi(t);
    const f = await api.getFile(m.tgFileId).catch(() => null);
    if (!f?.file_path) throw new HttpError(404, "O Telegram não entregou o arquivo (pode ter expirado).");
    const res = await fetch(`https://api.telegram.org/file/bot${botToken(bot, ctx.appSecret)}/${f.file_path}`);
    if (!res.ok) throw new HttpError(502, "Não consegui baixar o arquivo do Telegram.");
    const ext = extname(f.file_path ?? "").toLowerCase();
    reply.header("Cache-Control", "private, max-age=86400");
    return reply.type(MIME[ext] ?? "application/octet-stream").send(Buffer.from(await res.arrayBuffer()));
  });

  app.get("/api/support-settings", async (req) => {
    const a = (await db.select().from(s.accounts).where(eq(s.accounts.id, acc(req))))[0]!;
    const u = (await db.select().from(s.users).where(eq(s.users.id, req.user!.id)))[0]!;
    return { ...supportHours(a.settings), offMessage: a.settings.supportOffMessage ?? "", supportName: u.supportName ?? "", defaultName: u.name };
  });

  app.put("/api/support-settings", async (req) => {
    const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Horário no formato 10:00.");
    const p = z.object({ start: hhmm, end: hhmm, offMessage: z.string().max(1000), supportName: z.string().trim().max(40) }).parse(req.body);
    const a = (await db.select().from(s.accounts).where(eq(s.accounts.id, acc(req))))[0]!;
    await db.update(s.accounts).set({ settings: { ...a.settings, supportStart: p.start, supportEnd: p.end, supportOffMessage: p.offMessage.trim() || undefined }, updatedAt: ctx.now() }).where(eq(s.accounts.id, a.id));
    await db.update(s.users).set({ supportName: p.supportName || null }).where(eq(s.users.id, req.user!.id));
    return { ok: true };
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
