// Tarefas periódicas da API.
import { and, eq, gt, isNotNull, lt } from "drizzle-orm";
import * as s from "../db/schema.js";
import type { Ctx } from "../domain/context.js";
import { checkCharge } from "../domain/sales.js";
import { announcePaid } from "../bot/notify.js";
import type { BotlyRuntime } from "../bot/runtime.js";

/** Intervalo mínimo entre consultas da mesma cobrança, por provedor. */
const POLL_MS: Record<string, number> = { pushinpay: 5 * 60_000, paggone: 60_000 };
const lastPoll = new Map<string, number>();

/**
 * Conferência de Pix pendentes (caso o aviso do gateway não chegue). Confere por
 * até 24 h depois de gerado: pagamento atrasado ainda libera.
 */
export async function reconcileCharges(ctx: Ctx, rt: BotlyRuntime) {
  const now = ctx.now().getTime();
  const since = new Date(now - 24 * 3600_000);
  const pending = await ctx.db
    .select({ id: s.charges.id, provider: s.charges.provider, createdAt: s.charges.createdAt })
    .from(s.charges)
    .where(and(eq(s.charges.status, "pending"), isNotNull(s.charges.providerTxId), gt(s.charges.createdAt, since)));
  for (const c of pending) {
    const every = POLL_MS[c.provider] ?? 60_000;
    // Nos primeiros 2 minutos o aviso costuma chegar sozinho.
    if (now - c.createdAt.getTime() < 2 * 60_000) continue;
    if (now - (lastPoll.get(c.id) ?? 0) < every) continue;
    lastPoll.set(c.id, now);
    try {
      const r = await checkCharge(ctx, c.id);
      if (r && r !== "pending") await announcePaid(ctx, rt, r);
    } catch (err) {
      ctx.log.warn({ chargeId: c.id, err: String(err) }, "conferência de Pix falhou");
    }
  }
  // Pendentes há mais de 24 h viram expiradas.
  await ctx.db
    .update(s.charges)
    .set({ status: "expired" })
    .where(and(eq(s.charges.status, "pending"), lt(s.charges.createdAt, since)));
  for (const [id, t] of lastPoll) if (now - t > 26 * 3600_000) lastPoll.delete(id);
}

export function startTicks(ctx: Ctx, rt: BotlyRuntime) {
  let running = false;
  const timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      await reconcileCharges(ctx, rt);
    } catch (err) {
      ctx.log.error({ err: String(err) }, "erro nas tarefas periódicas");
    } finally {
      running = false;
    }
  }, 60_000);
  return () => clearInterval(timer);
}
