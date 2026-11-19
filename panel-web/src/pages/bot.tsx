import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { brl, del, durationLabel, get, mediaSrc, post, put, PROVIDER_NAME, uploadMedia, type BotDetail, type Channel, type Gateway, type Media, type Plan, type Unit } from "../api";
import { Loading, MoneyField, Toggle, UNIT_OPTIONS, useAction, useLoad } from "../ui";

type Tab = "geral" | "planos" | "pagamento" | "ofertas";

export function BotPage() {
  const { id } = useParams();
  const [qs] = useSearchParams();
  const [tab, setTab] = useState<Tab>("geral");
  const bot = useLoad(() => get<{ bot: BotDetail; plans: Plan[] }>(`/api/bots/${id}`), [id]);
  const chans = useLoad(() => get<Channel[]>("/api/channels"));
  const gws = useLoad(() => get<Gateway[]>("/api/gateways"));
  const [draft, setDraft] = useState<BotDetail | null>(null);
  useEffect(() => {
    if (bot.data) setDraft(bot.data.bot);
  }, [bot.data]);

  if (!bot.data || !draft || !chans.data || !gws.data) return <Loading error={bot.error ?? chans.error ?? gws.error} />;
  const plans = bot.data.plans;
  const main = chans.data.find((c) => c.id === draft.mainChannelId) ?? null;

  return (
    <>
      <div className="page-head">
        <div>
          <Link to="/bots" className="small">
            Bots
          </Link>
          <h1>@{draft.username}</h1>
          <p>{draft.name}</p>
        </div>
        <StatusControl bot={draft} onChange={(status) => setDraft({ ...draft, status })} reload={bot.reload} />
      </div>
      {draft.status === "error" && <div className="note bad" style={{ marginBottom: 16 }}>{draft.statusDetail ?? "O bot está desconectado do Telegram."}</div>}
      {qs.get("novo") && !draft.mainChannelId && <NewBotNote username={draft.username} />}
      <div className="bot-layout">
        <div>
          <div className="tabs" role="tablist">
            {(
              [
                ["geral", "Geral"],
                ["planos", `Planos (${plans.length})`],
                ["pagamento", "Pagamento"],
                ["ofertas", "Ofertas"],
              ] as const
            ).map(([k, label]) => (
              <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? "on" : ""} onClick={() => setTab(k)}>
                {label}
              </button>
            ))}
          </div>
          {tab === "geral" && <GeneralTab draft={draft} setDraft={setDraft} channels={chans.data} saved={bot.data.bot} reload={bot.reload} />}
          {tab === "planos" && <PlansTab botId={draft.id} plans={plans} reload={bot.reload} />}
          {tab === "pagamento" && <PaymentTab draft={draft} setDraft={setDraft} gateways={gws.data} reload={bot.reload} />}
          {tab === "ofertas" && <OffersTab draft={draft} setDraft={setDraft} channels={chans.data} plans={plans} reload={bot.reload} />}
        </div>
        <ChatPreview bot={draft} plans={plans.filter((p) => p.active)} channelTitle={main?.title} />
      </div>
    </>
  );
}

function NewBotNote({ username }: { username: string }) {
  return (
    <div className="note" style={{ marginBottom: 16 }}>
      <b>Bot conectado.</b> Agora, no Telegram, adicione o <b>@{username}</b> como <b>administrador</b> do canal VIP com a permissão “Adicionar inscritos” ligada. O canal
      aparece sozinho na lista abaixo e na página <Link to="/canais">Canais</Link>.
    </div>
  );
}

function StatusControl({ bot, onChange, reload }: { bot: BotDetail; onChange: (s: BotDetail["status"]) => void; reload: () => void }) {
  const { busy, run } = useAction();
  const nav = useNavigate();
  return (
    <div className="row">
      {bot.status === "error" ? (
        <button className="btn" disabled={busy} onClick={() => run(() => post(`/api/bots/${bot.id}/reconnect`).then(reload), "Bot reconectado")}>
          Reconectar
        </button>
      ) : (
        <Toggle
          checked={bot.status === "active"}
          onChange={(v) =>
            run(async () => {
              await put(`/api/bots/${bot.id}`, { status: v ? "active" : "paused" });
              onChange(v ? "active" : "paused");
            }, v ? "Bot ligado" : "Bot pausado")
          }
        >
          {bot.status === "active" ? "Ligado" : "Pausado"}
        </Toggle>
      )}
      <button
        className="btn small danger"
        disabled={busy}
        onClick={() => {
          if (!confirm(`Remover o @${bot.username} do Botly? Ele para de responder aos clientes. Os assinantes e vendas continuam guardados.`)) return;
          void run(async () => {
            await del(`/api/bots/${bot.id}`);
            nav("/bots");
          }, "Bot removido");
        }}
      >
        Remover
      </button>
    </div>
  );
}

interface TabProps {
  draft: BotDetail;
  setDraft: (b: BotDetail) => void;
  reload: () => void;
}

function SaveBar({ onSave, busy }: { onSave: () => void; busy: boolean }) {
  return (
    <div className="row" style={{ marginTop: 18 }}>
      <button className="btn primary" disabled={busy} onClick={onSave}>
        {busy ? "Salvando…" : "Salvar alterações"}
      </button>
    </div>
  );
}

function GeneralTab({ draft, setDraft, channels, saved, reload }: TabProps & { channels: Channel[]; saved: BotDetail }) {
  const { busy, run } = useAction();
  const media = draft.welcome.media ?? null;
  const save = () =>
    run(
      () =>
        put(`/api/bots/${draft.id}`, {
          mainChannelId: draft.mainChannelId,
          welcome: { text: draft.welcome.text, media: media?.mediaId ? { type: media.type, mediaId: media.mediaId } : media?.url ? { type: media.type, url: media.url } : null },
          previewUrl: draft.previewUrl ?? "",
          previewButton: draft.previewButton ?? null,
        }).then(reload),
      "Alterações salvas",
    );
  const usable = channels.filter((c) => c.active);
  return (
    <div className="panel stack">
      <label className="field">
        Canal que este bot vende
        <small>Quem compra um plano deste bot recebe acesso a este canal.</small>
        {usable.length ? (
          <select value={draft.mainChannelId ?? ""} onChange={(e) => setDraft({ ...draft, mainChannelId: e.target.value || null })}>
            <option value="">Escolha o canal</option>
            {usable.map((c) => (
              <option key={c.id} value={c.id}>
                {c.title}
                {c.rightsOk ? "" : " (falta permissão)"}
              </option>
            ))}
          </select>
        ) : (
          <div className="note warn small">Nenhum canal ainda. Adicione este bot como administrador do canal VIP no Telegram e recarregue a página.</div>
        )}
      </label>

      <label className="field">
        Mensagem de boas-vindas
        <small>Aparece depois do /start. Pode usar &lt;b&gt;negrito&lt;/b&gt; e &lt;i&gt;itálico&lt;/i&gt;.</small>
        <textarea value={draft.welcome.text} maxLength={1024} onChange={(e) => setDraft({ ...draft, welcome: { ...draft.welcome, text: e.target.value } })} />
      </label>

      <MediaPicker value={media} onChange={(m) => setDraft({ ...draft, welcome: { ...draft.welcome, media: m } })} />

      <div className="grid-2">
        <label className="field">
          Canal gratuito de prévias
          <small>Opcional. Vira um botão na boas-vindas.</small>
          <input type="url" value={draft.previewUrl ?? ""} placeholder="https://t.me/seucanaldeprevias" onChange={(e) => setDraft({ ...draft, previewUrl: e.target.value })} />
        </label>
        <label className="field">
          Texto do botão de prévias
          <small>&nbsp;</small>
          <input type="text" value={draft.previewButton ?? ""} maxLength={40} placeholder="👀 Ver prévias grátis" onChange={(e) => setDraft({ ...draft, previewButton: e.target.value })} />
        </label>
      </div>
      {(saved.welcome.media?.url ?? saved.welcome.media?.mediaId) !== (media?.url ?? media?.mediaId) && media && (
        <p className="small muted">Clique em “Salvar alterações” para usar a mídia nova. Ela sobe para o Telegram no primeiro /start depois disso.</p>
      )}
      <SaveBar onSave={save} busy={busy} />
    </div>
  );
}

function PlansTab({ botId, plans, reload }: { botId: string; plans: Plan[]; reload: () => void }) {
  const [adding, setAdding] = useState(plans.length === 0);
  return (
    <div className="panel">
      <div className="panel-head">
        <div>
          <h2>Planos</h2>
          <p>Aparecem como botões, nesta ordem. Renovar antes de vencer soma os dias ao vencimento atual.</p>
        </div>
        {!adding && (
          <button className="btn" onClick={() => setAdding(true)}>
            Novo plano
          </button>
        )}
      </div>
      <div>
        {plans.map((p) => (
          <PlanRow key={p.id} plan={p} reload={reload} />
        ))}
        {adding && (
          <PlanRow
            botId={botId}
            reload={() => {
              setAdding(false);
              reload();
            }}
            onCancel={plans.length ? () => setAdding(false) : undefined}
          />
        )}
      </div>
    </div>
  );
}

function PlanRow({ plan, botId, reload, onCancel }: { plan?: Plan; botId?: string; reload: () => void; onCancel?: () => void }) {
  const [f, setF] = useState({
    name: plan?.name ?? "",
    durationUnit: (plan?.durationUnit ?? "month") as Unit,
    durationValue: plan?.durationValue ?? 1,
    priceCents: plan?.priceCents ?? null,
    highlight: plan?.highlight ?? false,
  });
  const { busy, run } = useAction();
  const dirty = !plan || f.name !== plan.name || f.durationUnit !== plan.durationUnit || f.durationValue !== plan.durationValue || f.priceCents !== plan.priceCents || f.highlight !== plan.highlight;
  const save = () =>
    run(async () => {
      if (!f.name.trim()) throw new Error("Dê um nome ao plano.");
      if (!f.priceCents || f.priceCents < 100) throw new Error("O preço mínimo é R$ 1,00.");
      const body = { ...f, durationValue: f.durationUnit === "lifetime" ? 1 : f.durationValue };
      if (plan) await put(`/api/plans/${plan.id}`, body);
      else await post(`/api/bots/${botId}/plans`, body);
      reload();
    }, plan ? "Plano salvo" : "Plano criado");
  return (
    <div className="plan-row">
      <label className="field">
        Nome no botão
        <input type="text" value={f.name} placeholder="Mensal (30 dias)" onChange={(e) => setF({ ...f, name: e.target.value })} />
      </label>
      <label className="field">
        Duração
        <input type="number" min={1} value={f.durationUnit === "lifetime" ? "" : f.durationValue} disabled={f.durationUnit === "lifetime"} onChange={(e) => setF({ ...f, durationValue: Math.max(1, Number(e.target.value) || 1) })} />
      </label>
      <label className="field">
        &nbsp;
        <select value={f.durationUnit} onChange={(e) => setF({ ...f, durationUnit: e.target.value as Unit })}>
          {UNIT_OPTIONS.map((u) => (
            <option key={u.value} value={u.value}>
              {u.label}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        Preço
        <MoneyField value={f.priceCents} onChange={(v) => setF({ ...f, priceCents: v })} />
      </label>
      <div className="row" style={{ paddingBottom: 2 }}>
        {dirty && (
          <button className="btn small primary" disabled={busy} onClick={save}>
            Salvar
          </button>
        )}
        {plan ? (
          <button
            className="btn small ghost danger"
            disabled={busy}
            onClick={() => confirm(`Apagar o plano "${plan.name}"? Quem já comprou continua com o acesso.`) && run(() => del(`/api/plans/${plan.id}`).then(reload), "Plano apagado")}
          >
            Apagar
          </button>
        ) : (
          onCancel && (
            <button className="btn small ghost" onClick={onCancel}>
              Cancelar
            </button>
          )
        )}
      </div>
      <div style={{ gridColumn: "1 / -1" }}>
        <Toggle checked={f.highlight} onChange={(v) => setF({ ...f, highlight: v })}>
          <span className="small">Destacar com ⭐ ({durationLabel(f.durationUnit, f.durationValue)})</span>
        </Toggle>
      </div>
    </div>
  );
}

const MODES = [
  { k: "fixed", t: "Sempre o primeiro", d: "Usa o primeiro da lista. Os outros só entram se ele der erro." },
  { k: "alternar", t: "Alternar", d: "Cada Pix vai para o que gerou menos cobranças hoje." },
  { k: "equilibrar", t: "Equilibrar por valor", d: "Cada Pix vai para o que recebeu menos dinheiro hoje." },
  { k: "limite", t: "Limite por dia", d: "Usa o primeiro até o limite do dia e passa para o próximo." },
] as const;

function PaymentTab({ draft, setDraft, gateways, reload }: TabProps & { gateways: Gateway[] }) {
  const { busy, run } = useAction();
  const r = draft.routing;
  if (!gateways.length)
    return (
      <div className="panel empty">
        <h2>Nenhuma forma de pagamento</h2>
        <p>Cadastre a PushinPay (ou outra) e volte aqui para ligar neste bot.</p>
        <Link className="btn primary" to="/pagamentos">
          Cadastrar forma de pagamento
        </Link>
      </div>
    );
  const selected = r.gatewayIds.map((id) => gateways.find((g) => g.id === id)).filter((g): g is Gateway => !!g);
  const others = gateways.filter((g) => !r.gatewayIds.includes(g.id));
  const setIds = (ids: string[]) => setDraft({ ...draft, routing: { ...r, gatewayIds: ids } });
  const move = (i: number, d: -1 | 1) => {
    const ids = [...r.gatewayIds];
    const j = i + d;
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j]!, ids[i]!];
    setIds(ids);
  };
  return (
    <div className="panel stack">
      <div>
        <h2>Onde o Pix é gerado</h2>
        <p className="muted small">Se um gateway der erro na hora de gerar o Pix, o próximo da lista assume sozinho.</p>
      </div>
      <div className="list">
        {selected.map((g, i) => (
          <div className="list-item" key={g.id}>
            <span className="chip plain">{i + 1}º</span>
            <div className="grow">
              <b>{g.label}</b> <span className="muted small">{PROVIDER_NAME[g.provider]}</span>
              {!g.active && <span className="chip warn" style={{ marginLeft: 8 }}>Desativado</span>}
            </div>
            {r.mode === "limite" && (
              <div style={{ width: 150 }}>
                <MoneyField
                  value={r.dailyLimitCents?.[g.id] ?? null}
                  placeholder="Limite/dia"
                  onChange={(v) => setDraft({ ...draft, routing: { ...r, dailyLimitCents: { ...(r.dailyLimitCents ?? {}), ...(v ? { [g.id]: v } : {}) } } })}
                />
              </div>
            )}
            <button className="btn small ghost" disabled={i === 0} onClick={() => move(i, -1)} aria-label="Subir">
              ↑
            </button>
            <button className="btn small ghost" disabled={i === selected.length - 1} onClick={() => move(i, 1)} aria-label="Descer">
              ↓
            </button>
            <button className="btn small" onClick={() => setIds(r.gatewayIds.filter((x) => x !== g.id))}>
              Tirar
            </button>
          </div>
        ))}
        {!selected.length && <p className="muted">Nenhuma forma ligada. Os clientes não conseguem pagar enquanto não ligar pelo menos uma.</p>}
      </div>
      {others.length > 0 && (
        <div className="row">
          {others.map((g) => (
            <button key={g.id} className="btn small" onClick={() => setIds([...r.gatewayIds, g.id])}>
              + {g.label}
            </button>
          ))}
        </div>
      )}
      {selected.length > 1 && (
        <div className="stack">
          <h3>Como dividir os Pix</h3>
          {MODES.map((m) => (
            <label key={m.k} className="choice">
              <input type="radio" name="mode" checked={r.mode === m.k} onChange={() => setDraft({ ...draft, routing: { ...r, mode: m.k } })} />
              <div>
                <b>{m.t}</b>
                <span>{m.d}</span>
              </div>
            </label>
          ))}
        </div>
      )}
      <SaveBar busy={busy} onSave={() => run(() => put(`/api/bots/${draft.id}`, { routing: r }).then(reload), "Pagamento salvo")} />
    </div>
  );
}

function OffersTab({ draft, setDraft, channels, plans, reload }: TabProps & { channels: Channel[]; plans: Plan[] }) {
  const rn = draft.upsell.renewal ?? { enabled: false, extraChannelId: null, longPlanId: null };
  const setRn = (v: typeof rn) => setDraft({ ...draft, upsell: { ...draft.upsell, renewal: v } });
  const { busy, run } = useAction();
  const ob = draft.upsell.orderBump ?? { enabled: false, channelIds: [] };
  const extras = channels.filter((c) => c.active && c.id !== draft.mainChannelId);
  const ps = draft.upsell.postSale ?? { enabled: false, discountPct: 20, validMinutes: 30 };
  const setPs = (v: typeof ps) => setDraft({ ...draft, upsell: { ...draft.upsell, postSale: v } });
  const setOb = (v: typeof ob) => setDraft({ ...draft, upsell: { ...draft.upsell, orderBump: v } });
  return (
    <div className="panel stack">
      <div>
        <h2>Canal extra antes do Pix</h2>
        <p className="muted small">
          Depois de escolher o plano, o cliente vê uma oferta: “adicionar o canal X por +R$”. Se aceitar, sai um Pix só e o extra vence junto com o plano. Quem já tem o canal ou recusou nos
          últimos 30 dias não recebe a oferta.
        </p>
      </div>
      <Toggle checked={ob.enabled} onChange={(v) => setOb({ ...ob, enabled: v })}>
        Oferecer canal extra
      </Toggle>
      {ob.enabled &&
        (extras.length ? (
          <div className="stack">
            <p className="small muted">Marque os canais na ordem de preferência. O primeiro que o cliente ainda não tem é o oferecido.</p>
            {extras.map((c) => {
              const on = ob.channelIds.includes(c.id);
              const price = ob.priceOverrides?.[c.id] ?? null;
              return (
                <div key={c.id} className="row" style={{ alignItems: "center" }}>
                  <Toggle checked={on} onChange={(v) => setOb({ ...ob, channelIds: v ? [...ob.channelIds, c.id] : ob.channelIds.filter((x) => x !== c.id) })}>
                    {c.title}
                  </Toggle>
                  <span className="spacer" />
                  {on && (
                    <div style={{ width: 160 }}>
                      <MoneyField
                        value={price}
                        placeholder={c.extraPriceCents ? (c.extraPriceCents / 100).toFixed(2).replace(".", ",") : "Preço"}
                        onChange={(v) => {
                          const po = { ...(ob.priceOverrides ?? {}) };
                          if (v) po[c.id] = v;
                          else delete po[c.id];
                          setOb({ ...ob, priceOverrides: po });
                        }}
                      />
                    </div>
                  )}
                </div>
              );
            })}
            <p className="small muted">Sem preço aqui, vale o “preço como adicional” definido em Canais.</p>
          </div>
        ) : (
          <div className="note warn small">Cadastre outros canais para oferecer como extra.</div>
        ))}
      <hr style={{ border: 0, borderTop: "1px solid var(--line-2)", width: "100%" }} />
      <div>
        <h2>Oferta depois da compra</h2>
        <p className="muted small">
          Quem recusou o canal extra e pagou recebe, logo depois da confirmação, uma última chance com desconto e prazo curto. O canal oferecido é o mesmo que ele recusou. Precisa do “Canal extra antes do Pix”
          ligado acima. Uma oferta por compra.
        </p>
      </div>
      <Toggle checked={ps.enabled} onChange={(v) => setPs({ ...ps, enabled: v })}>
        Oferecer depois da compra
      </Toggle>
      {ps.enabled && (
        <div className="grid-2">
          <label className="field">
            Desconto (%)
            <input type="number" min={0} max={90} value={ps.discountPct} onChange={(e) => setPs({ ...ps, discountPct: Math.max(0, Math.min(90, Number(e.target.value) || 0)) })} />
          </label>
          <label className="field">
            A oferta vale por (minutos)
            <input type="number" min={1} max={1440} value={ps.validMinutes} onChange={(e) => setPs({ ...ps, validMinutes: Math.max(1, Math.min(1440, Number(e.target.value) || 1)) })} />
          </label>
        </div>
      )}
      <hr style={{ border: 0, borderTop: "1px solid var(--line-2)", width: "100%" }} />
      <div>
        <h2>Na renovação</h2>
        <p className="muted small">
          Os lembretes de vencimento já trazem o botão “Renovar”. Aqui você pode juntar mais dois botões na mesma mensagem, sem mandar nada a mais: renovar com um canal extra e um plano mais longo.
        </p>
      </div>
      <Toggle checked={rn.enabled} onChange={(v) => setRn({ ...rn, enabled: v })}>
        Oferecer opções na renovação
      </Toggle>
      {rn.enabled && (
        <div className="grid-2">
          <label className="field">
            Botão “Renovar + canal extra”
            <select value={rn.extraChannelId ?? ""} onChange={(e) => setRn({ ...rn, extraChannelId: e.target.value || null })}>
              <option value="">Não mostrar</option>
              {extras.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.title}
                </option>
              ))}
            </select>
            <small>Só aparece para quem ainda não tem o canal.</small>
          </label>
          <label className="field">
            Botão do plano mais longo
            <select value={rn.longPlanId ?? ""} onChange={(e) => setRn({ ...rn, longPlanId: e.target.value || null })}>
              <option value="">Não mostrar</option>
              {plans
                .filter((p) => p.active)
                .map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} — {brl(p.priceCents)}
                  </option>
                ))}
            </select>
            <small>Ex.: semestral, para quem renova todo mês.</small>
          </label>
        </div>
      )}
      <hr style={{ border: 0, borderTop: "1px solid var(--line-2)", width: "100%" }} />
      <div>
        <h2>Recuperar Pix não pago</h2>
        <p className="muted small">
          Quem gerou o Pix e não pagou recebe mensagens automáticas (por padrão: 15 minutos depois, 2 horas depois com desconto e 24 horas depois com o plano mais barato). Os textos, os tempos e o desconto
          ficam em <Link to="/lembretes">Lembretes</Link>.
        </p>
      </div>
      <Toggle checked={!!draft.recovery?.enabled} onChange={(v) => setDraft({ ...draft, recovery: { ...draft.recovery, enabled: v } })}>
        Recuperar Pix não pago
      </Toggle>
      {draft.recovery?.enabled && (
        <label className="field">
          Plano mais barato da última mensagem
          <select value={draft.recovery.downsellPlanId ?? ""} onChange={(e) => setDraft({ ...draft, recovery: { ...draft.recovery, downsellPlanId: e.target.value || null } })}>
            <option value="">Não oferecer (repete o mesmo plano)</option>
            {plans
              .filter((p) => p.active)
              .map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} — {brl(p.priceCents)}
                </option>
              ))}
          </select>
          <small>Só é oferecido para quem tentou comprar algo mais caro que este plano.</small>
        </label>
      )}
      <hr style={{ border: 0, borderTop: "1px solid var(--line-2)", width: "100%" }} />
      <Toggle checked={draft.showBundles} onChange={(v) => setDraft({ ...draft, showBundles: v })}>
        Mostrar o botão “Pacotes promocionais” na lista de planos
      </Toggle>
      <SaveBar busy={busy} onSave={() => run(() => put(`/api/bots/${draft.id}`, { upsell: draft.upsell, showBundles: draft.showBundles, recovery: { enabled: !!draft.recovery?.enabled, downsellPlanId: draft.recovery?.downsellPlanId ?? null } }).then(reload), "Ofertas salvas")} />
    </div>
  );
}

/** Prévia do que o cliente vê no Telegram, atualizada enquanto edita. */
function ChatPreview({ bot, plans, channelTitle }: { bot: BotDetail; plans: Plan[]; channelTitle?: string }) {
  const media = bot.welcome.media;
  const html = useMemo(
    () =>
      (bot.welcome.text || "Escreva a mensagem de boas-vindas…")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/&lt;(\/?)(b|i|u|s)>/g, "<$1$2>"),
    [bot.welcome.text],
  );
  return (
    <aside className="phone" aria-label="Prévia no Telegram">
      <div className="phone-head">
        <div className="avatar">{bot.name.slice(0, 1).toUpperCase()}</div>
        <div>
          {bot.name}
          <small>bot</small>
        </div>
      </div>
      <div className="chat">
        <div className="bubble me">/start</div>
        <div className="bubble">
          {mediaSrc(media) && (
            <div className="media">
              {media!.type === "video" ? (
                <video src={mediaSrc(media)!} muted playsInline />
              ) : (
                <img src={mediaSrc(media)!} alt="" onError={(e) => (e.currentTarget.style.display = "none")} />
              )}
            </div>
          )}
          <div className="txt" dangerouslySetInnerHTML={{ __html: html }} />
        </div>
        <div className="kb">
          <div>💎 Ver planos</div>
          {bot.previewUrl && <div>{bot.previewButton || "👀 Ver prévias grátis"} ↗</div>}
        </div>
        {plans.length > 0 && (
          <>
            <div className="bubble">
              <div className="txt">
                <b>💎 Escolha seu plano:</b>
              </div>
            </div>
            <div className="kb">
              {plans.map((p) => (
                <div key={p.id}>
                  {p.highlight ? "⭐ " : ""}
                  {p.name} — {brl(p.priceCents)}
                </div>
              ))}
              {bot.showBundles && <div>🔥 Pacotes promocionais</div>}
            </div>
          </>
        )}
      </div>
      <p className="phone-note">{channelTitle ? `Vende o canal ${channelTitle}` : "Escolha o canal na aba Geral"}</p>
    </aside>
  );
}

/** Imagem/vídeo da boas-vindas: enviar arquivo (com os limites do Telegram) ou usar um link. */
export function MediaPicker({ value, onChange, label }: { value: Media | null; onChange: (m: Media | null) => void; label?: string }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [linkMode, setLinkMode] = useState(!!value?.url && !value?.mediaId);
  const src = mediaSrc(value);
  async function pick(f: File | undefined) {
    if (!f) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await uploadMedia(f);
      onChange({ type: r.kind, mediaId: r.id });
      setLinkMode(false);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="field">
      {label ?? "Imagem ou vídeo de demonstração"}
      <small>Foto (JPG, PNG, WEBP) até 10 MB, ou vídeo (MP4, MOV) e GIF até 50 MB. Esses são os limites do Telegram para bots.</small>
      <div className="row" style={{ alignItems: "flex-start" }}>
        {src && (
          <div style={{ width: 120, height: 90, borderRadius: 10, overflow: "hidden", background: "var(--line-2)", flex: "none" }}>
            {value!.type === "video" ? <video src={src} muted playsInline style={{ width: "100%", height: "100%", objectFit: "cover" }} /> : <img src={src} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />}
          </div>
        )}
        <div className="stack" style={{ gap: 8, flex: 1, minWidth: 200 }}>
          <div className="row">
            <label className="btn small" style={{ cursor: busy ? "wait" : "pointer" }}>
              {busy ? "Enviando…" : src ? "Trocar arquivo" : "Enviar arquivo"}
              <input type="file" accept="image/jpeg,image/png,image/webp,image/gif,video/mp4,video/quicktime" hidden disabled={busy} onChange={(e) => pick(e.target.files?.[0])} />
            </label>
            <button type="button" className="btn small ghost" onClick={() => setLinkMode(!linkMode)}>
              {linkMode ? "Esconder link" : "Usar um link"}
            </button>
            {src && (
              <button type="button" className="btn small ghost danger" onClick={() => (onChange(null), setLinkMode(false))}>
                Tirar mídia
              </button>
            )}
          </div>
          {linkMode && (
            <input
              type="url"
              value={value?.url ?? ""}
              placeholder="https://... (.jpg, .png, .mp4)"
              onChange={(e) => {
                const url = e.target.value;
                const type = /\.(mp4|mov|webm)(\?|$)/i.test(url) ? "video" : /\.gif(\?|$)/i.test(url) ? "animation" : "photo";
                onChange(url ? { type, url } : null);
              }}
            />
          )}
          {err && <p className="error-text">{err}</p>}
        </div>
      </div>
    </div>
  );
}
