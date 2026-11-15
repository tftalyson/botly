import { useState } from "react";
import { Link } from "react-router-dom";
import { brl, get, post, put } from "../api";
import { Loading, Toggle, useAction, useLoad } from "../ui";

type Range = "today" | "tomorrow" | "week";
interface Item {
  id: string;
  when: string;
  kind: "reminder" | "winback" | null;
  days: number | null;
  discountPct: number;
  status: "scheduled" | "sent" | "failed" | "skipped";
  outcome: "renewed" | "renewed_upsell" | "none" | null;
  error: string | null;
  expectedCents: number;
  customer: { tg: number; name: string };
  channel: string | null;
  expiresAt: string | null;
  bot: string | null;
}
interface Data {
  items: Item[];
  totals: { expectedCents: number; customers: number; sent: number; scheduled: number; renewed: number; upsell: number };
  autoRemove: boolean;
  removals: { id: string; expiresAt: string | null; channel: string; name: string }[];
}

const RANGES: [Range, string][] = [
  ["today", "Hoje"],
  ["tomorrow", "Amanhã"],
  ["week", "Próximos 7 dias"],
];

const fmt = (iso: string | null, withTime = false) =>
  iso ? new Date(iso).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit", ...(withTime ? { hour: "2-digit", minute: "2-digit" } : {}) }) : "vitalício";

function whichMsg(i: Item) {
  if (i.days == null) return "Mensagem";
  if (i.kind === "winback") return `Volte (${i.days}d depois${i.discountPct ? `, ${i.discountPct}% off` : ""})`;
  return i.days === 0 ? "Vence hoje" : `${-i.days}d antes`;
}

function StatusChip({ i }: { i: Item }) {
  if (i.outcome === "renewed_upsell") return <span className="chip ok">Renovou + extra</span>;
  if (i.outcome === "renewed") return <span className="chip ok">Renovou</span>;
  if (i.status === "sent") return <span className="chip plain">Enviado</span>;
  if (i.status === "scheduled") return <span className="chip">Agendado {fmt(i.when, true).split(" ")[1] ?? ""}</span>;
  if (i.status === "failed") return <span className="chip bad" title={i.error ?? ""}>Falhou</span>;
  return (
    <span className="chip plain" title={i.error ?? ""}>
      Não enviado{i.error ? `: ${i.error}` : ""}
    </span>
  );
}

export function RetentionPage() {
  const [range, setRange] = useState<Range>("today");
  const d = useLoad(() => get<Data>(`/api/retention?range=${range}`), [range]);
  const { busy, run } = useAction();
  if (!d.data) return <Loading error={d.error} />;
  const { totals, items } = d.data;
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Retenção</h1>
          <p>Avisos de vencimento e mensagens de “volte” que o bot manda. Quem renova pelo botão aparece aqui na hora.</p>
        </div>
        <div className="row">
          <Link className="btn" to="/lembretes">
            Editar mensagens
          </Link>
          <button className="btn ghost" disabled={busy} onClick={() => run(() => post("/api/retention/refresh").then(d.reload), "Fila atualizada")}>
            Atualizar
          </button>
        </div>
      </div>
      <div className="tabs" role="tablist">
        {RANGES.map(([k, label]) => (
          <button key={k} role="tab" aria-selected={range === k} className={range === k ? "on" : ""} onClick={() => setRange(k)}>
            {label}
          </button>
        ))}
      </div>
      <div className="hero-money">
        <div className="panel">
          <span className="muted">Esperado se todos renovarem</span>
          <div className="big">{brl(totals.expectedCents)}</div>
          <span className="muted">
            {totals.customers} {totals.customers === 1 ? "assinante vencendo" : "assinantes vencendo"}
          </span>
        </div>
        <div className="panel">
          <span className="muted">Andamento</span>
          <div className="big">
            {totals.renewed}
            <span style={{ fontSize: 18, fontWeight: 600, marginLeft: 8 }}>{totals.renewed === 1 ? "renovou" : "renovaram"}</span>
          </div>
          <span className="muted">
            {totals.sent} enviados, {totals.scheduled} agendados{totals.upsell ? `, ${totals.upsell} com extra` : ""}
          </span>
        </div>
      </div>
      <div className="panel">
        {items.length === 0 ? (
          <div className="empty">
            <h2>Nada {range === "today" ? "hoje" : range === "tomorrow" ? "amanhã" : "nos próximos 7 dias"}</h2>
            <p>Os avisos aparecem aqui quando algum assinante estiver perto de vencer.</p>
          </div>
        ) : (
          <div className="list">
            {items.map((i) => (
              <div className="list-item" key={i.id}>
                <div className="grow">
                  <span className="title">{i.customer.name}</span> <span className="muted small">{i.channel}</span>
                  <div className="small muted">
                    {whichMsg(i)}, vence {fmt(i.expiresAt)}
                    {range === "week" ? `, envio ${fmt(i.when, true)}` : ""}
                    {i.bot ? `, por @${i.bot}` : ""}
                  </div>
                </div>
                <b>{brl(i.expectedCents)}</b>
                <StatusChip i={i} />
              </div>
            ))}
          </div>
        )}
      </div>
      <RemovalPanel data={d.data} reload={d.reload} />
    </>
  );
}

function RemovalPanel({ data, reload }: { data: Data; reload: () => void }) {
  const { busy, run } = useAction();
  return (
    <div className="panel stack" style={{ marginTop: 16 }}>
      <div className="panel-head" style={{ marginBottom: 0 }}>
        <div>
          <h2>Remoção de quem venceu</h2>
          <p>{data.autoRemove ? "Ligada: quem vence e não renova sai do canal sozinho." : "Modo simulação: ninguém é removido. A lista mostra quem sairia."}</p>
        </div>
        <Toggle
          checked={data.autoRemove}
          onChange={(v) => {
            if (v && !confirm(`Ligar a remoção? ${data.removals.length} ${data.removals.length === 1 ? "pessoa vencida sai" : "pessoas vencidas saem"} do canal nos próximos minutos.`)) return;
            void run(() => put("/api/reminder-settings", { autoRemove: v }).then(reload), v ? "Remoção ligada" : "Modo simulação ligado");
          }}
        >
          {data.autoRemove ? "Ligada" : "Simulação"}
        </Toggle>
      </div>
      {data.removals.length > 0 ? (
        <>
          <p className="small muted">
            {data.removals.length} {data.removals.length === 1 ? "pessoa vencida" : "pessoas vencidas"} {data.autoRemove ? "na fila para sair" : "que sairiam"}:
          </p>
          <div className="list">
            {data.removals.slice(0, 50).map((r) => (
              <div className="list-item" key={r.id}>
                <div className="grow">
                  <span className="title">{r.name}</span> <span className="muted small">{r.channel}</span>
                </div>
                <span className="small muted">venceu {fmt(r.expiresAt, true)}</span>
              </div>
            ))}
          </div>
        </>
      ) : (
        !busy && <p className="small muted">Ninguém vencido no momento.</p>
      )}
    </div>
  );
}
