import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

/**
 * Aplica as migrações pendentes. Bot e painel sobem juntos a cada deploy, então
 * um lock no Postgres garante que só um aplica por vez (o outro espera e não
 * encontra nada pendente).
 */
export async function runMigrations(url: string) {
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  try {
    await sql`select pg_advisory_lock(727101)`;
    const folder = fileURLToPath(new URL("../../drizzle", import.meta.url));
    await migrate(drizzle(sql), { migrationsFolder: folder });
    await sql`select pg_advisory_unlock(727101)`;
  } finally {
    await sql.end();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await runMigrations(process.env.DATABASE_URL!);
  console.log("migrações aplicadas");
}
