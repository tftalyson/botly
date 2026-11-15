import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.string().default("production"),
  PORT: z.coerce.number().default(3000),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  /** 32+ caracteres aleatórios. Criptografa tokens dos bots e chaves dos gateways. */
  APP_SECRET: z.string().min(32),
  /** Endereço público deste serviço (webhooks do Telegram e dos gateways). Ex.: https://api.botly.com.br */
  PUBLIC_URL: z.string().url(),
  /** Papel do serviço: api (bots + webhooks + tarefas), panel (painel) ou admin (super admin). */
  BOTLY_ROLE: z.enum(["api", "panel", "admin"]).default("api"),
  LOG_LEVEL: z.string().default("info"),
});

export type Env = z.infer<typeof envSchema>;

let cached: Env | undefined;
export function env(): Env {
  cached ??= envSchema.parse(process.env);
  return cached;
}
