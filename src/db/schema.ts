// Esquema do banco do Botly.
//
// Regras que guiam o desenho:
// - Multi-conta: quase tudo pertence a uma conta (account). Cada conta é um cliente
//   do Botly; a conta do dono tem taxa 0.
// - O CANAL é da conta, não do bot: vários bots podem vender o mesmo canal.
// - O ACESSO é por cliente + canal (um vencimento só por canal), não por bot.
// - Cada venda guarda qual bot vendeu (métricas e ranking por bot).
// - Valores sempre em centavos. Datas com fuso (timestamptz); "hoje" é calculado
//   no fuso da conta (padrão America/Sao_Paulo).
import { sql } from "drizzle-orm";
import {
  customType,
  bigint,
  bigserial,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type {
  AccountSettings,
  BotRecovery,
  BroadcastAudience,
  BroadcastContent,
  BotRouting,
  BotUpsell,
  BotWelcome,
  OrderItem,
  TemplateButton,
  TemplateMedia,
} from "../domain/types.js";

const id = () => uuid("id").primaryKey().defaultRandom();
const ts = (name: string) => timestamp(name, { withTimezone: true });
const createdAt = () => ts("created_at").notNull().defaultNow();
const updatedAt = () => ts("updated_at").notNull().defaultNow();
const accountId = () =>
  uuid("account_id")
    .notNull()
    .references(() => accounts.id, { onDelete: "cascade" });
/** IDs do Telegram cabem em número do JS (< 2^53). */
const tgId = (name: string) => bigint(name, { mode: "number" });

// ───────────────────────── Plataforma ─────────────────────────

/** Uma conta = um cliente do Botly (ou a conta do próprio dono). */
export const accounts = pgTable("accounts", {
  id: id(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  status: text("status", { enum: ["active", "suspended"] }).notNull().default("active"),
  /** Taxa da plataforma por venda, em centésimos de % (250 = 2,5%). 0 na conta do dono. */
  platformFeeBps: integer("platform_fee_bps").notNull().default(0),
  settings: jsonb("settings").$type<AccountSettings>().notNull().default({}),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/** Quem entra no painel de uma conta. */
export const users = pgTable(
  "users",
  {
    id: id(),
    accountId: accountId(),
    email: text("email").notNull(),
    name: text("name").notNull(),
    passwordHash: text("password_hash").notNull(),
    role: text("role", { enum: ["owner", "admin", "operator"] }).notNull().default("owner"),
    /** Nome que aparece para o cliente no atendimento ("Talyson: ..."). */
    supportName: text("support_name"),
    active: boolean("active").notNull().default(true),
    lastLoginAt: ts("last_login_at"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("users_email").on(sql`lower(${t.email})`)],
);

/** Super admin: login separado, em outro endereço. Vê todas as contas e o split. */
export const superAdmins = pgTable(
  "super_admins",
  {
    id: id(),
    email: text("email").notNull(),
    name: text("name").notNull(),
    passwordHash: text("password_hash").notNull(),
    active: boolean("active").notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("super_admins_email").on(sql`lower(${t.email})`)],
);

/** Sessões do painel e do super admin (guardamos só o hash do token). */
export const sessions = pgTable("sessions", {
  tokenHash: text("token_hash").primaryKey(),
  kind: text("kind", { enum: ["user", "super"] }).notNull(),
  userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
  superAdminId: uuid("super_admin_id").references(() => superAdmins.id, { onDelete: "cascade" }),
  expiresAt: ts("expires_at").notNull(),
  createdAt: createdAt(),
});

// ───────────────────────── Pagamento ─────────────────────────

/** Formas de pagamento cadastradas na conta (cada bot escolhe quais usar). */
export const gateways = pgTable(
  "gateways",
  {
    id: id(),
    accountId: accountId(),
    provider: text("provider", { enum: ["pushinpay", "paggone"] }).notNull(),
    /** Nome que o dono vê ("PushinPay principal"). */
    label: text("label").notNull(),
    /** Credenciais criptografadas (AES-256-GCM, lib/crypto). */
    secret: text("secret").notNull(),
    config: jsonb("config").$type<{ sandbox?: boolean; baseUrl?: string | null }>().notNull().default({}),
    /** Vai na URL do webhook para conferir que o aviso é nosso. */
    webhookToken: text("webhook_token").notNull(),
    active: boolean("active").notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [index("gateways_account").on(t.accountId)],
);

// ───────────────────────── Bots, canais e ofertas ─────────────────────────

export const bots = pgTable(
  "bots",
  {
    id: id(),
    accountId: accountId(),
    telegramBotId: tgId("telegram_bot_id").notNull(),
    username: text("username").notNull(),
    name: text("name").notNull(),
    /** Token do BotFather, criptografado. */
    tokenEnc: text("token_enc").notNull(),
    /** Segredo que o Telegram devolve no cabeçalho do webhook. */
    webhookSecret: text("webhook_secret").notNull(),
    status: text("status", { enum: ["active", "paused", "error"] }).notNull().default("active"),
    statusDetail: text("status_detail"),
    /** Canal que o bot vende por padrão (os outros só como extra ou pacote). */
    mainChannelId: uuid("main_channel_id").references(() => channels.id, { onDelete: "set null" }),
    welcome: jsonb("welcome").$type<BotWelcome>().notNull().default({ text: "" }),
    /** Canal gratuito de prévias (botão na boas-vindas). */
    previewUrl: text("preview_url"),
    previewButton: text("preview_button"),
    routing: jsonb("routing").$type<BotRouting>().notNull().default({ mode: "alternar", gatewayIds: [] }),
    upsell: jsonb("upsell").$type<BotUpsell>().notNull().default({}),
    recovery: jsonb("recovery").$type<BotRecovery>().notNull().default({}),
    showBundles: boolean("show_bundles").notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("bots_telegram_id").on(t.telegramBotId), index("bots_account").on(t.accountId)],
);

/** Canal ou grupo VIP. Pertence à conta; vários bots podem vendê-lo. */
export const channels = pgTable(
  "channels",
  {
    id: id(),
    accountId: accountId(),
    telegramChatId: tgId("telegram_chat_id").notNull(),
    title: text("title").notNull(),
    /** Nome que o cliente vê nas mensagens do bot (o título no Telegram pode ser discreto). */
    displayName: text("display_name"),
    type: text("type", { enum: ["channel", "supergroup", "group"] }).notNull(),
    /** Bot que cria o link, aprova as entradas e remove quem venceu. */
    managerBotId: uuid("manager_bot_id").references((): any => bots.id, { onDelete: "set null" }),
    /** Link com "pedir aprovação" criado pelo bot gestor. */
    inviteLink: text("invite_link"),
    /** Preço padrão quando o canal é oferecido como extra (upsell). */
    extraPriceCents: integer("extra_price_cents"),
    /** Permissões do bot gestor conferidas no último teste. */
    rightsCheckedAt: ts("rights_checked_at"),
    rightsOk: boolean("rights_ok").notNull().default(false),
    active: boolean("active").notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("channels_account_chat").on(t.accountId, t.telegramChatId)],
);

/** Planos de um bot (dão acesso ao canal principal do bot). */
export const plans = pgTable(
  "plans",
  {
    id: id(),
    accountId: accountId(),
    botId: uuid("bot_id")
      .notNull()
      .references(() => bots.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /** lifetime = vitalício (sem vencimento). */
    durationUnit: text("duration_unit", { enum: ["day", "month", "year", "lifetime"] }).notNull(),
    durationValue: integer("duration_value").notNull().default(1),
    priceCents: integer("price_cents").notNull(),
    sortOrder: integer("sort_order").notNull().default(0),
    /** Destaque visual ("mais vendido"). */
    highlight: boolean("highlight").notNull().default(false),
    active: boolean("active").notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [index("plans_bot").on(t.botId)],
);

/** Pacotes promocionais da conta: vários canais por um preço fechado. */
export const bundles = pgTable("bundles", {
  id: id(),
  accountId: accountId(),
  name: text("name").notNull(),
  description: text("description"),
  durationUnit: text("duration_unit", { enum: ["day", "month", "year", "lifetime"] }).notNull(),
  durationValue: integer("duration_value").notNull().default(1),
  priceCents: integer("price_cents").notNull(),
  sortOrder: integer("sort_order").notNull().default(0),
  active: boolean("active").notNull().default(true),
  createdAt: createdAt(),
});

export const bundleChannels = pgTable(
  "bundle_channels",
  {
    bundleId: uuid("bundle_id")
      .notNull()
      .references(() => bundles.id, { onDelete: "cascade" }),
    channelId: uuid("channel_id")
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.bundleId, t.channelId] })],
);

// ───────────────────────── Clientes e funil ─────────────────────────

/** Pessoa do Telegram, única por conta (o mesmo ID vale para todos os bots). */
export const customers = pgTable(
  "customers",
  {
    id: id(),
    accountId: accountId(),
    telegramUserId: tgId("telegram_user_id").notNull(),
    username: text("username"),
    firstName: text("first_name"),
    lastName: text("last_name"),
    /** Origem do primeiro contato (?start=origem). */
    source: text("source"),
    /** Etapa mais avançada do funil já alcançada. */
    funnelStage: text("funnel_stage", {
      enum: ["started", "viewed_plans", "chose_plan", "pix_generated", "paid", "joined"],
    })
      .notNull()
      .default("started"),
    ageConfirmedAt: ts("age_confirmed_at"),
    totalSpentCents: integer("total_spent_cents").notNull().default(0),
    purchases: integer("purchases").notNull().default(0),
    notes: text("notes"),
    /** Veio da importação de outro gerenciador. */
    imported: boolean("imported").notNull().default(false),
    firstSeenAt: createdAt(),
    lastSeenAt: ts("last_seen_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("customers_account_tg").on(t.accountId, t.telegramUserId),
    index("customers_account_stage").on(t.accountId, t.funnelStage),
  ],
);

/** Em quais bots a pessoa deu /start (só esses bots podem mandar mensagem a ela). */
export const customerBots = pgTable(
  "customer_bots",
  {
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "cascade" }),
    botId: uuid("bot_id")
      .notNull()
      .references(() => bots.id, { onDelete: "cascade" }),
    startedAt: createdAt(),
    lastInteractionAt: ts("last_interaction_at").notNull().defaultNow(),
    /** false quando a pessoa bloqueou o bot (o envio falha com 403). */
    canMessage: boolean("can_message").notNull().default(true),
    source: text("source"),
    /** Última mensagem de planos/pacotes que o bot mandou: ao mandar uma nova, a anterior é apagada (preços podem ter mudado). */
    catalogMsgId: integer("catalog_msg_id"),
  },
  (t) => [primaryKey({ columns: [t.customerId, t.botId] }), index("customer_bots_bot").on(t.botId)],
);

/** Linha do tempo do cliente e base das métricas de conversão. */
export const events = pgTable(
  "events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    accountId: accountId(),
    botId: uuid("bot_id").references(() => bots.id, { onDelete: "set null" }),
    customerId: uuid("customer_id").references(() => customers.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    meta: jsonb("meta").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [
    index("events_account_type_time").on(t.accountId, t.type, t.createdAt),
    index("events_customer_time").on(t.customerId, t.createdAt),
  ],
);

// ───────────────────────── Vendas ─────────────────────────

/** Pedido: o que o cliente está comprando (plano, extras, pacote). */
export const orders = pgTable(
  "orders",
  {
    id: id(),
    accountId: accountId(),
    botId: uuid("bot_id").references(() => bots.id, { onDelete: "set null" }),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: ["new", "renewal", "upsell", "bundle", "recovery"] }).notNull(),
    items: jsonb("items").$type<OrderItem[]>().notNull(),
    subtotalCents: integer("subtotal_cents").notNull(),
    discountCents: integer("discount_cents").notNull().default(0),
    totalCents: integer("total_cents").notNull(),
    status: text("status", { enum: ["pending", "paid", "expired", "canceled", "refunded"] }).notNull().default("pending"),
    /** Etapa da recuperação de Pix já enviada (0 = nenhuma). */
    recoveryStep: integer("recovery_step").notNull().default(0),
    source: text("source"),
    createdAt: createdAt(),
    paidAt: ts("paid_at"),
  },
  (t) => [
    index("orders_account_status_time").on(t.accountId, t.status, t.createdAt),
    index("orders_customer").on(t.customerId),
    index("orders_bot_time").on(t.botId, t.createdAt),
  ],
);

/** Cobrança Pix num gateway. Um pedido pode ter mais de uma (banco reserva). */
export const charges = pgTable(
  "charges",
  {
    id: id(),
    accountId: accountId(),
    orderId: uuid("order_id")
      .notNull()
      .references(() => orders.id, { onDelete: "cascade" }),
    gatewayId: uuid("gateway_id").references(() => gateways.id, { onDelete: "set null" }),
    provider: text("provider").notNull(),
    providerTxId: text("provider_tx_id"),
    amountCents: integer("amount_cents").notNull(),
    pixCode: text("pix_code"),
    /** Mensagens do Pix no chat (QR e código): apagadas ao gerar outro Pix ou ao confirmar. */
    chatMessageIds: jsonb("chat_message_ids").$type<number[]>().notNull().default([]),
    status: text("status", { enum: ["pending", "paid", "expired", "failed", "refunded"] }).notNull().default("pending"),
    /** Taxa da plataforma desta cobrança (split). Gravada mesmo quando é 0. */
    platformFeeCents: integer("platform_fee_cents").notNull().default(0),
    expiresAt: ts("expires_at"),
    paidAt: ts("paid_at"),
    raw: jsonb("raw").$type<unknown>(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("charges_provider_tx").on(t.provider, t.providerTxId),
    index("charges_account_status_time").on(t.accountId, t.status, t.createdAt),
    index("charges_order").on(t.orderId),
  ],
);

/** Acesso de um cliente a um canal: UM vencimento por cliente + canal. */
export const accesses = pgTable(
  "accesses",
  {
    id: id(),
    accountId: accountId(),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "cascade" }),
    channelId: uuid("channel_id")
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    status: text("status", { enum: ["active", "expired", "removed"] }).notNull().default("active"),
    /** null = vitalício. */
    expiresAt: ts("expires_at"),
    /** Plano atual (para mostrar na lista e oferecer na renovação). */
    planId: uuid("plan_id").references(() => plans.id, { onDelete: "set null" }),
    /** Valor do último pagamento deste acesso (renovação sugerida). */
    lastPriceCents: integer("last_price_cents"),
    /** Bot da última compra: é por ele que saem os lembretes. */
    billingBotId: uuid("billing_bot_id").references(() => bots.id, { onDelete: "set null" }),
    lastOrderId: uuid("last_order_id").references(() => orders.id, { onDelete: "set null" }),
    source: text("source", { enum: ["purchase", "import", "manual"] }).notNull().default("purchase"),
    joinedAt: ts("joined_at"),
    removedAt: ts("removed_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("accesses_customer_channel").on(t.customerId, t.channelId),
    index("accesses_account_status_exp").on(t.accountId, t.status, t.expiresAt),
  ],
);

/** Recusas de oferta (para não repetir o mesmo upsell dentro do prazo). */
export const offerDeclines = pgTable(
  "offer_declines",
  {
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "cascade" }),
    channelId: uuid("channel_id")
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    declinedAt: ts("declined_at").notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.customerId, t.channelId] })],
);

// ───────────────────────── Lembretes e retenção ─────────────────────────

/** Modelos de mensagem. botId nulo = padrão da conta; com botId = só daquele bot. */
export const templates = pgTable(
  "templates",
  {
    id: id(),
    accountId: accountId(),
    botId: uuid("bot_id").references(() => bots.id, { onDelete: "cascade" }),
    /** reminder (lembrete de vencimento), winback (depois do corte) ou recovery (Pix não pago). */
    kind: text("kind", { enum: ["reminder", "winback", "recovery"] }).notNull(),
    /** Minutos em relação ao vencimento (−4320 = 3 dias antes) ou à criação do Pix. */
    offsetMinutes: integer("offset_minutes").notNull(),
    text: text("text").notNull(),
    media: jsonb("media").$type<TemplateMedia | null>(),
    buttons: jsonb("buttons").$type<TemplateButton[]>().notNull().default([]),
    /** Desconto oferecido nesta mensagem (recuperação e "volte"), em %. */
    discountPct: integer("discount_pct").notNull().default(0),
    enabled: boolean("enabled").notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [index("templates_account_kind").on(t.accountId, t.kind)],
);

/** Fila de envios (lembretes, recuperação, "volte"). É o que a página Retenção mostra. */
export const outbox = pgTable(
  "outbox",
  {
    id: id(),
    accountId: accountId(),
    botId: uuid("bot_id").references(() => bots.id, { onDelete: "set null" }),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "cascade" }),
    accessId: uuid("access_id").references(() => accesses.id, { onDelete: "cascade" }),
    orderId: uuid("order_id").references(() => orders.id, { onDelete: "cascade" }),
    templateId: uuid("template_id").references(() => templates.id, { onDelete: "set null" }),
    /** Evita mandar o mesmo aviso duas vezes no mesmo ciclo (ex.: acesso + vencimento). */
    dedupeKey: text("dedupe_key").notNull(),
    scheduledFor: ts("scheduled_for").notNull(),
    /** Valor esperado se o cliente renovar (soma da coluna na Retenção). */
    expectedCents: integer("expected_cents").notNull().default(0),
    status: text("status", { enum: ["scheduled", "sending", "sent", "failed", "skipped"] }).notNull().default("scheduled"),
    /** O que aconteceu depois: renovou, renovou com upsell, ou nada. */
    outcome: text("outcome", { enum: ["renewed", "renewed_upsell", "none"] }),
    error: text("error"),
    sentAt: ts("sent_at"),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("outbox_dedupe").on(t.accountId, t.dedupeKey),
    index("outbox_account_status_when").on(t.accountId, t.status, t.scheduledFor),
  ],
);

/** Transmissões (mailing): mensagem em massa pelo bot, com filtro de público e agendamento. */
export const broadcasts = pgTable(
  "broadcasts",
  {
    id: id(),
    accountId: accountId(),
    name: text("name").notNull(),
    status: text("status", { enum: ["scheduled", "sending", "done", "canceled"] }).notNull().default("scheduled"),
    /** Bots que enviam (cada pessoa recebe uma vez só, pelo bot em que falou por último). */
    botIds: jsonb("bot_ids").$type<string[]>().notNull().default([]),
    audience: jsonb("audience").$type<BroadcastAudience>().notNull(),
    content: jsonb("content").$type<BroadcastContent>().notNull(),
    scheduledAt: ts("scheduled_at").notNull(),
    startedAt: ts("started_at"),
    finishedAt: ts("finished_at"),
    createdAt: createdAt(),
  },
  (t) => [index("broadcasts_account_status").on(t.accountId, t.status, t.scheduledAt)],
);

export const broadcastRecipients = pgTable(
  "broadcast_recipients",
  {
    id: id(),
    broadcastId: uuid("broadcast_id")
      .notNull()
      .references(() => broadcasts.id, { onDelete: "cascade" }),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "cascade" }),
    botId: uuid("bot_id")
      .notNull()
      .references(() => bots.id, { onDelete: "cascade" }),
    status: text("status", { enum: ["pending", "sending", "sent", "failed", "blocked"] }).notNull().default("pending"),
    error: text("error"),
    sentAt: ts("sent_at"),
  },
  (t) => [uniqueIndex("broadcast_recipients_one").on(t.broadcastId, t.customerId), index("broadcast_recipients_status").on(t.broadcastId, t.status)],
);

// ───────────────────────── Importação e auditoria ─────────────────────────

export const imports = pgTable("imports", {
  id: id(),
  accountId: accountId(),
  botId: uuid("bot_id").references(() => bots.id, { onDelete: "set null" }),
  channelId: uuid("channel_id").references(() => channels.id, { onDelete: "set null" }),
  fileName: text("file_name").notNull(),
  /** Sistema de onde veio (id em domain/import-sources.ts). */
  source: text("source").notNull().default("automatizzebot"),
  status: text("status", { enum: ["preview", "done", "failed"] }).notNull().default("preview"),
  /** Contagens: linhas, clientes, ativos, vencidos, ignorados... */
  stats: jsonb("stats").$type<Record<string, number>>().notNull().default({}),
  createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: createdAt(),
});

export const auditLog = pgTable(
  "audit_log",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    accountId: uuid("account_id").references(() => accounts.id, { onDelete: "cascade" }),
    userId: uuid("user_id"),
    superAdminId: uuid("super_admin_id"),
    action: text("action").notNull(),
    meta: jsonb("meta").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [index("audit_account_time").on(t.accountId, t.createdAt)],
);

const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => "bytea" });

/** Imagens e vídeos enviados pelo painel (boas-vindas, lembretes). */
export const media = pgTable(
  "media",
  {
    id: id(),
    accountId: accountId(),
    kind: text("kind", { enum: ["photo", "video", "animation"] }).notNull(),
    mime: text("mime").notNull(),
    fileName: text("file_name").notNull(),
    size: integer("size").notNull(),
    data: bytea("data").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("media_account").on(t.accountId)],
);

/** Conversa de atendimento (uma aberta por cliente + bot). */
export const supportTickets = pgTable(
  "support_tickets",
  {
    id: id(),
    accountId: accountId(),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "cascade" }),
    botId: uuid("bot_id").references(() => bots.id, { onDelete: "set null" }),
    /** open = aguardando atendente; active = em atendimento; closed = encerrada. */
    status: text("status", { enum: ["open", "active", "closed"] }).notNull().default("open"),
    assignedUserId: uuid("assigned_user_id").references(() => users.id, { onDelete: "set null" }),
    agentName: text("agent_name"),
    /** Assunto escolhido no menu (dúvida antes de comprar, não consegue entrar...). */
    topic: text("topic"),
    unread: integer("unread").notNull().default(0),
    lastMessageAt: ts("last_message_at").notNull().defaultNow(),
    createdAt: createdAt(),
    closedAt: ts("closed_at"),
  },
  (t) => [index("support_account_status").on(t.accountId, t.status, t.lastMessageAt), index("support_customer").on(t.customerId)],
);

export const supportMessages = pgTable(
  "support_messages",
  {
    id: id(),
    ticketId: uuid("ticket_id")
      .notNull()
      .references(() => supportTickets.id, { onDelete: "cascade" }),
    accountId: accountId(),
    sender: text("sender", { enum: ["customer", "agent", "system"] }).notNull(),
    text: text("text"),
    /** Foto/arquivo do cliente: file_id do Telegram (no bot da conversa). */
    mediaType: text("media_type", { enum: ["photo", "document", "video", "voice"] }),
    tgFileId: text("tg_file_id"),
    agentName: text("agent_name"),
    createdAt: createdAt(),
  },
  (t) => [index("support_messages_ticket").on(t.ticketId, t.createdAt)],
);
