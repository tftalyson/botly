import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { brl, get, post, put } from "../api";
import { Loading, Modal, useAction, useLoad } from "../ui";

type Status = "open" | "active" | "closed";
interface ListItem {
  id: string;
  status: Status;
  topic: string | null;
  agentName: string | null;
  unread: number;
  lastMessageAt: string;
  bot: string | null;
  customer: { name: string | null; username: string | null; telegramUserId: number };
  preview: { sender: string; text: string } | null;
}
interface ListData {
  counts: { open: number; active: number };
  isOpenNow: boolean;
  hours: { start: string; end: string };
  tickets: ListItem[];
}
interface Msg {
  id: string;
  sender: "customer" | "agent" | "system";
  text: string | null;
  mediaType: "photo" | "document" | "video" | "voice" | null;
  agentName: string | null;
  createdAt: string;
}
interface Detail {
  ticket: { id: string; status: Status; topic: string | null; agentName: string | null; createdAt: string; bot: string | null };
  customer: { id: string; name: string | null; username: string | null; telegramUserId: number; totalSpentCents: number; purchases: number; since: string; pastTickets: number };
  accesses: { id: string; channel: string; status: string; expiresAt: string | null }[];
  orders: { id: string; createdAt: string; status: string; kind: string; totalCents: number; items: string[]; bot: string | null }[];
  messages: Msg[];
}

const TZ = "America/Sao_Paulo";
const who = (c: { name: string | null; username: string | null; telegramUserId: number }) => c.name || (c.username ? `@${c.username}` : `ID ${c.telegramUserId}`);
const initials = (c: ListItem["customer"]) => (c.name || c.username || "?").replace(/[^\p{L}\p{N} ]/gu, "").trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join("").toUpperCase() || "?";
function when(iso: string) {
  const d = new Date(iso);
  const today = new Date().toLocaleDateString("pt-BR", { timeZone: TZ });
  return d.toLocaleDateString("pt-BR", { timeZone: TZ }) === today
    ? d.toLocaleTimeString("pt-BR", { timeZone: TZ, hour: "2-digit", minute: "2-digit" })
    : d.toLocaleDateString("pt-BR", { timeZone: TZ, day: "2-digit", month: "2-digit" });
}
const fullDate = (iso: string) => new Date(iso).toLocaleString("pt-BR", { timeZone: TZ, day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
const dateOnly = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString("pt-BR", { timeZone: TZ }) : "vitalício");

const TABS: [Status, string][] = [
  ["open", "Aguardando"],
  ["active", "Atendendo"],
  ["closed", "Encerradas"],
];

export function SupportPage() {
  const { id } = useParams();
  const nav = useNavigate();
  const [tab, setTab] = useState<Status>("open");
  const [list, setList] = useState<ListData | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [settings, setSettings] = useState(false);

  async function loadList() {
    try {
      setList(await get<ListData>(`/api/support?status=${tab}`));
      setErr(null);
    } catch (e) {
      setErr((e as Error).message);
    }
  }
  useEffect(() => {
    void loadList();
    const t = setInterval(loadList, 5000);
    return () => clearInterval(t);
  }, [tab]);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Atendimento</h1>
          <p>
            Conversas de todos os bots num lugar só.{" "}
            {list && (
              <span className={`chip ${list.isOpenNow ? "ok" : "warn"}`}>
                {list.isOpenNow ? "Aberto agora" : "Fora do horário"} · {list.hours.start} às {list.hours.end}
              </span>
            )}
          </p>
        </div>
        <button className="btn" onClick={() => setSettings(true)}>
          Horário e nome
        </button>
      </div>

      <div className={`inbox${id ? " has-chat" : ""}`}>
        <section className="inbox-list">
          <div className="inbox-tabs">
            {TABS.map(([k, label]) => (
              <button key={k} className={tab === k ? "on" : ""} onClick={() => setTab(k)}>
                {label}
                {k !== "closed" && list && list.counts[k] > 0 && <b>{list.counts[k]}</b>}
              </button>
            ))}
          </div>
          {!list ? (
            <Loading error={err} />
          ) : list.tickets.length === 0 ? (
            <div className="inbox-empty">
              {tab === "open" ? "Ninguém esperando. Quando um cliente tocar em “Falar com um atendente”, a conversa aparece aqui." : tab === "active" ? "Nenhuma conversa em andamento." : "Nenhuma conversa encerrada ainda."}
            </div>
          ) : (
            <ul>
              {list.tickets.map((t) => (
                <li key={t.id}>
                  <button className={`thread${t.id === id ? " on" : ""}${t.unread ? " unread" : ""}`} onClick={() => nav(`/atendimento/${t.id}`)}>
                    <span className="avatar">{initials(t.customer)}</span>
                    <span className="thread-body">
                      <span className="thread-top">
                        <strong>{who(t.customer)}</strong>
                        <time>{when(t.lastMessageAt)}</time>
                      </span>
                      <span className="thread-preview">
                        {t.preview ? (t.preview.sender === "agent" ? "Você: " : "") + t.preview.text : ""}
                      </span>
                      <span className="thread-meta">
                        @{t.bot ?? "bot removido"}
                        {t.topic === "antes de comprar" && <em>antes de comprar</em>}
                      </span>
                    </span>
                    {t.unread > 0 && <span className="badge">{t.unread}</span>}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
        {id ? <Chat key={id} id={id} onBack={() => nav("/atendimento")} onChange={loadList} /> : <div className="inbox-pick">Escolha uma conversa à esquerda.</div>}
      </div>
      {settings && <SupportSettings onClose={() => setSettings(false)} onSaved={loadList} />}
    </>
  );
}

function Chat({ id, onBack, onChange }: { id: string; onBack: () => void; onChange: () => void }) {
  const [d, setD] = useState<Detail | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [info, setInfo] = useState(false);
  const { busy, run } = useAction();
  const end = useRef<HTMLDivElement>(null);
  const lastCount = useRef(0);

  async function load() {
    try {
      setD(await get<Detail>(`/api/support/${id}`));
    } catch (e) {
      setErr((e as Error).message);
    }
  }
  useEffect(() => {
    void load();
    const t = setInterval(load, 4000);
    return () => clearInterval(t);
  }, [id]);
  useEffect(() => {
    if (d && d.messages.length !== lastCount.current) {
      lastCount.current = d.messages.length;
      end.current?.scrollIntoView({ block: "end" });
    }
  }, [d]);

  async function send(e?: FormEvent) {
    e?.preventDefault();
    const t = text.trim();
    if (!t) return;
    const ok = await run(() => post(`/api/support/${id}/reply`, { text: t }));
    if (ok) {
      setText("");
      await load();
      onChange();
    }
  }
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  };
  const act = async (path: string, ok: string, body?: unknown) => {
    if (await run(() => post(`/api/support/${id}/${path}`, body), ok)) {
      await load();
      onChange();
    }
  };

  if (!d) return <section className="convo"><Loading error={err} /></section>;
  const closed = d.ticket.status === "closed";
  return (
    <>
      <section className="convo">
        <header className="convo-head">
          <button className="btn ghost small back" onClick={onBack} aria-label="Voltar para a lista">
            ← Conversas
          </button>
          <div className="convo-who">
            <strong>{who(d.customer)}</strong>
            <span className="muted small">
              {d.customer.username ? `@${d.customer.username} · ` : ""}pelo @{d.ticket.bot ?? "bot removido"}
            </span>
          </div>
          <div className="row">
            <button className="btn small info-toggle" onClick={() => setInfo((v) => !v)}>
              {info ? "Ocultar cliente" : "Ver cliente"}
            </button>
            {!closed && d.ticket.status === "open" && (
              <button className="btn small primary" disabled={busy} onClick={() => act("assume", "Você entrou na conversa.")}>
                Assumir
              </button>
            )}
            {!closed && (
              <button className="btn small" disabled={busy} onClick={() => act("close", "Atendimento encerrado.")}>
                Encerrar
              </button>
            )}
          </div>
        </header>
        <div className="convo-scroll">
          {d.messages.map((m) =>
            m.sender === "system" ? (
              <div key={m.id} className="sys">
                {m.text} · {when(m.createdAt)}
              </div>
            ) : (
              <div key={m.id} className={`msg ${m.sender}`}>
                {m.sender === "agent" && <span className="by">{m.agentName}</span>}
                {m.mediaType === "photo" && (
                  <a href={`/api/support/file/${m.id}`} target="_blank" rel="noreferrer">
                    <img
                      src={`/api/support/file/${m.id}`}
                      alt="📷 Foto enviada pelo cliente (abrir)"
                      loading="lazy"
                      onError={(e) => {
                        const s = document.createElement("span");
                        s.className = "photo-fail";
                        s.textContent = "📷 Foto (abrir)";
                        e.currentTarget.replaceWith(s);
                      }}
                    />
                  </a>
                )}
                {m.mediaType && m.mediaType !== "photo" && (
                  <a className="file" href={`/api/support/file/${m.id}`} target="_blank" rel="noreferrer">
                    {m.mediaType === "voice" ? "🎤 Áudio" : m.mediaType === "video" ? "🎬 Vídeo" : "📎 Arquivo"} (abrir)
                  </a>
                )}
                {m.text && <p>{m.text}</p>}
                <time>{fullDate(m.createdAt)}</time>
              </div>
            ),
          )}
          <div ref={end} />
        </div>
        {closed ? (
          <div className="convo-closed">Conversa encerrada. Se o cliente precisar de novo, ele toca em 💬 Suporte no bot.</div>
        ) : (
          <form className="composer" onSubmit={send}>
            <textarea value={text} onChange={(e) => setText(e.target.value)} onKeyDown={onKey} rows={2} placeholder="Escreva a resposta. Enter envia, Shift+Enter pula linha." />
            <button className="btn primary" disabled={busy || !text.trim()}>
              Enviar
            </button>
          </form>
        )}
      </section>
      <CustomerSide d={d} open={info} act={act} busy={busy} />
    </>
  );
}

function CustomerSide({ d, open, act, busy }: { d: Detail; open: boolean; act: (p: string, ok: string, body?: unknown) => Promise<void>; busy: boolean }) {
  const [extend, setExtend] = useState<{ accessId: string; days: string } | null>(null);
  const now = Date.now();
  const active = d.accesses.filter((a) => a.status === "active" && (!a.expiresAt || new Date(a.expiresAt).getTime() > now));
  return (
    <aside className={`cust${open ? " open" : ""}`}>
      <h3>Cliente</h3>
      <dl className="facts">
        <div>
          <dt>Gastou</dt>
          <dd className="money">{brl(d.customer.totalSpentCents)}</dd>
        </div>
        <div>
          <dt>Compras</dt>
          <dd>{d.customer.purchases}</dd>
        </div>
        <div>
          <dt>Cliente desde</dt>
          <dd>{dateOnly(d.customer.since)}</dd>
        </div>
        <div>
          <dt>Atendimentos antes</dt>
          <dd>{d.customer.pastTickets}</dd>
        </div>
      </dl>
      <h3>Acessos</h3>
      {d.accesses.length === 0 ? (
        <p className="muted small">Ainda não comprou.</p>
      ) : (
        <ul className="acc">
          {d.accesses.map((a) => {
            const on = active.includes(a);
            return (
              <li key={a.id}>
                <div>
                  <strong>{a.channel}</strong>
                  <span className={`chip ${on ? "ok" : "bad"}`}>{on ? `até ${dateOnly(a.expiresAt)}` : a.expiresAt ? `venceu ${dateOnly(a.expiresAt)}` : a.status}</span>
                </div>
                {a.expiresAt && (
                  <button className="btn small ghost" onClick={() => setExtend({ accessId: a.id, days: "3" })}>
                    Dar dias
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {active.length > 0 && d.ticket.status !== "closed" && (
        <button className="btn small" disabled={busy} onClick={() => act("send-links", "Links enviados ao cliente.")}>
          Reenviar links dos canais
        </button>
      )}
      <h3>Últimos pedidos</h3>
      {d.orders.length === 0 ? (
        <p className="muted small">Nenhum pedido.</p>
      ) : (
        <ul className="orders">
          {d.orders.map((o) => (
            <li key={o.id}>
              <span>
                {o.items.join(" + ")}
                <small className="muted">
                  {fullDate(o.createdAt)} · @{o.bot ?? "?"}
                </small>
              </span>
              <span className="num">
                {brl(o.totalCents)}
                <small className={o.status === "paid" ? "money" : "muted"}>{o.status === "paid" ? "pago" : o.status === "pending" ? "Pix em aberto" : o.status}</small>
              </span>
            </li>
          ))}
        </ul>
      )}
      {extend && (
        <Modal title="Dar dias de acesso" onClose={() => setExtend(null)}>
          <form
            className="stack"
            onSubmit={async (e) => {
              e.preventDefault();
              await act("extend", "Acesso estendido.", { accessId: extend.accessId, days: Number(extend.days) });
              setExtend(null);
            }}
          >
            <label className="field">
              Quantos dias somar ao vencimento?
              <input type="number" min={1} max={365} value={extend.days} onChange={(e) => setExtend({ ...extend, days: e.target.value })} />
              <small>Se já venceu, conta a partir de hoje. O cliente volta a poder entrar no canal.</small>
            </label>
            <button className="btn primary" disabled={busy || !(Number(extend.days) >= 1)}>
              Somar dias
            </button>
          </form>
        </Modal>
      )}
    </aside>
  );
}

function SupportSettings({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const st = useLoad(() => get<{ start: string; end: string; offMessage: string; supportName: string; defaultName: string }>("/api/support-settings"));
  const [f, setF] = useState<{ start: string; end: string; offMessage: string; supportName: string } | null>(null);
  const { busy, run } = useAction();
  useEffect(() => {
    if (st.data) setF(st.data);
  }, [st.data]);
  return (
    <Modal title="Horário e nome do atendimento" onClose={onClose}>
      {!f ? (
        <Loading error={st.error} />
      ) : (
        <form
          className="stack"
          onSubmit={async (e) => {
            e.preventDefault();
            if (await run(() => put("/api/support-settings", f), "Salvo.")) {
              onSaved();
              onClose();
            }
          }}
        >
          <label className="field">
            Seu nome no atendimento
            <input value={f.supportName} placeholder={st.data?.defaultName} onChange={(e) => setF({ ...f, supportName: e.target.value })} maxLength={40} />
            <small>Aparece para o cliente em cada resposta, assim: “{f.supportName || st.data?.defaultName}: Oi, tudo bem?”. Vazio usa o seu nome do painel.</small>
          </label>
          <div className="row">
            <label className="field">
              Abre às
              <input type="time" value={f.start} onChange={(e) => setF({ ...f, start: e.target.value })} />
            </label>
            <label className="field">
              Fecha às
              <input type="time" value={f.end} onChange={(e) => setF({ ...f, end: e.target.value })} />
            </label>
          </div>
          <label className="field">
            Mensagem fora do horário
            <textarea
              rows={3}
              value={f.offMessage}
              onChange={(e) => setF({ ...f, offMessage: e.target.value })}
              placeholder="🌙 Nosso atendimento é das {inicio} às {fim}. Deixe sua mensagem aqui que respondemos assim que abrirmos."
            />
            <small>Vazio usa a mensagem padrão. Use {"{inicio}"} e {"{fim}"} para o horário. Fora do horário o cliente ainda pode escrever; a conversa fica em Aguardando.</small>
          </label>
          <button className="btn primary" disabled={busy}>
            Salvar
          </button>
        </form>
      )}
    </Modal>
  );
}
