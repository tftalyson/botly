// Servidor da API: webhooks do Telegram (um por bot) e dos gateways de pagamento.
import { timingSafeEqual } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import * as s from "../db/schema.js";
import type { Ctx } from "../domain/context.js";
import { checkCharge } from "../domain/sales.js";
import { findTxn } from "../integrations/paggone.js";
import { ppIdFrom } from "../integrations/pushinpay.js";
import { announcePaid } from "../bot/notify.js";
import type { BotlyRuntime } from "../bot/runtime.js";

export function safeEqual(a: string, b: string) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export function buildApi(ctx: Ctx, rt: BotlyRuntime, opts: { logger?: boolean } = {}): FastifyInstance {
  const app = Fastify({ logger: opts.logger ?? false, bodyLimit: 1_000_000 });
  // A PushinPay pode mandar o aviso como formulário.
  app.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string" }, (_req, body, done) => {
    done(null, Object.fromEntries(new URLSearchParams(String(body))));
  });

  app.get("/health", async () => ({ ok: true }));

  app.post<{ Params: { botId: string } }>("/tg/:botId", async (req, reply) => {
    const bot = (await ctx.db.select({ id: s.bots.id, secret: s.bots.webhookSecret }).from(s.bots).where(eq(s.bots.id, req.params.botId)).catch(() => []))[0];
    const header = String(req.headers["x-telegram-bot-api-secret-token"] ?? "");
    if (!bot || !safeEqual(header, bot.secret)) return reply.code(401).send({ ok: false });
    // Responde rápido ao Telegram; o processamento segue em segundo plano.
    reply.send({ ok: true });
    rt.handle(bot.id, req.body as never).catch((err) => ctx.log.error({ botId: bot.id, err: String(err) }, "erro ao processar atualização"));
  });

  // Aviso de pagamento. O token vai no caminho (alguns gateways descartam a parte "?token=" do endereço);
  // o formato antigo com ?token= continua aceito.
  const payHandler = async (req: FastifyRequest<{ Params: { provider: string; gatewayId: string; token?: string }; Querystring: { token?: string } }>, reply: FastifyReply) => {
    const token = req.params.token ?? req.query.token ?? "";
    const g = (await ctx.db.select().from(s.gateways).where(eq(s.gateways.id, req.params.gatewayId)).catch(() => []))[0];
    if (!g || g.provider !== req.params.provider || !safeEqual(token, g.webhookToken)) {
      ctx.log.warn({ provider: req.params.provider, gatewayId: req.params.gatewayId, hasToken: !!token }, "aviso de pagamento recusado (token)");
      return reply.code(401).send({ ok: false });
    }
    const txId = g.provider === "pushinpay" ? ppIdFrom(req.body) : findTxn(req.body);
    ctx.log.info({ provider: g.provider, txId, body: JSON.stringify(req.body ?? null).slice(0, 500) }, "aviso de pagamento recebido");
    if (!txId) return reply.send({ ok: true, ignored: "sem id" });
    const charge = (
      await ctx.db
        .select()
        .from(s.charges)
        .where(and(eq(s.charges.provider, g.provider), sql`lower(${s.charges.providerTxId}) = ${txId.toLowerCase()}`))
    )[0];
    if (!charge) {
      ctx.log.warn({ provider: g.provider, txId }, "aviso de pagamento: cobrança desconhecida");
      return reply.send({ ok: true, ignored: "cobrança desconhecida" });
    }
    // Nunca confia só no aviso: confere na API do gateway.
    try {
      const r = await checkCharge(ctx, charge.id);
      const paid = !!(r && r !== "pending");
      ctx.log.info({ chargeId: charge.id, paid, result: r === "pending" ? "pendente" : r ? "pago" : "já tratado" }, "aviso de pagamento conferido");
      if (paid) await announcePaid(ctx, rt, r as Exclude<typeof r, "pending" | null>);
      return reply.send({ ok: true, paid });
    } catch (err) {
      ctx.log.warn({ chargeId: charge.id, err: String(err) }, "falha ao conferir aviso de pagamento");
      return reply.code(500).send({ ok: false });
    }
  };
  app.post("/pay/:provider/:gatewayId", payHandler);
  app.post("/pay/:provider/:gatewayId/:token", payHandler);

  return app;
}
