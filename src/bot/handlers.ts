// Conversa do bot de vendas (docs/fluxo-bot.md).
// Dados dos botões (callback_data, máx. 64 bytes):
//   age:ok | age:no | plans | bundles | me
//   p:<planoId>            escolheu plano
//   bun:<pacoteId>         escolheu pacote
//   bump:y|n:<pedidoId>    aceitou/recusou o extra antes do Pix
//   chk:<cobrancaId>       "Já paguei"
//   new:<pedidoId>         "Gerar outro Pix" (outro gateway primeiro)
import { and, asc, eq, inArray, desc } from "drizzle-orm";
import { InlineKeyboard, InputFile, type Bot, type Context } from "grammy";
import * as s from "../db/schema.js";
import type { Ctx } from "../domain/context.js";
import { activeAccess, touchCustomer, type Customer } from "../domain/customers.js";
import { pickOrderBump, recordDecline } from "../domain/offers.js";
import { advanceFunnel, checkCharge, createOrder, createPixForOrder, logEvent, NoGatewayError, PIX_VALID_MINUTES } from "../domain/sales.js";
import { registerChannel } from "../domain/setup.js";
import type { OrderItem } from "../domain/types.js";
import { brl } from "../lib/money.js";
import { DEFAULT_TZ, durationLabel, fmtDate } from "../lib/time.js";
import { announcePaid } from "./notify.js";
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

  /** Mostra uma tela: edita a mensagem do botão quando dá; senão manda uma nova. */
  async function show(c: Context, text: string, kb?: InlineKeyboard) {
    const opts = { parse_mode: "HTML" as const, reply_markup: kb, link_preview_options: { is_disabled: true } };
    if (c.callbackQuery?.message && "text" in c.callbackQuery.message) {
      try {
        await c.editMessageText(text, opts);
        return;
      } catch {
        /* mensagem antiga ou com mídia: manda nova */
      }
    }
    await c.reply(text, opts);
  }

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

  async function welcome(c: Context, L: Loaded, customer: Customer) {
    if (L.main) {
      const acc = await activeAccess(ctx, customer.id, L.main.id);
      if (acc) {
        const kb = new InlineKeyboard().text("🔄 Renovar agora", "plans").row();
        if (L.main.inviteLink) kb.url(`🔗 Entrar no ${L.main.title}`, L.main.inviteLink).row();
        await c.reply(
          acc.expiresAt
            ? `✅ Seu acesso ao <b>${esc(L.main.title)}</b> está ativo até <b>${fmtDate(acc.expiresAt, L.tz)}</b>.`
            : `✅ Seu acesso ao <b>${esc(L.main.title)}</b> é <b>vitalício</b>.`,
          { parse_mode: "HTML", reply_markup: kb },
        );
        return;
      }
    }
    const kb = new InlineKeyboard().text("💎 Ver planos", "plans").row();
    if (L.bot.previewUrl) kb.url(L.bot.previewButton || "👀 Ver prévias grátis", L.bot.previewUrl).row();
    const text = L.bot.welcome.text || "Bem-vindo!";
    const media = L.bot.welcome.media;
    const src = media?.fileId || media?.url;
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

  async function plansScreen(c: Context) {
    const L = await load();
    const { customer } = await who(c, L);
    await logEvent(ctx, { accountId: L.account.id, botId, customerId: customer.id, type: "viewed_plans" });
    await advanceFunnel(ctx, customer.id, "viewed_plans");
    if (!L.plans.length) {
      await show(c, "Nenhum plano disponível no momento. Volte mais tarde 🙏");
      return;
    }
    const kb = new InlineKeyboard();
    for (const p of L.plans) kb.text(`${p.highlight ? "⭐ " : ""}${p.name} — ${brl(p.priceCents)}`, `p:${p.id}`).row();
    if (L.bot.showBundles && (await activeBundles(L.account.id)).length) kb.text("🔥 Pacotes promocionais", "bundles").row();
    await show(c, "💎 <b>Escolha seu plano:</b>", kb);
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
    kb.text("⬅️ Voltar", "plans");
    await show(c, "🔥 <b>Pacotes</b> — vários canais por um preço só:", kb);
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
    const order = await createOrder(ctx, { accountId: L.account.id, botId, customerId: customer.id, kind: renewing ? "renewal" : "new", items: [item], source: customer.source });
    const bump = await pickOrderBump(ctx, L.bot, customer.id, L.account.settings.offerCooldownDays ?? 30);
    if (bump) {
      await logEvent(ctx, { accountId: L.account.id, botId, customerId: customer.id, type: "bump_offered", meta: { channelId: bump.channel.id, orderId: order.id } });
      await show(
        c,
        `Você escolheu <b>${esc(plan.name)} — ${brl(plan.priceCents)}</b>.\n\n➕ Quer adicionar o canal <b>${esc(bump.channel.title)}</b> por só <b>+${brl(bump.priceCents)}</b>?\n<i>(vence junto com o seu plano)</i>`,
        new InlineKeyboard()
          .text(`✅ Sim, adicionar (total ${brl(plan.priceCents + bump.priceCents)})`, `bump:y:${order.id}`)
          .row()
          .text("Não, só o plano", `bump:n:${order.id}`),
      );
      return;
    }
    await pay(c, L, order.id);
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
        name: bump.channel.title,
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
    await pay(c, L, order.id);
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
    const order = await createOrder(ctx, {
      accountId: L.account.id,
      botId,
      customerId: customer.id,
      kind: "bundle",
      source: customer.source,
      items: [{ type: "bundle", refId: b.id, name: b.name, channelIds: chans.map((x) => x.channelId), durationUnit: b.durationUnit, durationValue: b.durationValue, priceCents: b.priceCents }],
    });
    await pay(c, L, order.id);
  });

  async function pay(c: Context, L: Loaded, orderId: string, avoidGatewayId?: string | null) {
    const order = (await ctx.db.select().from(s.orders).where(eq(s.orders.id, orderId)))[0]!;
    let res;
    try {
      res = await createPixForOrder(ctx, orderId, { avoidGatewayId });
    } catch (err) {
      ctx.log.error({ botId, orderId, err: String(err) }, "falha ao gerar Pix");
      await show(
        c,
        err instanceof NoGatewayError && !String(err.message).includes("|")
          ? "Pagamento indisponível no momento. Tente de novo em alguns minutos 🙏"
          : "Não consegui gerar o Pix agora. Tente de novo em instantes 🙏",
        new InlineKeyboard().text("🔁 Tentar de novo", `new:${orderId}`),
      );
      return;
    }
    await logEvent(ctx, { accountId: L.account.id, botId, customerId: order.customerId, type: "pix_generated", meta: { orderId, chargeId: res.charge.id, totalCents: order.totalCents, provider: res.charge.provider } });
    await advanceFunnel(ctx, order.customerId, "pix_generated");
    const names = order.items.map((i) => i.name).join(" + ");
    const caption =
      `🧾 <b>Resumo:</b> ${esc(names)}\n` +
      (order.discountCents ? `🏷 Desconto: −${brl(order.discountCents)}\n` : "") +
      `💰 <b>Total: ${brl(order.totalCents)}</b>\n\n` +
      `Copie o código Pix abaixo e pague no app do seu banco.\n⏳ O Pix vale por ${PIX_VALID_MINUTES} minutos. A liberação é automática.`;
    if (c.callbackQuery?.message) await c.deleteMessage().catch(() => {});
    if (res.pix.qrBase64) await c.replyWithPhoto(new InputFile(Buffer.from(res.pix.qrBase64, "base64"), "pix.png"), { caption, parse_mode: "HTML" });
    else await c.reply(caption, { parse_mode: "HTML" });
    await c.reply(`<code>${esc(res.pix.code)}</code>`, {
      parse_mode: "HTML",
      reply_markup: new InlineKeyboard().text("✅ Já paguei", `chk:${res.charge.id}`).row().text("🔁 Gerar outro Pix", `new:${orderId}`),
    });
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
    await pay(c, L, order.id, last?.gatewayId);
  });

  // ───────────── Minha assinatura ─────────────

  async function myPlan(c: Context) {
    const L = await load();
    const { customer } = await who(c, L);
    const rows = await ctx.db
      .select({ a: s.accesses, ch: s.channels })
      .from(s.accesses)
      .innerJoin(s.channels, eq(s.channels.id, s.accesses.channelId))
      .where(and(eq(s.accesses.customerId, customer.id), eq(s.accesses.status, "active")));
    const now = ctx.now();
    const active = rows.filter((r) => !r.a.expiresAt || r.a.expiresAt > now);
    if (!active.length) {
      await show(c, "Você ainda não tem nenhuma assinatura ativa.", new InlineKeyboard().text("💎 Ver planos", "plans"));
      return;
    }
    const kb = new InlineKeyboard();
    const lines = active.map((r) => `• <b>${esc(r.ch.title)}</b> — ${r.a.expiresAt ? `até ${fmtDate(r.a.expiresAt, L.tz)}` : "vitalício"}`);
    for (const r of active) if (r.ch.inviteLink) kb.url(`🔓 Entrar no ${r.ch.title}`, r.ch.inviteLink).row();
    kb.text("🔄 Renovar", "plans");
    await show(c, `📋 <b>Suas assinaturas:</b>\n${lines.join("\n")}`, kb);
  }
  bot.command("meuplano", (c) => myPlan(c));
  bot.callbackQuery("me", async (c) => {
    await c.answerCallbackQuery();
    await myPlan(c);
  });

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
      await logEvent(ctx, { accountId: row.accountId, botId, customerId: customer!.id, type: "joined", meta: { channelId: channel.id } });
      return;
    }
    await c.declineChatJoinRequest(req.from.id);
    if (customer) await logEvent(ctx, { accountId: row.accountId, botId, customerId: customer.id, type: "join_declined", meta: { channelId: channel.id } });
    // O pedido permite mandar uma mensagem à pessoa mesmo sem /start.
    await c.api
      .sendMessage(req.user_chat_id, `Para entrar no <b>${esc(channel.title)}</b> você precisa de um plano ativo.`, {
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
}
