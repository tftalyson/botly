import { useEffect, useMemo, useState } from "react";
import { brl, get, mediaSrc, post, type BotDetail, type BotListItem, type Channel, type Media, type Plan } from "../api";
import { Loading, useAction, useLoad } from "../ui";
import { MediaPicker } from "./bot";

type Segment = "all" | "active" | "expired" | "never";
interface Audience {
  segment: Segment;
  channelId?: string | null;
  channelMode?: "has" | "hasnt";
  expiringDays?: number | null;
}
interface Item {
  id: string;
  name: string;
  status: "scheduled" | "sending" | "done" | "canceled";
  scheduledAt: string;
  finishedAt: string | null;
  audience: Audience;
  button: string;
  stats: { total: number; sent: number; pending: number; blocked: number; failed: number; clicks: number; sales: number; revenueCents: number };
}

const SEGMENTS: { value: Segment; label: string; hint: string }[] = [
  { value: "all", label: "Todos", hint: "Todo mundo que já falou com o bot" },
  { value: "active", label: "Clientes ativos", hint: "Com acesso em dia" },
  { value: "expired", label: "Ex-clientes", hint: "Já foram clientes e o acesso venceu" },
  { value: "never", label: "Nunca compraram", hint: "Deram /start e não pagaram" },
];

const when = (iso: string) => new Date(iso).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });

export function BroadcastsPage() {
  const list = useLoad(() => get<{ broadcasts: Item[] }>("/api/broadcasts"));
  const bots = useLoad(() => get<BotListItem[]>("/api/bots"));
  const chans = useLoad(() => get<Channel[]>("/api/channels"));
  const [creating, setCreating] = useState(false);
  const { busy, run } = useAction();
  const live = list.data?.broadcasts.some((b) => b.status === "sending" || b.status === "scheduled");
  useEffect(() => {
    if (!live) return;
    const t = setInterval(list.reload, 5000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live]);
  if (!list.data || !bots.data || !chans.data) return <Loading error={list.error ?? bots.error ?? chans.error} />;
  const segLabel = (a: Audience) => {
    let t = SEGMENTS.find((x) => x.value === a.segment)?.label ?? "";
    if (a.expiringDays) t += `, vencem em ${a.expiringDays} dias`;
    if (a.channelId) t += `, ${a.channelMode === "hasnt" ? "sem" : "com"} ${chans.data!.find((c) => c.id === a.channelId)?.title ?? "canal"}`;
    return t;
  };
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Transmissões</h1>
          <p>Mande uma mensagem pelo bot para quem já falou com ele. Escolha o público, programe o horário e acompanhe os resultados.</p>
        </div>
        <button className="btn primary" onClick={() => setCreating(true)} disabled={!bots.data.length}>
          Nova transmissão
        </button>
      </div>
      {creating && <Compose bots={bots.data} channels={chans.data} onClose={() => setCreating(false)} onDone={() => (setCreating(false), list.reload())} />}
      {list.data.broadcasts.length === 0 && !creating ? (
        <div className="panel empty">
          <h2>Nenhuma transmissão ainda</h2>
          <p>Use para avisar de promoção, lembrar quem sumiu ou oferecer um canal novo.</p>
        </div>
      ) : (
        <div className="panel">
          <div className="list">
            {list.data.broadcasts.map((b) => (
              <div className="list-item" key={b.id} style={{ alignItems: "flex-start" }}>
                <div className="grow">
                  <span className="title">{b.name}</span>{" "}
                  {b.status === "scheduled" && <span className="chip warn">Agendada para {when(b.scheduledAt)}</span>}
                  {b.status === "sending" && <span className="chip">Enviando {b.stats.sent + b.stats.blocked + b.stats.failed} de {b.stats.total}</span>}
                  {b.status === "done" && <span className="chip ok">Enviada {when(b.finishedAt ?? b.scheduledAt)}</span>}
                  {b.status === "canceled" && <span className="chip plain">Cancelada</span>}
                  <div className="small muted">Para: {segLabel(b.audience)}</div>
                  {b.status !== "scheduled" && (
                    <div className="small" style={{ marginTop: 4 }}>
                      {b.stats.sent} recebida{b.stats.sent === 1 ? "" : "s"} · {b.stats.blocked} bloquearam o bot
                      {b.stats.failed ? ` · ${b.stats.failed} falharam` : ""}
                      {b.button === "offer" || b.button === "plans" ? ` · ${b.stats.clicks} clique${b.stats.clicks === 1 ? "" : "s"}` : ""}
                      {b.stats.sales ? ` · ${b.stats.sales} venda${b.stats.sales === 1 ? "" : "s"} (${brl(b.stats.revenueCents)})` : ""}
                    </div>
                  )}
                </div>
                {(b.status === "scheduled" || b.status === "sending") && (
                  <button
                    className="btn small ghost danger"
                    disabled={busy}
                    onClick={() => confirm(b.status === "sending" ? "Parar esta transmissão? Quem já recebeu continua com a mensagem." : "Cancelar esta transmissão agendada?") && run(() => post(`/api/broadcasts/${b.id}/cancel`).then(list.reload), "Transmissão cancelada")}
                  >
                    {b.status === "sending" ? "Parar" : "Cancelar"}
                  </button>
                )}
              </div>
            ))}
          </div>
          <p className="small muted" style={{ marginTop: 10 }}>
            “Vendas” conta só pagamentos feitos pelo botão de oferta da própria transmissão.
          </p>
        </div>
      )}
    </>
  );
}

function Compose({ bots, channels, onClose, onDone }: { bots: BotListItem[]; channels: Channel[]; onClose: () => void; onDone: () => void }) {
  const { busy, run } = useAction();
  const usable = bots.filter((b) => b.status !== "error");
  const [name, setName] = useState("");
  const [botIds, setBotIds] = useState<string[]>(usable.map((b) => b.id));
  const [aud, setAud] = useState<Audience>({ segment: "all" });
  const [text, setText] = useState("");
  const [media, setMedia] = useState<Media | null>(null);
  const [btn, setBtn] = useState<{ kind: "none" | "plans" | "url" | "offer"; label: string; url: string; planId: string; discountPct: number; validMinutes: number }>({ kind: "none", label: "", url: "", planId: "", discountPct: 20, validMinutes: 60 });
  const [later, setLater] = useState(false);
  const [at, setAt] = useState("");
  const [count, setCount] = useState<number | null>(null);
  const [plans, setPlans] = useState<Plan[]>([]);

  const audKey = JSON.stringify([botIds, aud]);
  useEffect(() => {
    setCount(null);
    if (!botIds.length) return setCount(0);
    const t = setTimeout(() => {
      post<{ count: number }>("/api/broadcasts/audience", { botIds, audience: cleanAud(aud) })
        .then((r) => setCount(r.count))
        .catch(() => setCount(null));
    }, 350);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [audKey]);

  const oneBot = botIds.length === 1 ? botIds[0]! : null;
  useEffect(() => {
    if (btn.kind !== "offer" || !oneBot) return setPlans([]);
    get<{ bot: BotDetail; plans: Plan[] }>(`/api/bots/${oneBot}`).then((r) => {
      const act = r.plans.filter((p) => p.active);
      setPlans(act);
      setBtn((b) => (act.some((p) => p.id === b.planId) ? b : { ...b, planId: act[0]?.id ?? "" }));
    });
  }, [btn.kind, oneBot]);

  const html = useMemo(
    () =>
      (text || "Escreva a mensagem…")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/&lt;(\/?)(b|i|u|s)>/g, "<$1$2>")
        .replace(/\{nome\}/g, "Ana"),
    [text],
  );
  const limit = media ? 1024 : 4000;
  const offerPlan = plans.find((p) => p.id === btn.planId);
  const btnLabel = btn.label || (btn.kind === "plans" ? "💎 Ver planos" : btn.kind === "offer" ? "🎁 Quero a oferta" : "Abrir");
  const problem =
    !botIds.length ? "Escolha pelo menos um bot." :
    !text.trim() ? "Escreva a mensagem." :
    text.length > limit ? `O texto passou de ${limit} caracteres.` :
    btn.kind === "url" && !/^https?:\/\//.test(btn.url) ? "Coloque o link completo do botão (começa com https://)." :
    btn.kind === "offer" && !oneBot ? "A oferta com desconto só funciona com um bot escolhido." :
    btn.kind === "offer" && !btn.planId ? "Escolha o plano da oferta." :
    later && !at ? "Escolha o dia e a hora." : null;

  const contentBody = () => ({
    text,
    media: media ? { type: media.type, mediaId: media.mediaId ?? null, url: media.mediaId ? null : (media.url ?? null) } : null,
    button:
      btn.kind === "none"
        ? null
        : { kind: btn.kind, label: btn.label || undefined, url: btn.kind === "url" ? btn.url : undefined, planId: btn.kind === "offer" ? btn.planId : undefined, discountPct: btn.kind === "offer" ? btn.discountPct : undefined, validMinutes: btn.kind === "offer" ? btn.validMinutes : undefined },
  });
  const [testId, setTestId] = useState(() => {
    try {
      return localStorage.getItem("botly.testId") ?? "";
    } catch {
      return "";
    }
  });
  const sendTest = () =>
    run(async () => {
      try {
        localStorage.setItem("botly.testId", testId);
      } catch {
        /* sem armazenamento: tudo bem */
      }
      await post("/api/broadcasts/test", { botId: botIds[0], telegramUserId: Number(testId), content: contentBody() });
    }, "Teste enviado. Olhe o seu Telegram.");
  const testProblem = !botIds.length ? "Escolha um bot." : !text.trim() ? "Escreva a mensagem." : !/^\d{5,}$/.test(testId.trim()) ? "Coloque o seu ID do Telegram (só números)." : null;

  const send = () => {
    const n = count ?? 0;
    const quando = later ? `em ${new Date(at).toLocaleString("pt-BR")}` : "agora";
    if (!confirm(`Enviar para ${n} pessoa${n === 1 ? "" : "s"} ${quando}?`)) return;
    void run(async () => {
      await post("/api/broadcasts", {
        name: name || undefined,
        botIds,
        audience: cleanAud(aud),
        content: contentBody(),
        scheduledAt: later ? new Date(at).toISOString() : null,
      });
      onDone();
    }, later ? "Transmissão agendada" : "Transmissão iniciada");
  };

  return (
    <div className="bot-layout" style={{ marginBottom: 20 }}>
      <div className="panel stack">
        <h2>Nova transmissão</h2>
        <label className="field">
          Nome (só para você se achar)
          <input type="text" value={name} maxLength={80} placeholder="Ex.: Promoção de sexta" onChange={(e) => setName(e.target.value)} />
        </label>
        <div className="field">
          Enviar pelo bot
          <div className="stack" style={{ gap: 6 }}>
            {usable.map((b) => (
              <label key={b.id} className="row" style={{ gap: 8 }}>
                <input type="checkbox" checked={botIds.includes(b.id)} onChange={(e) => setBotIds(e.target.checked ? [...botIds, b.id] : botIds.filter((x) => x !== b.id))} />
                @{b.username}
              </label>
            ))}
          </div>
          <small>Cada pessoa recebe uma vez só, pelo bot em que falou por último. Só recebe quem não bloqueou o bot.</small>
        </div>
        <div className="field">
          Para quem
          <div className="stack" style={{ gap: 6 }}>
            {SEGMENTS.map((x) => (
              <label key={x.value} className="row" style={{ gap: 8 }}>
                <input type="radio" name="seg" checked={aud.segment === x.value} onChange={() => setAud({ ...aud, segment: x.value, expiringDays: x.value === "active" ? aud.expiringDays : null })} />
                <span>
                  <b>{x.label}</b> <span className="muted small">{x.hint}</span>
                </span>
              </label>
            ))}
          </div>
        </div>
        <div className="grid-2">
          <label className="field">
            Filtrar por canal (opcional)
            <select value={aud.channelId ?? ""} onChange={(e) => setAud({ ...aud, channelId: e.target.value || null, channelMode: aud.channelMode ?? "has" })}>
              <option value="">Sem filtro</option>
              {channels.filter((c) => c.active).map((c) => (
                <option key={c.id} value={c.id}>
                  {c.title}
                </option>
              ))}
            </select>
          </label>
          {aud.channelId && (
            <label className="field">
              Quem…
              <select value={aud.channelMode ?? "has"} onChange={(e) => setAud({ ...aud, channelMode: e.target.value as "has" | "hasnt" })}>
                <option value="has">tem acesso ativo a esse canal</option>
                <option value="hasnt">NÃO tem acesso a esse canal (bom para oferecer)</option>
              </select>
            </label>
          )}
          {aud.segment === "active" && (
            <label className="field">
              Só quem vence em até (dias)
              <input type="number" min={1} max={365} value={aud.expiringDays ?? ""} placeholder="Todos" onChange={(e) => setAud({ ...aud, expiringDays: e.target.value ? Number(e.target.value) : null })} />
            </label>
          )}
        </div>
        <div className="note">
          {count === null ? "Contando…" : (
            <>
              Vai para <b>{count}</b> pessoa{count === 1 ? "" : "s"}.
            </>
          )}
        </div>
        <hr style={{ border: 0, borderTop: "1px solid var(--line-2)", width: "100%" }} />
        <label className="field">
          Mensagem
          <textarea value={text} onChange={(e) => setText(e.target.value)} rows={6} />
          <small>
            Use {"{nome}"} para o primeiro nome. Negrito: &lt;b&gt;texto&lt;/b&gt;. {text.length}/{limit}
          </small>
        </label>
        <MediaPicker label="Imagem ou vídeo (opcional)" value={media} onChange={setMedia} />
        <div className="grid-2">
          <label className="field">
            Botão da mensagem
            <select value={btn.kind} onChange={(e) => setBtn({ ...btn, kind: e.target.value as typeof btn.kind })}>
              <option value="none">Sem botão</option>
              <option value="plans">Ver planos</option>
              <option value="offer">Oferta: plano com desconto e prazo</option>
              <option value="url">Abrir um link</option>
            </select>
          </label>
          {btn.kind !== "none" && (
            <label className="field">
              Texto do botão
              <input type="text" maxLength={60} value={btn.label} placeholder={btnLabel} onChange={(e) => setBtn({ ...btn, label: e.target.value })} />
            </label>
          )}
        </div>
        {btn.kind === "url" && (
          <label className="field">
            Link
            <input type="url" value={btn.url} placeholder="https://..." onChange={(e) => setBtn({ ...btn, url: e.target.value })} />
          </label>
        )}
        {btn.kind === "offer" &&
          (oneBot ? (
            <div className="grid-2">
              <label className="field">
                Plano
                <select value={btn.planId} onChange={(e) => setBtn({ ...btn, planId: e.target.value })}>
                  {plans.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name} — {brl(p.priceCents)}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                Desconto (%)
                <input type="number" min={0} max={90} value={btn.discountPct} onChange={(e) => setBtn({ ...btn, discountPct: Math.max(0, Math.min(90, Number(e.target.value) || 0)) })} />
              </label>
              <label className="field">
                A oferta vale por (minutos, a partir do envio)
                <input type="number" min={1} max={10080} value={btn.validMinutes} onChange={(e) => setBtn({ ...btn, validMinutes: Math.max(1, Number(e.target.value) || 1) })} />
              </label>
              {offerPlan && (
                <p className="small muted" style={{ alignSelf: "end" }}>
                  O cliente paga {brl(Math.round((offerPlan.priceCents * (100 - btn.discountPct)) / 100))} em vez de {brl(offerPlan.priceCents)}.
                </p>
              )}
            </div>
          ) : (
            <div className="note warn small">Para usar a oferta com desconto, deixe marcado só um bot.</div>
          ))}
        <div className="field">
          Testar antes (só para você)
          <div className="row">
            <input type="text" inputMode="numeric" placeholder="Seu ID do Telegram" value={testId} onChange={(e) => setTestId(e.target.value.replace(/\D/g, ""))} style={{ maxWidth: 220 }} />
            <button className="btn" disabled={busy || !!testProblem} onClick={sendTest} title={testProblem ?? ""}>
              Enviar teste
            </button>
          </div>
          <small>
            Vai pelo primeiro bot marcado, só para esse Telegram. Você precisa ter dado /start nesse bot. Não sabe seu ID? Mande /start para @userinfobot no Telegram. O botão da oferta só vale na transmissão de verdade.
          </small>
        </div>
        <hr style={{ border: 0, borderTop: "1px solid var(--line-2)", width: "100%" }} />
        <div className="field">
          Quando enviar
          <label className="row" style={{ gap: 8 }}>
            <input type="radio" name="when" checked={!later} onChange={() => setLater(false)} /> Agora
          </label>
          <label className="row" style={{ gap: 8 }}>
            <input type="radio" name="when" checked={later} onChange={() => setLater(true)} /> Programar
          </label>
          {later && <input type="datetime-local" value={at} onChange={(e) => setAt(e.target.value)} style={{ maxWidth: 260 }} />}
          <small>O público é montado na hora do envio, então quem entrar até lá também recebe.</small>
        </div>
        {problem && <p className="error-text small">{problem}</p>}
        <div className="row">
          <button className="btn primary" disabled={busy || !!problem || !count} onClick={send}>
            {later ? "Programar envio" : "Enviar agora"}
          </button>
          <button className="btn ghost" onClick={onClose}>
            Fechar
          </button>
        </div>
      </div>
      <aside className="phone" aria-label="Prévia no Telegram">
        <div className="phone-head">
          <div className="avatar">B</div>
          <div>
            Seu bot<small>bot</small>
          </div>
        </div>
        <div className="chat">
          <div className="bubble">
            {mediaSrc(media) && (
              <div className="media">{media!.type === "video" ? <video src={mediaSrc(media)!} muted playsInline /> : <img src={mediaSrc(media)!} alt="" onError={(e) => (e.currentTarget.style.display = "none")} />}</div>
            )}
            <div className="txt" dangerouslySetInnerHTML={{ __html: html }} />
          </div>
          {btn.kind !== "none" && (
            <div className="kb">
              <div>{btnLabel}</div>
            </div>
          )}
        </div>
        <p className="phone-note">Prévia aproximada</p>
      </aside>
    </div>
  );
}

function cleanAud(a: Audience): Audience {
  return { segment: a.segment, channelId: a.channelId || null, channelMode: a.channelId ? (a.channelMode ?? "has") : undefined, expiringDays: a.segment === "active" ? (a.expiringDays ?? null) : null };
}
