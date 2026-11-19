import { useEffect, useState } from "react";
import { del, get, post, put } from "../api";
import { Loading, Toggle, useAction, useLoad } from "../ui";

interface Tpl {
  id: string;
  kind: "reminder" | "winback" | "recovery";
  days: number;
  minutes: number;
  text: string;
  discountPct: number;
  enabled: boolean;
  mediaUrl: string | null;
}
interface Data {
  reminderTime: string;
  removeGraceHours: number;
  autoRemove: boolean;
  templates: Tpl[];
}

const VARS = "{nome} {canal} {vencimento} {dias} {valor} {desconto}";
const RECOVERY_VARS = "{nome} {plano} {valor} {desconto}";
const minutesLabel = (m: number) => (m >= 60 && m % 60 === 0 ? `${m / 60} h` : `${m} min`);

export function RemindersPage() {
  const d = useLoad(() => get<Data>("/api/templates"));
  const [adding, setAdding] = useState<Tpl["kind"] | null>(null);
  if (!d.data) return <Loading error={d.error} />;
  const reminders = d.data.templates.filter((t) => t.kind === "reminder");
  const winbacks = d.data.templates.filter((t) => t.kind === "winback");
  const recoveries = d.data.templates.filter((t) => t.kind === "recovery").sort((a, b) => a.minutes - b.minutes);
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Lembretes</h1>
          <p>Mensagens que o bot manda antes de vencer e depois de vencer. Cada uma já vai com o botão de renovar com o plano e o valor do cliente.</p>
        </div>
      </div>
      <Timing data={d.data} reload={d.reload} />
      <div className="panel">
        <div className="panel-head">
          <div>
            <h2>Pix gerado e não pago</h2>
            <p>
              Para quem gerou o Pix e não pagou. O tempo conta a partir da geração do Pix. A <b>última</b> mensagem oferece o plano mais barato escolhido na aba Ofertas de cada bot. Ligue por bot em
              Bots → Ofertas → “Recuperar Pix não pago”.
            </p>
          </div>
          <button className="btn" onClick={() => setAdding("recovery")}>
            Nova mensagem
          </button>
        </div>
        <div className="stack">
          {adding === "recovery" && <TplForm kind="recovery" onDone={() => (setAdding(null), d.reload())} onCancel={() => setAdding(null)} />}
          {recoveries.map((t) => (
            <TplForm key={t.id} tpl={t} kind={t.kind} onDone={d.reload} />
          ))}
        </div>
      </div>
      <div className="panel">
        <div className="panel-head">
          <div>
            <h2>Antes de vencer</h2>
            <p>Os botões de renovar com canal extra ou plano longo são ligados na aba Ofertas de cada bot.</p>
          </div>
          <button className="btn" onClick={() => setAdding("reminder")}>
            Nova mensagem
          </button>
        </div>
        <div className="stack">
          {adding === "reminder" && <TplForm kind="reminder" onDone={() => (setAdding(null), d.reload())} onCancel={() => setAdding(null)} />}
          {reminders.map((t) => (
            <TplForm key={t.id} tpl={t} kind={t.kind} onDone={d.reload} />
          ))}
        </div>
      </div>
      <div className="panel">
        <div className="panel-head">
          <div>
            <h2>Depois de vencer (“volte”)</h2>
            <p>Para quem não renovou. Pode dar desconto: ele vale só no botão daquela mensagem.</p>
          </div>
          <button className="btn" onClick={() => setAdding("winback")}>
            Nova mensagem
          </button>
        </div>
        <div className="stack">
          {adding === "winback" && <TplForm kind="winback" onDone={() => (setAdding(null), d.reload())} onCancel={() => setAdding(null)} />}
          {winbacks.map((t) => (
            <TplForm key={t.id} tpl={t} kind={t.kind} onDone={d.reload} />
          ))}
        </div>
      </div>
    </>
  );
}

function Timing({ data, reload }: { data: Data; reload: () => void }) {
  const [time, setTime] = useState(data.reminderTime);
  const [grace, setGrace] = useState(data.removeGraceHours);
  const { busy, run } = useAction();
  useEffect(() => {
    setTime(data.reminderTime);
    setGrace(data.removeGraceHours);
  }, [data]);
  const dirty = time !== data.reminderTime || grace !== data.removeGraceHours;
  return (
    <div className="panel">
      <div className="grid-2">
        <label className="field">
          Horário de envio
          <small>Horário de Brasília. “Vence hoje” sai mais cedo se o vencimento for antes desse horário.</small>
          <input type="time" value={time} onChange={(e) => setTime(e.target.value)} style={{ maxWidth: 160 }} />
        </label>
        <label className="field">
          Tolerância antes de remover
          <small>Horas depois do vencimento até a pessoa sair do canal (0 = na hora).</small>
          <input type="number" min={0} max={168} value={grace} onChange={(e) => setGrace(Math.max(0, Number(e.target.value) || 0))} style={{ maxWidth: 160 }} />
        </label>
      </div>
      {dirty && (
        <div className="row" style={{ marginTop: 14 }}>
          <button className="btn primary" disabled={busy} onClick={() => run(() => put("/api/reminder-settings", { reminderTime: time, removeGraceHours: grace }).then(reload), "Horários salvos")}>
            Salvar horários
          </button>
        </div>
      )}
    </div>
  );
}

function TplForm({ tpl, kind, onDone, onCancel }: { tpl?: Tpl; kind: Tpl["kind"]; onDone: () => void; onCancel?: () => void }) {
  const [f, setF] = useState({
    days: tpl ? Math.abs(tpl.days) : kind === "reminder" ? 2 : 3,
    minutes: tpl?.minutes ?? 30,
    text: tpl?.text ?? "",
    discountPct: tpl?.discountPct ?? 0,
    enabled: tpl?.enabled ?? true,
    mediaUrl: tpl?.mediaUrl ?? "",
  });
  const { busy, run } = useAction();
  const signedDays = kind === "reminder" ? -f.days : f.days;
  const dirty = !tpl || (kind === "recovery" ? f.minutes !== tpl.minutes : signedDays !== tpl.days) || f.text !== tpl.text || f.discountPct !== tpl.discountPct || f.mediaUrl !== (tpl.mediaUrl ?? "");
  const body = { kind, ...(kind === "recovery" ? { minutes: f.minutes } : { days: signedDays }), text: f.text, discountPct: f.discountPct, mediaUrl: f.mediaUrl || null };
  return (
    <div style={{ borderTop: "1px solid var(--line-2)", paddingTop: 14 }} className="stack">
      <div className="row">
        {kind === "recovery" ? (
          <label className="field" style={{ width: 190 }}>
            Minutos depois do Pix
            <small>{minutesLabel(f.minutes)} depois de gerar o Pix</small>
            <input type="number" min={5} max={2880} value={f.minutes} onChange={(e) => setF({ ...f, minutes: Math.min(2880, Math.max(5, Number(e.target.value) || 5)) })} />
          </label>
        ) : (
          <label className="field" style={{ width: 150 }}>
            {kind === "reminder" ? "Dias antes" : "Dias depois"}
            <input type="number" min={kind === "reminder" ? 0 : 1} max={60} value={f.days} onChange={(e) => setF({ ...f, days: Math.max(kind === "reminder" ? 0 : 1, Number(e.target.value) || 0) })} />
          </label>
        )}
        {(kind === "winback" || kind === "recovery") && (
          <label className="field" style={{ width: 150 }}>
            Desconto (%)
            <input type="number" min={0} max={90} value={f.discountPct} onChange={(e) => setF({ ...f, discountPct: Math.min(90, Math.max(0, Number(e.target.value) || 0)) })} />
          </label>
        )}
        <span className="spacer" />
        {tpl && (
          <Toggle checked={f.enabled} onChange={(v) => (setF({ ...f, enabled: v }), run(() => put(`/api/templates/${tpl.id}`, { enabled: v }).then(onDone), v ? "Mensagem ligada" : "Mensagem desligada"))}>
            {f.enabled ? "Ligada" : "Desligada"}
          </Toggle>
        )}
      </div>
      <label className="field">
        Texto
        <small>
          Pode usar: <code>{kind === "recovery" ? RECOVERY_VARS : VARS}</code>. {kind === "reminder" && f.days === 0 ? "Esta sai no dia do vencimento." : ""}
        </small>
        <textarea value={f.text} maxLength={1024} onChange={(e) => setF({ ...f, text: e.target.value })} style={{ minHeight: 90 }} />
      </label>
      <label className="field">
        Imagem ou vídeo (opcional)
        <input type="url" value={f.mediaUrl} placeholder="https://..." onChange={(e) => setF({ ...f, mediaUrl: e.target.value })} />
      </label>
      <div className="row">
        {dirty && (
          <button className="btn small primary" disabled={busy} onClick={() => run(() => (tpl ? put(`/api/templates/${tpl.id}`, body) : post("/api/templates", body)).then(onDone), "Mensagem salva")}>
            Salvar
          </button>
        )}
        {tpl ? (
          <button className="btn small ghost danger" disabled={busy} onClick={() => confirm("Apagar esta mensagem?") && run(() => del(`/api/templates/${tpl.id}`).then(onDone), "Mensagem apagada")}>
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
    </div>
  );
}
