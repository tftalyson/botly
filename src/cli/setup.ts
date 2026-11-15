// Configuração pelo Console do Easypanel enquanto o painel não fica pronto.
// Uso: node dist/cli/setup.js <comando> [...]
//   conta "Nome da conta"                         cria a conta (taxa 0)
//   gateway pushinpay "Apelido"                    pede o token e cadastra (vale para a 1ª conta)
//   bot                                            pede o token do BotFather e cadastra
//   canal @usuario_do_bot <id do canal>            cadastra o canal com esse bot gestor e define como canal principal
//   plano @usuario_do_bot "Nome" <dia|mes|ano|vitalicio> <quantidade> <preço ex. 24,90> [destaque]
//   pagamento @usuario_do_bot <fixed|alternar|equilibrar|limite> "Apelido1" ["Apelido2"...]
//   boasvindas @usuario_do_bot "texto" [url da imagem ou vídeo]
//   previas @usuario_do_bot <link> ["texto do botão"]
//   avisos <id do canal de avisos>
//   clientes                                       últimos clientes (ID, usuário, acessos)
//   remover @usuario_do_bot <ID ou @usuario do cliente>   tira o cliente do canal principal do bot (ele pode voltar se pagar)
//   testar-lembrete @usuario_do_bot <ID ou @usuario do cliente> [dias]
//                                                  manda AGORA a mensagem daquele dia (-3, -1, 0 = antes/no dia; 1, 7 = volte)
//   listar
import { randomBytes } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { and, desc, eq, ilike } from "drizzle-orm";
import { createDb } from "../db/client.js";
import { runMigrations } from "../db/migrate.js";
import * as s from "../db/schema.js";
import type { Ctx } from "../domain/context.js";
import { registerBot, registerChannel } from "../domain/setup.js";
import { removeFromChannel } from "../domain/removal.js";
import { ensureTemplates, sendDue } from "../domain/retention.js";
import { createRuntime } from "../bot/runtime.js";
import { encryptJson } from "../lib/crypto.js";
import { log } from "../lib/log.js";
import { brl } from "../lib/money.js";
import { apiForToken } from "../bot/api.js";
import { botToken } from "../bot/runtime.js";

const url = process.env.DATABASE_URL!;
const appSecret = process.env.APP_SECRET!;
const publicUrl = process.env.PUBLIC_URL!;
if (!url || !appSecret || !publicUrl) {
  console.error("Faltam DATABASE_URL, APP_SECRET ou PUBLIC_URL (rode no Console do serviço do Botly).");
  process.exit(1);
}
await runMigrations(url);
const { db, sql } = createDb(url);
const ctx: Ctx = { db, appSecret, publicUrl, fetch, now: () => new Date(), log };

async function ask(q: string) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const a = await rl.question(q);
  rl.close();
  return a.trim();
}
async function account() {
  const a = (await db.select().from(s.accounts).limit(1))[0];
  if (!a) throw new Error('Crie a conta antes: node dist/cli/setup.js conta "Nome"');
  return a;
}
async function botBy(username: string) {
  const b = (await db.select().from(s.bots).where(ilike(s.bots.username, username.replace(/^@/, ""))))[0];
  if (!b) throw new Error(`Bot ${username} não cadastrado.`);
  return b;
}
const cents = (v: string) => Math.round(Number(v.replace(/\./g, "").replace(",", ".")) * 100);

const [cmd, ...args] = process.argv.slice(2);
try {
  switch (cmd) {
    case "conta": {
      const name = args[0] ?? "Minha conta";
      const slug = name.toLowerCase().normalize("NFD").replace(/[^\w]+/g, "-").replace(/^-|-$/g, "") || "conta";
      const [a] = await db.insert(s.accounts).values({ name, slug, platformFeeBps: 0, settings: { timezone: "America/Sao_Paulo", ageGate: true, autoRemove: false } }).returning();
      console.log(`✅ Conta criada: ${a!.name}`);
      break;
    }
    case "gateway": {
      const a = await account();
      const provider = args[0] as "pushinpay" | "paggone";
      if (provider !== "pushinpay" && provider !== "paggone") throw new Error("Use: gateway pushinpay \"Apelido\"");
      const label = args[1] ?? provider;
      const key = await ask(provider === "pushinpay" ? "Cole o token da PushinPay: " : "Cole a chave da API da Paggone: ");
      const secret = encryptJson(provider === "pushinpay" ? { token: key } : { apiKey: key }, appSecret);
      await db.insert(s.gateways).values({ accountId: a.id, provider, label, secret, webhookToken: randomBytes(16).toString("hex") });
      console.log(`✅ Gateway "${label}" cadastrado. Ligue no bot com: pagamento @bot alternar "${label}"`);
      break;
    }
    case "bot": {
      const a = await account();
      const token = await ask("Cole o token do bot (do @BotFather): ");
      const b = await registerBot(ctx, a.id, token);
      console.log(`✅ Bot @${b.username} cadastrado e conectado.`);
      console.log(`   Agora adicione o @${b.username} como ADMINISTRADOR do canal VIP (em canal, com "Adicionar inscritos" ligado; em grupo, com "Convidar usuários via link" e "Banir usuários").`);
      break;
    }
    case "canal": {
      const b = await botBy(args[0] ?? "");
      const ref = args[1] ?? "";
      const api = apiForToken(botToken(b, appSecret));
      const { channel, rights } = await registerChannel(ctx, b, api, /^-?\d+$/.test(ref) ? Number(ref) : ref);
      await db.update(s.bots).set({ mainChannelId: channel.id }).where(eq(s.bots.id, b.id));
      console.log(rights.ok ? `✅ Canal "${channel.title}" pronto (gestor: @${b.username}). Link com aprovação: ${channel.inviteLink}` : `⚠️ Canal "${channel.title}" cadastrado, mas falta permissão: ${rights.missing.join(", ")}. Ajuste e rode de novo.`);
      break;
    }
    case "plano": {
      const b = await botBy(args[0] ?? "");
      const [name, unitRaw, qty, price, hl] = args.slice(1);
      const unit = ({ dia: "day", dias: "day", mes: "month", meses: "month", ano: "year", anos: "year", vitalicio: "lifetime" } as const)[unitRaw as "dia"];
      if (!name || !unit || !price) throw new Error('Use: plano @bot "Mensal" mes 1 24,90');
      const count = (await db.select().from(s.plans).where(eq(s.plans.botId, b.id))).length;
      await db.insert(s.plans).values({ accountId: b.accountId, botId: b.id, name, durationUnit: unit, durationValue: Number(qty) || 1, priceCents: cents(price), sortOrder: count, highlight: hl === "destaque" });
      console.log(`✅ Plano "${name}" — ${brl(cents(price))} criado no @${b.username}.`);
      break;
    }
    case "pagamento": {
      const b = await botBy(args[0] ?? "");
      const mode = args[1] as "fixed" | "alternar" | "equilibrar" | "limite";
      const labels = args.slice(2);
      const gws = await db.select().from(s.gateways).where(eq(s.gateways.accountId, b.accountId));
      const ids = labels.map((l) => gws.find((g) => g.label.toLowerCase() === l.toLowerCase())?.id).filter((x): x is string => !!x);
      if (!ids.length) throw new Error(`Nenhum gateway com esses apelidos. Cadastrados: ${gws.map((g) => g.label).join(", ") || "nenhum"}`);
      await db.update(s.bots).set({ routing: { mode: mode || "alternar", gatewayIds: ids } }).where(eq(s.bots.id, b.id));
      console.log(`✅ @${b.username} vai cobrar por: ${labels.join(", ")} (${mode}).`);
      break;
    }
    case "boasvindas": {
      const b = await botBy(args[0] ?? "");
      const text = args[1] ?? "";
      const media = args[2] ? { type: /\.(mp4|mov|webm)(\?|$)/i.test(args[2]) ? ("video" as const) : ("photo" as const), url: args[2] } : null;
      await db.update(s.bots).set({ welcome: { text, media } }).where(eq(s.bots.id, b.id));
      console.log("✅ Boas-vindas atualizada.");
      break;
    }
    case "previas": {
      const b = await botBy(args[0] ?? "");
      await db.update(s.bots).set({ previewUrl: args[1] ?? null, previewButton: args[2] ?? null }).where(eq(s.bots.id, b.id));
      console.log("✅ Canal de prévias atualizado.");
      break;
    }
    case "avisos": {
      const a = await account();
      await db.update(s.accounts).set({ settings: { ...a.settings, notifyChatId: Number(args[0]) } }).where(eq(s.accounts.id, a.id));
      console.log("✅ Canal de avisos de venda definido (o bot precisa ser admin dele).");
      break;
    }
    case "clientes": {
      const a = await account();
      const rows = await db.select().from(s.customers).where(eq(s.customers.accountId, a.id)).orderBy(desc(s.customers.lastSeenAt)).limit(20);
      const chans = await db.select().from(s.channels).where(eq(s.channels.accountId, a.id));
      for (const c of rows) {
        const accs = await db.select().from(s.accesses).where(eq(s.accesses.customerId, c.id));
        const info = accs.map((x) => `${chans.find((ch) => ch.id === x.channelId)?.title ?? "?"}: ${x.status}${x.expiresAt ? " até " + x.expiresAt.toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" }) : ""}`).join("; ");
        console.log(`  ${c.telegramUserId} ${c.username ? "@" + c.username : c.firstName ?? ""} · ${c.funnelStage} · ${brl(c.totalSpentCents)}${info ? " · " + info : ""}`);
      }
      if (!rows.length) console.log("  Nenhum cliente ainda.");
      break;
    }
    case "remover": {
      const b = await botBy(args[0] ?? "");
      const who = (args[1] ?? "").replace(/^@/, "");
      if (!who) throw new Error("Use: remover @bot <ID ou @usuario do cliente>");
      const ch = b.mainChannelId ? (await db.select().from(s.channels).where(eq(s.channels.id, b.mainChannelId)))[0] : undefined;
      if (!ch) throw new Error("Esse bot não tem canal principal.");
      const cust = (
        await db
          .select()
          .from(s.customers)
          .where(and(eq(s.customers.accountId, b.accountId), /^\d+$/.test(who) ? eq(s.customers.telegramUserId, Number(who)) : ilike(s.customers.username, who)))
      )[0];
      if (!cust) throw new Error(`Cliente ${args[1]} não encontrado. Veja a lista com: clientes`);
      const manager = ch.managerBotId ? (await db.select().from(s.bots).where(eq(s.bots.id, ch.managerBotId)))[0]! : b;
      await removeFromChannel(ctx, apiForToken(botToken(manager, appSecret)), { channel: ch, customer: cust, reason: "manual" });
      console.log(`✅ ${cust.username ? "@" + cust.username : cust.telegramUserId} removido do "${ch.title}". O acesso ficou como removido; se pagar de novo, volta.`);
      break;
    }
    case "testar-lembrete": {
      const b = await botBy(args[0] ?? "");
      const who = (args[1] ?? "").replace(/^@/, "");
      const days = args[2] !== undefined ? Number(args[2]) : -1;
      if (!who || !Number.isFinite(days)) throw new Error("Use: testar-lembrete @bot <ID ou @usuario do cliente> [dias]");
      const cust = (
        await db
          .select()
          .from(s.customers)
          .where(and(eq(s.customers.accountId, b.accountId), /^\d+$/.test(who) ? eq(s.customers.telegramUserId, Number(who)) : ilike(s.customers.username, who)))
      )[0];
      if (!cust) throw new Error(`Cliente ${args[1]} não encontrado. Veja a lista com: clientes`);
      const acc = (await db.select().from(s.accesses).where(and(eq(s.accesses.customerId, cust.id), eq(s.accesses.channelId, b.mainChannelId ?? ""))))[0];
      if (!acc) throw new Error("Esse cliente não tem acesso ao canal principal deste bot (precisa ter comprado).");
      const tpls = await ensureTemplates(ctx, b.accountId);
      const tpl = tpls.find((x) => Math.round(x.offsetMinutes / 1440) === days);
      if (!tpl) throw new Error(`Não há mensagem para ${days} dia(s). Existentes: ${tpls.map((x) => Math.round(x.offsetMinutes / 1440)).join(", ")}`);
      if (tpl.kind === "reminder" && acc.status !== "active") throw new Error("O acesso desse cliente não está ativo (lembrete de antes de vencer só vai para ativos). Teste com dias 1 ou 7 (volte).");
      await db.insert(s.outbox).values({ accountId: b.accountId, botId: b.id, customerId: cust.id, accessId: acc.id, templateId: tpl.id, dedupeKey: `teste:${Date.now()}`, scheduledFor: new Date(), expectedCents: acc.lastPriceCents ?? 0 });
      await sendDue(ctx, createRuntime(ctx));
      const last = (await db.select().from(s.outbox).where(eq(s.outbox.customerId, cust.id)).orderBy(desc(s.outbox.createdAt)).limit(1))[0]!;
      console.log(last.status === "sent" ? `✅ Mensagem de ${days} dia(s) enviada para ${cust.username ? "@" + cust.username : cust.telegramUserId}.` : `⚠️ Não enviada: ${last.error ?? last.status}`);
      break;
    }
    case "listar": {
      const a = await account();
      console.log(`Conta: ${a.name}`);
      for (const g of await db.select().from(s.gateways).where(eq(s.gateways.accountId, a.id))) console.log(`  Gateway: ${g.label} (${g.provider})`);
      const chans = await db.select().from(s.channels).where(eq(s.channels.accountId, a.id));
      for (const c of chans) console.log(`  Canal: ${c.title} [${c.telegramChatId}] ${c.rightsOk ? "✅" : "⚠️ sem permissão"}`);
      for (const b of await db.select().from(s.bots).where(eq(s.bots.accountId, a.id))) {
        const main = chans.find((c) => c.id === b.mainChannelId);
        console.log(`  Bot @${b.username} → ${main?.title ?? "sem canal"} · pagamento: ${b.routing.mode} (${b.routing.gatewayIds.length})`);
        for (const p of await db.select().from(s.plans).where(eq(s.plans.botId, b.id))) console.log(`      ${p.name} — ${brl(p.priceCents)}`);
      }
      break;
    }
    default:
      console.log("Comandos: conta, gateway, bot, canal, plano, pagamento, boasvindas, previas, avisos, clientes, remover, testar-lembrete, listar");
  }
} catch (err) {
  console.error("❌ " + (err as Error).message);
  process.exitCode = 1;
} finally {
  await sql.end();
}
