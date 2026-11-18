// Ponto de entrada. O mesmo build roda a API (bots, webhooks e tarefas agendadas),
// o painel das contas ou o super admin, conforme BOTLY_ROLE.
import { createDb } from "./db/client.js";
import { runMigrations } from "./db/migrate.js";
import { env } from "./env.js";
import { buildApi } from "./api/server.js";
import { announceUnderpaid } from "./bot/notify.js";
import { createRuntime } from "./bot/runtime.js";
import type { Ctx } from "./domain/context.js";
import { startTicks } from "./jobs/ticks.js";
import { log } from "./lib/log.js";

const e = env();
await runMigrations(e.DATABASE_URL);
const { db } = createDb(e.DATABASE_URL);

if (e.BOTLY_ROLE === "api") {
  const ctx: Ctx = { db, appSecret: e.APP_SECRET, publicUrl: e.PUBLIC_URL, fetch, now: () => new Date(), log };
  const rt = createRuntime(ctx);
  ctx.onUnderpaid = (info) => announceUnderpaid(ctx, rt, info);
  const server = buildApi(ctx, rt);
  startTicks(ctx, rt);
  await server.listen({ host: "0.0.0.0", port: e.PORT });
} else if (e.BOTLY_ROLE === "panel") {
  const { buildPanel } = await import("./panel/server.js");
  const ctx: Ctx = { db, appSecret: e.APP_SECRET, publicUrl: e.PUBLIC_URL, fetch, now: () => new Date(), log };
  const app = buildPanel(ctx, { secureCookies: e.NODE_ENV === "production" });
  await app.listen({ host: "0.0.0.0", port: e.PORT });
} else {
  // Super admin: em construção.
  const Fastify = (await import("fastify")).default;
  const app = Fastify({ logger: true });
  app.get("/health", async () => ({ ok: true, role: e.BOTLY_ROLE }));
  await app.listen({ host: "0.0.0.0", port: e.PORT });
}
