// Conversa do bot de vendas (docs/fluxo-bot.md).
// Dados dos botões (callback_data, máx. 64 bytes):
//   age:ok | age:no | plans | bundles | me
//   p:<planoId>            escolheu plano
//   bun:<pacoteId>         escolheu pacote
//   bump:y|n:<pedidoId>    aceitou/recusou o extra antes do Pix
//   chk:<cobrancaId>       "Já paguei"
//   new:<pedidoId>         "Gerar outro Pix" (outro gateway primeiro)
import { chName } from "../domain/channel-name.js";
import { and, asc, eq, gt, inArray, desc, sql } from "drizzle-orm";
import { InlineKeyboard, InputFile, type Bot, type Context } from "grammy";
import QRCode from "qrcode";
import * as s from "../db/schema.js";
import type { Ctx } from "../domain/context.js";
import { activeAccess, touchCustomer, type Customer } from "../domain/customers.js";
import { pickOrderBump, recordDecline } from "../domain/offers.js";
import { downsellFor, recoverySteps } from "../domain/recovery.js";
import { advanceFunnel, checkCharge, createOrder, createPixForOrder, logEvent, NoGatewayError, PIX_VALID_MINUTES } from "../domain/sales.js";
import { registerChannel } from "../domain/setup.js";
import type { OrderItem } from "../domain/types.js";
import { brl } from "../lib/money.js";
import { DEFAULT_TZ, durationLabel, fmtDate } from "../lib/time.js";
import { announcePaid } from "./notify.js";
import { closeTicket, isSupportOpen, offHoursText, openTicket, openTicketFor, addMessage } from "../domain/support.js";
import type { BotlyRuntime } from "./runtime.js";

export const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

type BotRow = typeof s.bots.$inferSelect;
type Account = typeof s.accounts.$inferSelect;
type Channel = typeof s.channels.$inferSelect;
type Plan = typeof s.plans.$inferSelect;

interface Loaded {
  bot: BotRow;
  account: Account;
  main: Channel | null;
  plans: Plan[];
  tz: string;
}

/** Clientes com um Pix sendo gerado agora (bot:usuário → até quando). */
const buying = new Map<string, number>();

/** Pedido igual, pendente e recente: reaproveita em vez de criar outro (e outro Pix). */
async function reusableOrder(ctx: Ctx, customerId: string, botId: string, match: (o: typeof s.orders.$inferSelect) => boolean) {
  const since = new Date(ctx.now().getTime() - PIX_VALID_MINUTES * 60_000);
  const rows = await ctx.db
    .select()
    .from(s.orders)
    .where(and(eq(s.orders.customerId, customerId), eq(s.orders.botId, botId), eq(s.orders.status, "pending"), gt(s.orders.createdAt, since)))
    .orderBy(desc(s.orders.createdAt))
    .limit(5);
  return rows.find(match);
}

export function installHandlers(bot: Bot, ctx: Ctx, botId: string, rt: BotlyRuntime) {
  async function load(): Promise<Loaded> {
    const row = (await ctx.db.select().from(s.bots).where(eq(s.bots.id, botId)))[0]!;
    const account = (await ctx.db.select().from(s.accounts).where(eq(s.accounts.id, row.accountId)))[0]!;
    const main = row.mainChannelId ? ((await ctx.db.select().from(s.channels).where(eq(s.channels.id, row.mainChannelId)))[0] ?? null) : null;
    const plans = await ctx.db
      .select()
      .from(s.plans)
      .where(and(eq(s.plans.botId, botId), eq(s.plans.active, true)))
      .orderBy(asc(s.plans.sortOrder), asc(s.plans.priceCents));
    return { bot: row, account, main, plans, tz: account.settings.timezone ?? DEFAULT_TZ };
  }

  async function who(c: Context, L: Loaded, source?: string | null): Promise<{ customer: Customer; newInBot: boolean }> {
    return touchCustomer(ctx, L.account.id, botId, c.from!, source);
  }

  /**
   * Mostra uma tela. Por padrão manda uma mensagem NOVA (a conversa guarda o histórico).
   * replace = edita a mensagem do botão: só ao trocar de plano/pacote no menu de compra.
   */
  async function show(c: Context, text: string, kb?: InlineKeyboard, opts: { replace?: boolean } = {}) {
    const o = { parse_mode: "HTML" as const, reply_markup: kb, link_preview_options: { is_disabled: true } };
    if (opts.replace && c.callbackQuery?.message && "text" in c.callbackQuery.message) {
      try {
        await c.editMessageText(text, o);
        return;
      } catch {
        /* mensagem antiga ou com mídia: manda nova */
      }
    }
    await c.reply(text, o);
  }

  // ───────────── Trava de compra ─────────────
  // Enquanto o Pix de um cliente está sendo gerado, outros toques em botões de compra
  // não geram outro Pix: o cliente recebe "aguarde" (evita 3 cliques = 3 Pix).
  const BUY = /^(p|bun|bump|rn|rnx|wb|new):/;
  bot.on("callback_query:data", async (c, next) => {
    if (!BUY.test(c.callbackQuery.data)) return next();
    const key = `${botId}:${c.from.id}`;
    const until = buying.get(key) ?? 0;
    if (until > Date.now()) {
      await c.answerCallbackQuery({ text: "⏳ Estou gerando seu Pix, aguarde alguns segundos…" }).catch(() => {});
      return;
    }
    buying.set(key, Date.now() + 60_000);
    try {
      await next();
    } finally {
      buying.delete(key);
    }
  });

  // ───────────── Entrada ─────────────

  bot.command("start", async (c) => {
    if (c.chat.type !== "private") return;
    const L = await load();
    const source = (c.match || "").trim().slice(0, 64) || null;
    const { customer, newInBot } = await who(c, L, source);
    if (newInBot) await logEvent(ctx, { accountId: L.account.id, botId, customerId: customer.id, type: "started", meta: { source } });
    if ((L.account.settings.ageGate ?? true) && !customer.ageConfirmedAt) {
      await c.reply("🔞 Este bot tem conteúdo adulto. Para continuar, confirme que você tem 18 anos ou mais.", {
        reply_markup: new InlineKeyboard().text("✅ Tenho 18 anos ou mais", "age:ok").row().text("Sair", "age:no"),
      });
      return;
    }
    await welcome(c, L, customer);
  });

  bot.callbackQuery("age:ok", async (c) => {
    await c.answerCallbackQuery();
    const L = await load();
    const { customer } = await who(c, L);
    await ctx.db.update(s.customers).set({ ageConfirmedAt: ctx.now() }).where(eq(s.customers.id, customer.id));
    await logEvent(ctx, { accountId: L.account.id, botId, customerId: customer.id, type: "age_confirmed" });
    await c.deleteMessage().catch(() => {});
    await welcome(c, L, { ...customer, ageConfirmedAt: ctx.now() });
  });

  bot.callbackQuery("age:no", async (c) => {
    await c.answerCallbackQuery();
    await show(c, "Tudo bem! Se mudar de ideia, é só mandar /start.");
  });

  /** Acessos ativos do cliente (todos os canais da conta). */
  async function activeList(customerId: string) {
    const rows = await ctx.db
      .select({ a: s.accesses, ch: s.channels })
      .from(s.accesses)
      .innerJoin(s.channels, eq(s.channels.id, s.accesses.channelId))
      .where(and(eq(s.accesses.customerId, customerId), eq(s.accesses.status, "active")));
    const now = ctx.now();
    return rows.filter((r) => !r.a.expiresAt || r.a.expiresAt > now);
  }

  /** Menu de quem já é assinante: o que tem, renovar/upgrade, outros canais e suporte. */
  async function memberMenu(c: Context, L: Loaded, active: Awaited<ReturnType<typeof activeList>>) {
    const lines = active.map((r) => `• <b>${esc(chName(r.ch))}</b> — ${r.a.expiresAt ? `até ${fmtDate(r.a.expiresAt, L.tz)}` : "vitalício"}`);
    const kb = new InlineKeyboard();
    for (const r of active) if (r.ch.inviteLink) kb.url(`🔓 Entrar no ${chName(r.ch)}`, r.ch.inviteLink).row();
    kb.text("🔄 Renovar / mudar de plano", "plans").row();
    if (await hasMore(L, active.map((r) => r.ch.id))) kb.text("➕ Outros canais e pacotes", "more").row();
    kb.text("💬 Suporte", "sup");
    await c.reply(`✅ <b>Seus acessos</b>\n${lines.join("\n")}`, { parse_mode: "HTML", reply_markup: kb });
  }

  async function welcome(c: Context, L: Loaded, customer: Customer) {
    const active = await activeList(customer.id);
    if (active.length) {
      await memberMenu(c, L, active);
      return;
    }
    const kb = new InlineKeyboard().text("💎 Ver planos", "plans").row();
    if (L.bot.previewUrl) kb.url(L.bot.previewButton || "👀 Ver prévias grátis", L.bot.previewUrl).row();
    kb.text("💬 Dúvidas? Fale com a gente", "sup").row();
    const text = L.bot.welcome.text || "Bem-vindo!";
    const media = L.bot.welcome.media;
    let src: string | InputFile | null | undefined = media?.fileId || media?.url;
    // Arquivo enviado pelo painel: na 1ª vez sobe para o Telegram; depois usa o file_id.
    if (media && !src && media.mediaId) {
      const m = (await ctx.db.select().from(s.media).where(eq(s.media.id, media.mediaId)))[0];
      if (m) src = new InputFile(m.data, m.fileName);
    }
    if (media && src) {
      const opts = { caption: text, parse_mode: "HTML" as const, reply_markup: kb };
      try {
        const sent =
          media.type === "video" ? await c.replyWithVideo(src, opts) : media.type === "animation" ? await c.replyWithAnimation(src, opts) : await c.replyWithPhoto(src, opts);
        // Guarda o file_id para os próximos envios (mais rápido que URL).
        if (!media.fileId) {
          const fid = "video" in sent && sent.video ? sent.video.file_id : "animation" in sent && sent.animation ? sent.animation.file_id : "photo" in sent && sent.photo ? sent.photo.at(-1)?.file_id : null;
          if (fid) await ctx.db.update(s.bots).set({ welcome: { ...L.bot.welcome, media: { ...media, fileId: fid } } }).where(eq(s.bots.id, botId));
        }
        return;
      } catch (err) {
        ctx.log.warn({ botId, err: String(err) }, "falha ao enviar mídia da boas-vindas");
      }
    }
    await c.reply(text, { parse_mode: "HTML", reply_markup: kb });
  }

  // ───────────── Planos e pacotes ─────────────

  async function plansScreen(c: Context, replace = false) {
    const L = await load();
    const { customer } = await who(c, L);
    await logEvent(ctx, { accountId: L.account.id, botId, customerId: customer.id, type: "viewed_plans" });
    await advanceFunnel(ctx, customer.id, "viewed_plans");
    if (!L.plans.length) {
      await show(c, "Nenhum plano disponível no momento. Volte mais tarde 🙏", undefined, { replace });
      return;
    }
    const kb = new InlineKeyboard();
    for (const p of L.plans) kb.text(`${p.highlight ? "⭐ " : ""}${p.name} — ${brl(p.priceCents)}`, `p:${p.id}`).row();
    if (L.bot.showBundles && (await activeBundles(L.account.id)).length) kb.text("🔥 Pacotes promocionais", "bundles").row();
    await show(c, "💎 <b>Escolha seu plano:</b>", kb, { replace });
  }

  async function activeBundles(accountId: string) {
    return ctx.db
      .select()
      .from(s.bundles)
      .where(and(eq(s.bundles.accountId, accountId), eq(s.bundles.active, true)))
      .orderBy(asc(s.bundles.sortOrder), asc(s.bundles.priceCents));
  }

  bot.command("planos", (c) => plansScreen(c));
  bot.callbackQuery("plans", async (c) => {
    await c.answerCallbackQuery();
    await plansScreen(c);
  });
  // Voltar dos pacotes para os planos: troca a mesma mensagem.
  bot.callbackQuery("plans:back", async (c) => {
    await c.answerCallbackQuery();
    await plansScreen(c, true);
  });

  bot.callbackQuery("bundles", async (c) => {
    await c.answerCallbackQuery();
    const L = await load();
    const list = await activeBundles(L.account.id);
    const counts = list.length
      ? await ctx.db.select({ bundleId: s.bundleChannels.bundleId }).from(s.bundleChannels).where(inArray(s.bundleChannels.bundleId, list.map((b) => b.id)))
      : [];
    const kb = new InlineKeyboard();
    for (const b of list) {
      const n = counts.filter((x) => x.bundleId === b.id).length;
      kb.text(`${b.name} (${n} canais, ${durationLabel(b.durationUnit, b.durationValue)}) — ${brl(b.priceCents)}`, `bun:${b.id}`).row();
    }
    kb.text("⬅️ Voltar", "plans:back");
    await show(c, "🔥 <b>Pacotes</b> — vários canais por um preço só:", kb, { replace: true });
  });

  // ───────────── Escolha → order bump → Pix ─────────────

  bot.callbackQuery(/^p:(.+)$/, async (c) => {
    await c.answerCallbackQuery();
    const L = await load();
    const plan = L.plans.find((p) => p.id === c.match[1]);
    if (!plan || !L.main) {
      await show(c, "Esse plano não está mais disponível.", new InlineKeyboard().text("💎 Ver planos", "plans"));
      return;
    }
    const { customer } = await who(c, L);
    await logEvent(ctx, { accountId: L.account.id, botId, customerId: customer.id, type: "chose_plan", meta: { planId: plan.id } });
    await advanceFunnel(ctx, customer.id, "chose_plan");
    // Já escolheu este plano há pouco e não pagou: reaproveita o mesmo pedido (e o mesmo Pix).
    const again = await reusableOrder(ctx, customer.id, botId, (o) => o.items[0]?.type === "plan" && o.items[0].refId === plan.id && o.discountCents === 0 && (o.source ?? "") !== "volte");
    if (again) {
      const hasPix = (await ctx.db.select({ id: s.charges.id }).from(s.charges).where(and(eq(s.charges.orderId, again.id), eq(s.charges.status, "pending")))).length > 0;
      if (hasPix || again.items.length > 1) return pay(c, L, again.id, { fromMenu: true });
    }
    const renewing = !!(await activeAccess(ctx, customer.id, L.main.id));
    const item: OrderItem = {
      type: "plan",
      refId: plan.id,
      name: plan.name,
      channelIds: [L.main.id],
      durationUnit: plan.durationUnit,
      durationValue: plan.durationValue,
      priceCents: plan.priceCents,
    };
    const order = again ?? (await createOrder(ctx, { accountId: L.account.id, botId, customerId: customer.id, kind: renewing ? "renewal" : "new", items: [item], source: customer.source }));
    const bump = await pickOrderBump(ctx, L.bot, customer.id, L.account.settings.offerCooldownDays ?? 30);
    if (bump) {
      await logEvent(ctx, { accountId: L.account.id, botId, customerId: customer.id, type: "bump_offered", meta: { channelId: bump.channel.id, orderId: order.id } });
      await show(
        c,
        `Você escolheu <b>${esc(plan.name)} — ${brl(plan.priceCents)}</b>.\n\n➕ Quer adicionar o canal <b>${esc(chName(bump.channel))}</b> por só <b>+${brl(bump.priceCents)}</b>?\n<i>(vence junto com o seu plano)</i>`,
        new InlineKeyboard()
          .text(`✅ Sim, adicionar (total ${brl(plan.priceCents + bump.priceCents)})`, `bump:y:${order.id}`)
          .row()
          .text("Não, só o plano", `bump:n:${order.id}`),
        { replace: true },
      );
      return;
    }
    await pay(c, L, order.id, { fromMenu: true });
  });

  bot.callbackQuery(/^bump:(y|n):(.+)$/, async (c) => {
    await c.answerCallbackQuery();
    const L = await load();
    const { customer } = await who(c, L);
    const order = (await ctx.db.select().from(s.orders).where(and(eq(s.orders.id, c.match[2]!), eq(s.orders.customerId, customer.id))))[0];
    if (!order || order.status !== "pending") return;
    const bump = await pickOrderBump(ctx, L.bot, customer.id, L.account.settings.offerCooldownDays ?? 30);
    if (bump && c.match[1] === "y" && !order.items.some((i) => i.type === "extra")) {
      const main = order.items[0]!;
      const extra: OrderItem = {
        type: "extra",
        refId: bump.channel.id,
        name: chName(bump.channel),
        channelIds: [bump.channel.id],
        durationUnit: main.durationUnit,
        durationValue: main.durationValue,
        priceCents: bump.priceCents,
      };
      const items = [...order.items, extra];
      const subtotal = items.reduce((t, i) => t + i.priceCents, 0);
      await ctx.db.update(s.orders).set({ items, subtotalCents: subtotal, totalCents: subtotal - order.discountCents }).where(eq(s.orders.id, order.id));
      await logEvent(ctx, { accountId: L.account.id, botId, customerId: customer.id, type: "bump_accepted", meta: { channelId: bump.channel.id } });
    } else if (bump && c.match[1] === "n") {
      await recordDecline(ctx, customer.id, bump.channel.id);
      await logEvent(ctx, { accountId: L.account.id, botId, customerId: customer.id, type: "bump_declined", meta: { channelId: bump.channel.id } });
    }
    await pay(c, L, order.id, { fromMenu: true });
  });

  bot.callbackQuery(/^bun:(.+)$/, async (c) => {
    await c.answerCallbackQuery();
    const L = await load();
    const b = (await ctx.db.select().from(s.bundles).where(and(eq(s.bundles.id, c.match[1]!), eq(s.bundles.accountId, L.account.id), eq(s.bundles.active, true))))[0];
    if (!b) return;
    const chans = await ctx.db.select({ channelId: s.bundleChannels.channelId }).from(s.bundleChannels).where(eq(s.bundleChannels.bundleId, b.id));
    const { customer } = await who(c, L);
    await logEvent(ctx, { accountId: L.account.id, botId, customerId: customer.id, type: "chose_plan", meta: { bundleId: b.id } });
    await advanceFunnel(ctx, customer.id, "chose_plan");
    const order = (await reusableOrder(ctx, customer.id, botId, (o) => o.kind === "bundle" && o.items[0]?.refId === b.id)) ?? await createOrder(ctx, {
      accountId: L.account.id,
      botId,
      customerId: customer.id,
      kind: "bundle",
      source: customer.source,
      items: [{ type: "bundle", refId: b.id, name: b.name, channelIds: chans.map((x) => x.channelId), durationUnit: b.durationUnit, durationValue: b.durationValue, priceCents: b.priceCents }],
    });
    await pay(c, L, order.id, { fromMenu: true });
  });

  /**
   * Gera e manda o Pix. Apaga o menu de escolha (fromMenu) ou o Pix anterior do
   * mesmo pedido ("Gerar outro Pix"), para não ficar Pix velho na conversa.
   */
  async function pay(c: Context, L: Loaded, orderId: string, opts: { avoidGatewayId?: string | null; fromMenu?: boolean } = {}) {
    const avoidGatewayId = opts.avoidGatewayId;
    const order = (await ctx.db.select().from(s.orders).where(eq(s.orders.id, orderId)))[0]!;
    // Aviso imediato enquanto o Pix é gerado (no lugar do menu, ou mensagem nova).
    let waitMsg: number | null = null;
    const waitText = "⏳ Gerando seu Pix, só um instante…";
    if (opts.fromMenu && c.callbackQuery?.message) {
      const ok = await c.editMessageText(waitText).then(() => true, () => false);
      waitMsg = ok ? c.callbackQuery.message.message_id : null;
    }
    if (waitMsg == null) waitMsg = (await c.reply(waitText).catch(() => null))?.message_id ?? null;
    const dropWait = () => (waitMsg != null ? c.api.deleteMessage(c.chat!.id, waitMsg).catch(() => {}) : undefined);

    // Pix ainda válido deste pedido: manda o mesmo de novo (não gera outro), menos em "Gerar outro Pix".
    const since = new Date(ctx.now().getTime() - (PIX_VALID_MINUTES - 2) * 60_000);
    const existing = avoidGatewayId
      ? undefined
      : (
          await ctx.db
            .select()
            .from(s.charges)
            .where(and(eq(s.charges.orderId, orderId), eq(s.charges.status, "pending"), gt(s.charges.createdAt, since)))
            .orderBy(desc(s.charges.createdAt))
            .limit(1)
        )[0];
    let charge: typeof s.charges.$inferSelect;
    let code: string;
    if (existing?.pixCode) {
      charge = existing;
      code = existing.pixCode;
    } else {
      try {
        const res = await createPixForOrder(ctx, orderId, { avoidGatewayId });
        charge = res.charge;
        code = res.pix.code;
      } catch (err) {
        ctx.log.error({ botId, orderId, err: String(err) }, "falha ao gerar Pix");
        await dropWait();
        await show(
          c,
          err instanceof NoGatewayError && !String(err.message).includes("|")
            ? "Pagamento indisponível no momento. Tente de novo em alguns minutos 🙏"
            : "Não consegui gerar o Pix agora. Tente de novo em instantes 🙏",
          new InlineKeyboard().text("🔁 Tentar de novo", `new:${orderId}`),
        );
        return;
      }
      await logEvent(ctx, { accountId: L.account.id, botId, customerId: order.customerId, type: "pix_generated", meta: { orderId, chargeId: charge.id, totalCents: order.totalCents, provider: charge.provider } });
      await advanceFunnel(ctx, order.customerId, "pix_generated");
    }
    const fresh = (await ctx.db.select().from(s.orders).where(eq(s.orders.id, orderId)))[0]!;
    const names = fresh.items.map((i) => i.name).join(" + ");
    const minutesLeft = Math.max(1, Math.round(((charge.expiresAt?.getTime() ?? ctx.now().getTime() + PIX_VALID_MINUTES * 60_000) - ctx.now().getTime()) / 60_000));
    const caption =
      `🧾 <b>Resumo:</b> ${esc(names)}\n` +
      (fresh.discountCents ? `🏷 Desconto: −${brl(fresh.discountCents)}\n` : "") +
      `💰 <b>Total: ${brl(fresh.totalCents)}</b>\n\n` +
      `Copie o código Pix abaixo e pague no app do seu banco.\n⏳ O Pix vale por ${minutesLeft} minutos. A liberação é automática.`;
    // Some o Pix antigo deste pedido (inclusive o mesmo, que vai ser reenviado).
    await deletePixMessages(c, orderId, null);
    await dropWait();
    const ids: number[] = [];
    const qr = await QRCode.toBuffer(code, { width: 480, margin: 2 }).catch(() => null);
    const first = qr ? await c.replyWithPhoto(new InputFile(qr, "pix.png"), { caption, parse_mode: "HTML" }) : await c.reply(caption, { parse_mode: "HTML" });
    ids.push(first.message_id);
    const codeMsg = await c.reply(`<code>${esc(code)}</code>`, {
      parse_mode: "HTML",
      // "Gerar outro Pix" só faz sentido com mais de uma forma de pagamento (tenta outro banco).
      reply_markup: L.bot.routing.gatewayIds.length > 1 ? new InlineKeyboard().text("✅ Já paguei", `chk:${charge.id}`).row().text("🔁 Gerar Pix em outro banco", `new:${orderId}`) : new InlineKeyboard().text("✅ Já paguei", `chk:${charge.id}`),
    });
    ids.push(codeMsg.message_id);
    await ctx.db.update(s.charges).set({ chatMessageIds: ids }).where(eq(s.charges.id, charge.id));
  }

  /** Apaga as mensagens de Pix anteriores deste pedido (menos a cobrança atual). */
  async function deletePixMessages(c: Context, orderId: string, keepChargeId: string | null) {
    const olds = await ctx.db.select({ id: s.charges.id, ids: s.charges.chatMessageIds }).from(s.charges).where(eq(s.charges.orderId, orderId));
    for (const o of olds) {
      if (o.id === keepChargeId || !o.ids.length) continue;
      for (const mid of o.ids) await c.api.deleteMessage(c.chat!.id, mid).catch(() => {});
      await ctx.db.update(s.charges).set({ chatMessageIds: [] }).where(eq(s.charges.id, o.id));
    }
  }

  bot.callbackQuery(/^chk:(.+)$/, async (c) => {
    const L = await load();
    const charge = (await ctx.db.select().from(s.charges).where(and(eq(s.charges.id, c.match[1]!), eq(s.charges.accountId, L.account.id))))[0];
    if (!charge) return c.answerCallbackQuery();
    if (charge.status === "paid") return c.answerCallbackQuery({ text: "Pagamento já confirmado ✅" });
    let r;
    try {
      r = await checkCharge(ctx, charge.id);
    } catch (err) {
      ctx.log.warn({ chargeId: charge.id, err: String(err) }, "falha ao consultar cobrança");
      r = "pending" as const;
    }
    if (r && r !== "pending") {
      await c.answerCallbackQuery({ text: "Pagamento confirmado ✅" });
      await announcePaid(ctx, rt, r);
      return;
    }
    await c.answerCallbackQuery({ text: "Ainda não recebemos. Assim que cair, eu te aviso aqui 😉", show_alert: true });
  });

  bot.callbackQuery(/^new:(.+)$/, async (c) => {
    await c.answerCallbackQuery();
    const L = await load();
    const { customer } = await who(c, L);
    const order = (await ctx.db.select().from(s.orders).where(and(eq(s.orders.id, c.match[1]!), eq(s.orders.customerId, customer.id))))[0];
    if (!order || order.status !== "pending") return;
    const last = (await ctx.db.select().from(s.charges).where(eq(s.charges.orderId, order.id)).orderBy(desc(s.charges.createdAt)).limit(1))[0];
    // Com uma forma de pagamento só, reenvia o mesmo Pix (se ainda valer) em vez de gerar outro.
    await pay(c, L, order.id, { avoidGatewayId: L.bot.routing.gatewayIds.length > 1 ? last?.gatewayId : null });
  });

  // ───────────── Recuperação de Pix (botão da mensagem "seu Pix ainda está esperando") ─────────────
  // rc:<pedido original>:<modelo>. Com desconto ou plano mais barato, cria um pedido novo só agora (quando o cliente toca).
  bot.callbackQuery(/^rc:([^:]+):([^:]+)$/, async (c) => {
    await c.answerCallbackQuery();
    const L = await load();
    const { customer } = await who(c, L);
    const order = (await ctx.db.select().from(s.orders).where(and(eq(s.orders.id, c.match[1]!), eq(s.orders.customerId, customer.id))))[0];
    if (!order) return plansScreen(c);
    if (order.status === "paid") {
      await show(c, "✅ Seu pagamento já foi confirmado! Toque em /meuplano para ver seu acesso.");
      return;
    }
    const t = (await ctx.db.select().from(s.templates).where(and(eq(s.templates.id, c.match[2]!), eq(s.templates.accountId, L.account.id), eq(s.templates.kind, "recovery"))))[0];
    const steps = await recoverySteps(ctx, L.account.id);
    const down = t && steps.at(-1)?.id === t.id ? await downsellFor(ctx, L.bot, order.totalCents) : null;
    // Sem desconto e sem plano mais barato: é só mostrar o Pix de novo.
    if (!t?.discountPct && !down) {
      if (order.status === "pending") return pay(c, L, order.id, { fromMenu: true });
      return plansScreen(c);
    }
    const items: OrderItem[] =
      down && L.main
        ? [{ type: "plan", refId: down.id, name: down.name, channelIds: [L.main.id], durationUnit: down.durationUnit, durationValue: down.durationValue, priceCents: down.priceCents }]
        : order.items;
    const subtotal = items.reduce((x, i) => x + i.priceCents, 0);
    const discountCents = t?.discountPct ? Math.round((subtotal * t.discountPct) / 100) : 0;
    const sig = JSON.stringify(items.map((i) => [i.type, i.refId, i.channelIds]));
    const fresh =
      (await reusableOrder(ctx, customer.id, botId, (o) => o.kind === "recovery" && o.discountCents === discountCents && JSON.stringify(o.items.map((i) => [i.type, i.refId, i.channelIds])) === sig)) ??
      (await createOrder(ctx, { accountId: L.account.id, botId, customerId: customer.id, kind: "recovery", items, discountCents, source: "recuperacao" }));
    // O pedido antigo sai de "pendente" (não conta em dobro). Se o Pix antigo ainda for pago, o acesso é liberado do mesmo jeito.
    if (order.status === "pending") await ctx.db.update(s.orders).set({ status: "canceled" }).where(and(eq(s.orders.id, order.id), eq(s.orders.status, "pending")));
    await logEvent(ctx, { accountId: L.account.id, botId, customerId: customer.id, type: "recovery_clicked", meta: { rootOrderId: order.id, orderId: fresh.id, discountPct: t?.discountPct ?? 0, downsell: !!down } });
    await pay(c, L, fresh.id, { fromMenu: true });
  });

  // ───────────── Oferta pós-venda ─────────────
  // ps:<pedido que acabou de pagar>. Vale até o horário gravado na oferta; o desconto também vem dela (não do botão).
  bot.callbackQuery(/^ps:(.+)$/, async (c) => {
    await c.answerCallbackQuery();
    const L = await load();
    const { customer } = await who(c, L);
    const ev = (
      await ctx.db
        .select()
        .from(s.events)
        .where(and(eq(s.events.customerId, customer.id), eq(s.events.type, "postsale_offered"), sql`${s.events.meta}->>'orderId' = ${c.match[1]!}`))
        .limit(1)
    )[0];
    if (!ev) return;
    const m = ev.meta as { channelId: string; discountPct: number; priceCents: number; until: string };
    if (new Date(m.until).getTime() < ctx.now().getTime()) {
      await show(c, "⏰ Essa oferta já expirou. Toque em /start para ver os planos e canais.");
      return;
    }
    const ch = (await ctx.db.select().from(s.channels).where(and(eq(s.channels.id, m.channelId), eq(s.channels.active, true))))[0];
    const base = (await ctx.db.select().from(s.orders).where(eq(s.orders.id, c.match[1]!)))[0];
    if (!ch || !base || (await activeAccess(ctx, customer.id, ch.id))) {
      await show(c, "✅ Você já tem esse canal. Toque em /meuplano para ver seu acesso.");
      return;
    }
    const main = base.items[0]!;
    const full = L.bot.upsell.orderBump?.priceOverrides?.[ch.id] ?? ch.extraPriceCents ?? m.priceCents;
    const items: OrderItem[] = [{ type: "extra", refId: ch.id, name: chName(ch), channelIds: [ch.id], durationUnit: main.durationUnit, durationValue: main.durationValue, priceCents: full }];
    const discountCents = Math.max(0, full - m.priceCents);
    const sig = JSON.stringify(items.map((i) => [i.type, i.refId, i.channelIds]));
    const order =
      (await reusableOrder(ctx, customer.id, botId, (o) => o.kind === "upsell" && o.discountCents === discountCents && JSON.stringify(o.items.map((i) => [i.type, i.refId, i.channelIds])) === sig)) ??
      (await createOrder(ctx, { accountId: L.account.id, botId, customerId: customer.id, kind: "upsell", items, discountCents, source: "pos-venda" }));
    await logEvent(ctx, { accountId: L.account.id, botId, customerId: customer.id, type: "postsale_clicked", meta: { orderId: base.id, upsellOrderId: order.id, channelId: ch.id, priceCents: m.priceCents } });
    await pay(c, L, order.id, { fromMenu: true });
  });

  // ───────────── Renovação pelos botões do lembrete ─────────────

  /** Pedido de renovação do mesmo plano (opcionalmente com canal extra ou desconto). */
  async function renewFromAccess(c: Context, accessId: string, opts: { withExtra?: boolean; discountPct?: number; source?: string } = {}) {
    const L = await load();
    const { customer } = await who(c, L);
    const a = (await ctx.db.select().from(s.accesses).where(and(eq(s.accesses.id, accessId), eq(s.accesses.customerId, customer.id))))[0];
    const plan = a?.planId ? (await ctx.db.select().from(s.plans).where(and(eq(s.plans.id, a.planId), eq(s.plans.active, true))))[0] : undefined;
    if (!a || !plan) {
      // Plano não existe mais: mostra os planos atuais.
      await plansScreen(c);
      return;
    }
    const items: OrderItem[] = [
      { type: "plan", refId: plan.id, name: plan.name, channelIds: [a.channelId], durationUnit: plan.durationUnit, durationValue: plan.durationValue, priceCents: plan.priceCents },
    ];
    const ren = L.bot.upsell.renewal;
    if (opts.withExtra && ren?.enabled && ren.extraChannelId && !(await activeAccess(ctx, customer.id, ren.extraChannelId))) {
      const ch = (await ctx.db.select().from(s.channels).where(and(eq(s.channels.id, ren.extraChannelId), eq(s.channels.active, true))))[0];
      const price = L.bot.upsell.orderBump?.priceOverrides?.[ren.extraChannelId] ?? ch?.extraPriceCents;
      if (ch && price) items.push({ type: "extra", refId: ch.id, name: chName(ch), channelIds: [ch.id], durationUnit: plan.durationUnit, durationValue: plan.durationValue, priceCents: price });
    }
    const subtotal = items.reduce((x, i) => x + i.priceCents, 0);
    const discountCents = opts.discountPct ? Math.round((plan.priceCents * opts.discountPct) / 100) : 0;
    const sig = JSON.stringify(items.map((i) => [i.type, i.refId, i.channelIds]));
    const order =
      (await reusableOrder(ctx, customer.id, botId, (o) => o.kind === "renewal" && o.discountCents === discountCents && JSON.stringify(o.items.map((i) => [i.type, i.refId, i.channelIds])) === sig)) ??
      (await createOrder(ctx, { accountId: L.account.id, botId, customerId: customer.id, kind: "renewal", items, discountCents, source: opts.source ?? "lembrete" }));
    await logEvent(ctx, { accountId: L.account.id, botId, customerId: customer.id, type: "renew_clicked", meta: { accessId, withExtra: items.length > 1, discountPct: opts.discountPct ?? 0, subtotal } });
    await pay(c, L, order.id);
  }

  bot.callbackQuery(/^rn:(.+)$/, async (c) => {
    await c.answerCallbackQuery();
    await renewFromAccess(c, c.match[1]!);
  });
  bot.callbackQuery(/^rnx:(.+)$/, async (c) => {
    await c.answerCallbackQuery();
    await renewFromAccess(c, c.match[1]!, { withExtra: true });
  });
  // "Volte" com desconto: o desconto vem do modelo da mensagem enviada (não do botão).
  bot.callbackQuery(/^wb:(.+)$/, async (c) => {
    await c.answerCallbackQuery();
    const L = await load();
    const { customer } = await who(c, L);
    const o = (await ctx.db.select().from(s.outbox).where(and(eq(s.outbox.id, c.match[1]!), eq(s.outbox.customerId, customer.id))))[0];
    if (!o?.accessId) return plansScreen(c);
    const t = o.templateId ? (await ctx.db.select().from(s.templates).where(eq(s.templates.id, o.templateId)))[0] : undefined;
    await renewFromAccess(c, o.accessId, { discountPct: t?.discountPct ?? 0, source: "volte" });
  });

  // ───────────── Minha assinatura ─────────────

  async function myPlan(c: Context) {
    const L = await load();
    const { customer } = await who(c, L);
    const active = await activeList(customer.id);
    if (!active.length) {
      await show(c, "Você ainda não tem nenhuma assinatura ativa.", new InlineKeyboard().text("💎 Ver planos", "plans").row().text("💬 Suporte", "sup"));
      return;
    }
    await memberMenu(c, L, active);
  }
  bot.command("meuplano", (c) => myPlan(c));
  bot.callbackQuery("me", async (c) => {
    await c.answerCallbackQuery();
    await myPlan(c);
  });

  // ───────────── Outros canais e pacotes ─────────────

  /** Canais da conta que o cliente ainda não tem e que algum bot vende. */
  async function otherChannels(L: Loaded, owned: string[]) {
    const rows = await ctx.db
      .select({ ch: s.channels, bot: s.bots.username })
      .from(s.bots)
      .innerJoin(s.channels, eq(s.channels.id, s.bots.mainChannelId))
      .where(and(eq(s.bots.accountId, L.account.id), eq(s.bots.status, "active"), eq(s.channels.active, true)));
    const seen = new Set<string>();
    return rows.filter((r) => !owned.includes(r.ch.id) && !seen.has(r.ch.id) && seen.add(r.ch.id));
  }
  async function hasMore(L: Loaded, owned: string[]) {
    return (await otherChannels(L, owned)).length > 0 || (L.bot.showBundles && (await activeBundles(L.account.id)).length > 0);
  }

  bot.callbackQuery("more", async (c) => {
    await c.answerCallbackQuery();
    const L = await load();
    const { customer } = await who(c, L);
    const owned = (await activeList(customer.id)).map((r) => r.ch.id);
    const others = await otherChannels(L, owned);
    const kb = new InlineKeyboard();
    for (const o of others) {
      // Mesmo bot: vai direto aos planos; outro bot: abre o bot que vende o canal.
      if (o.bot === L.bot.username) kb.text(`💎 ${chName(o.ch)}`, "plans").row();
      else kb.url(`💎 ${chName(o.ch)}`, `https://t.me/${o.bot}?start=outros`).row();
    }
    if (L.bot.showBundles && (await activeBundles(L.account.id)).length) kb.text("🔥 Pacotes promocionais", "bundles").row();
    kb.text("🏠 Início", "home");
    await show(c, others.length ? "➕ <b>Outros canais que você ainda não tem:</b>" : "🔥 <b>Pacotes com vários canais:</b>", kb);
  });

  bot.callbackQuery("home", async (c) => {
    await c.answerCallbackQuery();
    const L = await load();
    const { customer } = await who(c, L);
    await welcome(c, L, customer);
  });

  // ───────────── Suporte ─────────────

  async function supportMenu(c: Context) {
    const L = await load();
    const { customer } = await who(c, L);
    const open = await openTicketFor(ctx, customer.id, botId);
    if (open) {
      await show(c, "💬 Você já está em atendimento. É só escrever aqui que a gente responde.", new InlineKeyboard().text("💎 Ver planos", "plans").text("🏠 Início", "home").row().text("✖️ Encerrar atendimento", "sup:end"));
      return;
    }
    const isMember = (await activeList(customer.id)).length > 0;
    const kb = new InlineKeyboard();
    if (isMember) kb.text("🔓 Não consigo entrar no canal", "sup:join").row();
    kb.text("💳 Paguei e não liberou", "sup:paid").row();
    if (isMember) kb.text("🔄 Quero mudar de plano", "plans").row();
    kb.text("👤 Falar com um atendente", "sup:human").row();
    kb.text("🏠 Início", "home");
    await show(c, "💬 <b>Como podemos ajudar?</b>", kb);
  }
  bot.command(["suporte", "ajuda"], (c) => supportMenu(c));
  bot.callbackQuery("sup", async (c) => {
    await c.answerCallbackQuery();
    await supportMenu(c);
  });

  bot.callbackQuery("sup:join", async (c) => {
    await c.answerCallbackQuery();
    const L = await load();
    const { customer } = await who(c, L);
    const active = await activeList(customer.id);
    if (!active.length) return show(c, "Você não tem nenhum plano ativo no momento.", new InlineKeyboard().text("💎 Ver planos", "plans").row().text("👤 Falar com um atendente", "sup:human"));
    const kb = new InlineKeyboard();
    for (const r of active) if (r.ch.inviteLink) kb.url(`🔓 Entrar no ${chName(r.ch)}`, r.ch.inviteLink).row();
    kb.text("👤 Ainda não consegui", "sup:human");
    await show(c, "Toque no botão do canal e depois em <b>“Pedir para entrar”</b>. A aprovação é automática, em poucos segundos.\n\nSe você saiu do canal, pode usar o mesmo botão para voltar.", kb);
  });

  bot.callbackQuery("sup:paid", async (c) => {
    await c.answerCallbackQuery({ text: "Conferindo seus pagamentos…" });
    const L = await load();
    const { customer } = await who(c, L);
    const since = new Date(ctx.now().getTime() - 48 * 3600_000);
    const pend = await ctx.db
      .select({ id: s.charges.id })
      .from(s.charges)
      .innerJoin(s.orders, eq(s.orders.id, s.charges.orderId))
      .where(and(eq(s.orders.customerId, customer.id), eq(s.charges.status, "pending"), gt(s.charges.createdAt, since)));
    for (const p of pend) {
      const r = await checkCharge(ctx, p.id).catch(() => null);
      if (r && r !== "pending") {
        await announcePaid(ctx, rt, r);
        return;
      }
    }
    await show(
      c,
      pend.length
        ? "Ainda não recebemos a confirmação do seu Pix. Às vezes o banco demora alguns minutos.\n\nSe já pagou, fale com um atendente e envie o comprovante."
        : "Não encontrei nenhum Pix seu em aberto. Se você pagou, fale com um atendente e envie o comprovante.",
      new InlineKeyboard().text("👤 Falar com um atendente", "sup:human").row().text("🏠 Início", "home"),
    );
  });

  bot.callbackQuery("sup:human", async (c) => {
    await c.answerCallbackQuery();
    const L = await load();
    const { customer } = await who(c, L);
    const isMember = (await activeList(customer.id)).length > 0;
    const { created } = await openTicket(ctx, { accountId: L.account.id, customerId: customer.id, botId, topic: isMember ? "assinante" : "antes de comprar" });
    const open = isSupportOpen(L.account.settings, ctx.now());
    // Mesmo com a conversa aberta, o cliente pode seguir comprando/renovando sozinho.
    const kb = new InlineKeyboard().text(isMember ? "🔄 Renovar / mudar de plano" : "💎 Ver planos", "plans").row().text("🏠 Início", "home").text("✖️ Encerrar atendimento", "sup:end");
    await show(
      c,
      open
        ? "✅ Pronto! Escreva sua dúvida aqui (pode mandar foto do comprovante, se for o caso). Um atendente já vai responder nesta conversa."
        : `${offHoursText(L.account.settings)}\n\nEnquanto isso, você pode ver os planos e comprar ou renovar sozinho pelos botões abaixo.`,
      kb,
    );
    if (created) await notifyTicket(L, customer);
  });

  bot.callbackQuery("sup:end", async (c) => {
    await c.answerCallbackQuery();
    const L = await load();
    const { customer } = await who(c, L);
    const t = await openTicketFor(ctx, customer.id, botId);
    if (t) await closeTicket(ctx, null, t, "customer");
    await show(c, "Atendimento encerrado. Se precisar, é só tocar em 💬 Suporte.", new InlineKeyboard().text("🏠 Início", "home"));
  });

  /** Aviso de novo atendimento no canal de avisos da conta. */
  async function notifyTicket(L: Loaded, customer: Customer) {
    const chat = L.account.settings.notifyChatId;
    if (!chat) return;
    try {
      const api = await rt.api(L.account.settings.notifyBotId || botId);
      const who2 = customer.username ? `@${customer.username}` : `${customer.firstName ?? ""} (${customer.telegramUserId})`;
      await api.sendMessage(chat, `💬 Novo pedido de atendimento\nCliente: ${esc(who2)}\nBot: @${esc(L.bot.username)}\nResponda em painel.botlybrasil.tech/atendimento`, { parse_mode: "HTML" });
    } catch (err) {
      ctx.log.warn({ botId, err: String(err) }, "falha ao avisar novo atendimento");
    }
  }

  // ───────────── Pedido de entrada no canal ─────────────

  bot.on("chat_join_request", async (c) => {
    const req = c.chatJoinRequest;
    const row = (await ctx.db.select().from(s.bots).where(eq(s.bots.id, botId)))[0]!;
    const channel = (await ctx.db.select().from(s.channels).where(and(eq(s.channels.accountId, row.accountId), eq(s.channels.telegramChatId, req.chat.id))))[0];
    // Só o bot gestor decide (outros bots admins recebem o mesmo pedido e ignoram).
    if (!channel || (channel.managerBotId && channel.managerBotId !== botId)) return;
    const customer = (await ctx.db.select().from(s.customers).where(and(eq(s.customers.accountId, row.accountId), eq(s.customers.telegramUserId, req.from.id))))[0];
    const acc = customer ? await activeAccess(ctx, customer.id, channel.id) : undefined;
    if (acc) {
      await c.approveChatJoinRequest(req.from.id);
      await ctx.db.update(s.accesses).set({ joinedAt: ctx.now() }).where(eq(s.accesses.id, acc.id));
      await advanceFunnel(ctx, customer!.id, "joined");
      // Conta para o bot que vendeu (o bot gestor só aprova).
      await logEvent(ctx, { accountId: row.accountId, botId: acc.billingBotId ?? botId, customerId: customer!.id, type: "joined", meta: { channelId: channel.id, managerBotId: botId } });
      return;
    }
    await c.declineChatJoinRequest(req.from.id);
    if (customer) await logEvent(ctx, { accountId: row.accountId, botId, customerId: customer.id, type: "join_declined", meta: { channelId: channel.id } });
    // O pedido permite mandar uma mensagem à pessoa mesmo sem /start.
    await c.api
      .sendMessage(req.user_chat_id, `Para entrar no <b>${esc(chName(channel))}</b> você precisa de um plano ativo.`, {
        parse_mode: "HTML",
        reply_markup: new InlineKeyboard().url("💎 Ver planos", `https://t.me/${row.username}?start=entrada`),
      })
      .catch(() => {});
  });

  // ───────────── Bot virou admin de um canal: cadastra sozinho ─────────────

  bot.on("my_chat_member", async (c) => {
    const upd = c.myChatMember;
    if (upd.chat.type === "private") return;
    if (upd.new_chat_member.status !== "administrator") return;
    const row = (await ctx.db.select().from(s.bots).where(eq(s.bots.id, botId)))[0]!;
    try {
      const { channel, rights } = await registerChannel(ctx, row, c.api, upd.chat.id);
      ctx.log.info({ botId, channel: channel.id, ok: rights.ok, missing: rights.missing }, "canal detectado");
    } catch (err) {
      ctx.log.warn({ botId, chat: upd.chat.id, err: String(err) }, "falha ao cadastrar canal detectado");
    }
  });

  // ───────────── Mensagens livres do cliente ─────────────
  // Com atendimento aberto, tudo o que o cliente escreve vai para o painel.
  // Registrado por último: comandos e botões acima têm prioridade.
  bot.on("message", async (c) => {
    if (c.chat.type !== "private" || !c.from) return;
    const L = await load();
    const { customer } = await who(c, L);
    const t = await openTicketFor(ctx, customer.id, botId);
    const m = c.message;
    if (!t) {
      if (m.text && !m.text.startsWith("/"))
        await c.reply("Para falar com a gente, toque em 💬 Suporte.", { reply_markup: new InlineKeyboard().text("💬 Suporte", "sup").text("🏠 Início", "home") });
      return;
    }
    const media = m.photo
      ? { mediaType: "photo" as const, tgFileId: m.photo.at(-1)!.file_id }
      : m.document
        ? { mediaType: "document" as const, tgFileId: m.document.file_id }
        : m.video
          ? { mediaType: "video" as const, tgFileId: m.video.file_id }
          : m.voice
            ? { mediaType: "voice" as const, tgFileId: m.voice.file_id }
            : {};
    const text = m.text ?? m.caption ?? null;
    if (!text && !("tgFileId" in media)) return;
    await addMessage(ctx, t, { sender: "customer", text, ...media });
  });
}
