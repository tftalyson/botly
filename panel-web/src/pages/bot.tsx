import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { brl, del, durationLabel, get, post, put, PROVIDER_NAME, type BotDetail, type Channel, type Gateway, type Plan, type Unit } from "../api";
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
          {tab === "ofertas" && <OffersTab draft={draft} setDraft={setDraft} channels={chans.data} reload={bot.reload} />}
        </div>
        <ChatPreview bot={draft} plans={plans.filter((p) => p.active)} channelTitle={main?.title} />
      </div>
    </>
  );
}

function NewBotNote({ username }: { username: string }) {
  return (
    <div className="note" style={{ marginBottom: 16 }}>
      <b>Bot conectado.</b> Agora, no Telegram, adicione o <b>@{username}</b> como <b>administrador</b> do canal VIP com as permissões “Convidar usuários via link” e “Banir usuários”. O canal
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
          welcome: { text: draft.welcome.text, media: media?.url ? { type: media.type, url: media.url } : null },
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

      <div className="grid-2">
        <label className="field">
          Imagem ou vídeo de demonstração
          <small>Link público do arquivo (.jpg, .png, .mp4). Deixe vazio para mandar só o texto.</small>
          <input
            type="url"
            value={media?.url ?? ""}
            placeholder="https://..."
            onChange={(e) => {
              const url = e.target.value;
              const type = /\.(mp4|mov|webm)(\?|$)/i.test(url) ? "video" : /\.gif(\?|$)/i.test(url) ? "animation" : (media?.type ?? "photo");
              setDraft({ ...draft, welcome: { ...draft.welcome, media: url ? { type, url } : null } });
            }}
          />
        </label>
        <label className="field">
          Tipo
          <small>&nbsp;</small>
          <select
            value={media?.type ?? "photo"}
            disabled={!media?.url}
            onChange={(e) => setDraft({ ...draft, welcome: { ...draft.welcome, media: media ? { ...media, type: e.target.value as "photo" } : null } })}
          >
            <option value="photo">Imagem</option>
            <option value="video">Vídeo</option>
            <option value="animation">GIF</option>
          </select>
        </label>
      </div>

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
      {saved.welcome.media?.url !== media?.url && media?.url && <p className="small muted">A mídia nova é enviada para o Telegram no primeiro /start depois de salvar.</p>}
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

function OffersTab({ draft, setDraft, channels, reload }: TabProps & { channels: Channel[] }) {
  const { busy, run } = useAction();
  const ob = draft.upsell.orderBump ?? { enabled: false, channelIds: [] };
  const extras = channels.filter((c) => c.active && c.id !== draft.mainChannelId);
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
            <p className="small muted">Sem preço aqui, vale o “preço como extra” definido em Canais.</p>
          </div>
        ) : (
          <div className="note warn small">Cadastre outros canais para oferecer como extra.</div>
        ))}
      <hr style={{ border: 0, borderTop: "1px solid var(--line-2)", width: "100%" }} />
      <Toggle checked={draft.showBundles} onChange={(v) => setDraft({ ...draft, showBundles: v })}>
        Mostrar o botão “Pacotes promocionais” na lista de planos
      </Toggle>
      <SaveBar busy={busy} onSave={() => run(() => put(`/api/bots/${draft.id}`, { upsell: draft.upsell, showBundles: draft.showBundles }).then(reload), "Ofertas salvas")} />
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
          {media?.url && (
            <div className="media">{media.type === "photo" ? <img src={media.url} alt="" onError={(e) => (e.currentTarget.style.display = "none")} /> : media.type === "video" ? "▶ vídeo" : "GIF"}</div>
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
