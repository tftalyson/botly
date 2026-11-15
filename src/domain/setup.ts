// Cadastro de bots e canais (usado pelo painel e pelo próprio bot).
import { randomBytes } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { Api, Transformer } from "grammy";
import * as s from "../db/schema.js";
import { encryptJson } from "../lib/crypto.js";
import { apiForToken } from "../bot/api.js";
import type { Ctx } from "./context.js";

export const ALLOWED_UPDATES = ["message", "callback_query", "chat_join_request", "my_chat_member"] as const;

export class SetupError extends Error {}

/**
 * Cadastra um bot pelo token do BotFather: confere o token, grava criptografado
 * e liga o webhook. Se o bot já existe (mesmo ID), atualiza o token.
 */
export async function registerBot(ctx: Ctx, accountId: string, token: string, opts: { transformer?: Transformer } = {}) {
  const t = token.trim();
  if (!/^\d+:[\w-]{30,}$/.test(t)) throw new SetupError("Token inválido. Copie o token inteiro que o @BotFather mandou (números, dois-pontos e letras).");
  const api = apiForToken(t, opts.transformer);
  let me;
  try {
    me = await api.getMe();
  } catch {
    throw new SetupError("O Telegram não reconheceu esse token. Confira se copiou certo ou gere um novo no @BotFather (/token).");
  }
  const existing = (await ctx.db.select().from(s.bots).where(eq(s.bots.telegramBotId, me.id)))[0];
  if (existing && existing.accountId !== accountId) throw new SetupError("Este bot já está cadastrado em outra conta.");
  const webhookSecret = randomBytes(24).toString("hex");
  const tokenEnc = encryptJson({ token: t }, ctx.appSecret);
  const [row] = existing
    ? await ctx.db
        .update(s.bots)
        .set({ tokenEnc, webhookSecret, username: me.username, name: me.first_name, status: "active", statusDetail: null, updatedAt: ctx.now() })
        .where(eq(s.bots.id, existing.id))
        .returning()
    : await ctx.db
        .insert(s.bots)
        .values({ accountId, telegramBotId: me.id, username: me.username, name: me.first_name, tokenEnc, webhookSecret, welcome: { text: `Olá! Bem-vindo ao ${me.first_name}.` } })
        .returning();
  await api.setWebhook(`${ctx.publicUrl.replace(/\/+$/, "")}/tg/${row!.id}`, {
    secret_token: webhookSecret,
    allowed_updates: [...ALLOWED_UPDATES],
    drop_pending_updates: false,
  });
  await api.setMyCommands([
    { command: "start", description: "Início" },
    { command: "planos", description: "Ver planos" },
    { command: "meuplano", description: "Minha assinatura" },
  ]);
  return row!;
}

export interface RightsCheck {
  ok: boolean;
  missing: string[];
}

/** Confere se o bot é admin do canal com as permissões necessárias. */
export async function checkRights(api: Api, chatId: number, botTelegramId: number, isChannel = false): Promise<RightsCheck> {
  const m = await api.getChatMember(chatId, botTelegramId);
  if (m.status !== "administrator") return { ok: false, missing: ["ser administrador do canal"] };
  const missing: string[] = [];
  // No app, em canal o nome costuma ser "Adicionar inscritos"; em grupo, "Convidar usuários via link".
  if (!m.can_invite_users) missing.push(isChannel ? "adicionar inscritos (convidar via link)" : "convidar usuários via link");
  // Em canal o app não mostra a opção de banir: não dá para exigir. Em grupo é necessária.
  if (!isChannel && !m.can_restrict_members) missing.push("banir usuários");
  return { ok: missing.length === 0, missing };
}

/**
 * Cadastra (ou atualiza) um canal com este bot como gestor: confere as permissões
 * e cria o link com pedido de aprovação.
 */
export async function registerChannel(ctx: Ctx, bot: typeof s.bots.$inferSelect, api: Api, chatRef: number | string) {
  const chat = await api.getChat(chatRef);
  if (chat.type === "private") throw new SetupError("Isso é uma conversa privada, não um canal.");
  const type = chat.type === "channel" ? "channel" : chat.type === "supergroup" ? "supergroup" : "group";
  const title = "title" in chat && chat.title ? chat.title : String(chat.id);
  const rights = await checkRights(api, chat.id, bot.telegramBotId, chat.type === "channel");
  const existing = (await ctx.db.select().from(s.channels).where(and(eq(s.channels.accountId, bot.accountId), eq(s.channels.telegramChatId, chat.id))))[0];
  // Só o bot gestor cria o link (os outros bots apenas vendem o canal).
  const isManager = !existing?.managerBotId || existing.managerBotId === bot.id;
  let inviteLink: string | null = null;
  if (rights.ok && isManager) {
    const link = await api.createChatInviteLink(chat.id, { name: "Botly (aprovação)", creates_join_request: true });
    inviteLink = link.invite_link;
  }
  const values = {
    title,
    type: type as "channel" | "supergroup" | "group",
    ...(isManager ? { rightsOk: rights.ok, rightsCheckedAt: ctx.now() } : {}),
    ...(inviteLink ? { inviteLink } : {}),
  };
  const [row] = existing
    ? await ctx.db
        .update(s.channels)
        .set({ ...values, managerBotId: existing.managerBotId ?? bot.id })
        .where(eq(s.channels.id, existing.id))
        .returning()
    : await ctx.db.insert(s.channels).values({ accountId: bot.accountId, telegramChatId: chat.id, managerBotId: bot.id, ...values }).returning();
  return { channel: row!, rights };
}
