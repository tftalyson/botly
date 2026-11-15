// Mantém uma instância do grammY por bot cadastrado e entrega as atualizações
// que chegam pelo webhook (/tg/:botId) para os handlers.
import { Api, Bot, type Transformer } from "grammy";
import type { Update } from "grammy/types";
import { eq } from "drizzle-orm";
import * as s from "../db/schema.js";
import { decryptJson } from "../lib/crypto.js";
import type { Ctx } from "../domain/context.js";
import { installHandlers } from "./handlers.js";

export type BotRow = typeof s.bots.$inferSelect;

export interface BotlyRuntime {
  /** Entrega uma atualização do Telegram ao bot certo. */
  handle(botId: string, update: Update): Promise<void>;
  /** API do Telegram de um bot (para enviar avisos fora de uma conversa). */
  api(botId: string): Promise<Api>;
  /** Esquece a instância (token trocado, bot pausado). */
  forget(botId: string): void;
}

export function botToken(row: Pick<BotRow, "tokenEnc">, appSecret: string): string {
  return decryptJson<{ token: string }>(row.tokenEnc, appSecret).token;
}


export function createRuntime(ctx: Ctx, opts: { transformer?: Transformer } = {}): BotlyRuntime {
  const cache = new Map<string, { tokenEnc: string; bot: Bot }>();

  async function get(botId: string): Promise<{ row: BotRow; bot: Bot } | null> {
    const row = (await ctx.db.select().from(s.bots).where(eq(s.bots.id, botId)))[0];
    if (!row) return null;
    const hit = cache.get(botId);
    if (hit && hit.tokenEnc === row.tokenEnc) return { row, bot: hit.bot };
    const bot = new Bot(botToken(row, ctx.appSecret), {
      botInfo: {
        id: row.telegramBotId,
        is_bot: true,
        first_name: row.name,
        username: row.username,
        can_join_groups: true,
        can_read_all_group_messages: false,
        supports_inline_queries: false,
        can_connect_to_business: false,
        has_main_web_app: false,
      } as never,
    });
    if (opts.transformer) bot.api.config.use(opts.transformer);
    installHandlers(bot, ctx, row.id, runtime);
    bot.catch((err) => ctx.log.error({ botId, err: String(err.error) }, "erro no bot"));
    cache.set(botId, { tokenEnc: row.tokenEnc, bot });
    return { row, bot };
  }

  const runtime: BotlyRuntime = {
    async handle(botId, update) {
      const b = await get(botId);
      if (!b || b.row.status === "paused") return;
      await b.bot.handleUpdate(update);
    },
    async api(botId) {
      const b = await get(botId);
      if (!b) throw new Error("bot não encontrado");
      return b.bot.api;
    },
    forget(botId) {
      cache.delete(botId);
    },
  };
  return runtime;
}
