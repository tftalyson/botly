// Ponto de entrada. O mesmo build roda a API (bots, webhooks e tarefas agendadas),
// o painel das contas ou o super admin, conforme BOTLY_ROLE.
import Fastify from "fastify";
import { runMigrations } from "./db/migrate.js";
import { env } from "./env.js";

const e = env();
await runMigrations(e.DATABASE_URL);

const app = Fastify({ logger: { level: e.LOG_LEVEL } });
app.get("/health", async () => ({ ok: true, role: e.BOTLY_ROLE }));

await app.listen({ host: "0.0.0.0", port: e.PORT });
