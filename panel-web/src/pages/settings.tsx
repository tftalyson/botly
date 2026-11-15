import { useEffect, useState } from "react";
import { get, put, type BotListItem } from "../api";
import { Loading, Toggle, useAction, useLoad } from "../ui";

interface Settings {
  name: string;
  ageGate?: boolean;
  notifyChatId?: number | null;
  notifyBotId?: string | null;
  offerCooldownDays?: number;
}

export function SettingsPage() {
  const st = useLoad(() => get<Settings>("/api/settings"));
  const bots = useLoad(() => get<BotListItem[]>("/api/bots"));
  const [f, setF] = useState<Settings | null>(null);
  const { busy, run } = useAction();
  useEffect(() => {
    if (st.data) setF(st.data);
  }, [st.data]);
  if (!f || !bots.data) return <Loading error={st.error ?? bots.error} />;
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Configurações</h1>
          <p>Valem para todos os bots da conta.</p>
        </div>
      </div>
      <div className="panel stack">
        <label className="field">
          Nome da operação
          <input type="text" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
        </label>
        <Toggle checked={f.ageGate ?? true} onChange={(v) => setF({ ...f, ageGate: v })}>
          Pedir confirmação de 18 anos no primeiro /start
        </Toggle>
        <label className="field">
          Dias sem repetir uma oferta recusada
          <input type="number" min={0} max={365} value={f.offerCooldownDays ?? 30} onChange={(e) => setF({ ...f, offerCooldownDays: Number(e.target.value) })} style={{ maxWidth: 120 }} />
        </label>
      </div>
      <div className="panel stack">
        <div>
          <h2>Avisos de venda</h2>
          <p className="muted small">Cada venda e renovação é avisada num canal ou grupo seu. O bot escolhido precisa ser administrador dele.</p>
        </div>
        <div className="grid-2">
          <label className="field">
            ID do canal de avisos
            <input
              type="text"
              value={f.notifyChatId ?? ""}
              placeholder="-1001234567890"
              onChange={(e) => {
                const n = Number(e.target.value.trim());
                setF({ ...f, notifyChatId: e.target.value.trim() && Number.isFinite(n) ? n : null });
              }}
            />
          </label>
          <label className="field">
            Bot que avisa
            <select value={f.notifyBotId ?? ""} onChange={(e) => setF({ ...f, notifyBotId: e.target.value || null })}>
              <option value="">O próprio bot que vendeu</option>
              {bots.data.map((b) => (
                <option key={b.id} value={b.id}>
                  @{b.username}
                </option>
              ))}
            </select>
          </label>
        </div>
      </div>
      <div className="row" style={{ marginTop: 16 }}>
        <button
          className="btn primary"
          disabled={busy}
          onClick={() =>
            run(
              () => put("/api/settings", { name: f.name, ageGate: f.ageGate ?? true, notifyChatId: f.notifyChatId ?? null, notifyBotId: f.notifyBotId ?? null, offerCooldownDays: f.offerCooldownDays ?? 30 }),
              "Configurações salvas",
            )
          }
        >
          {busy ? "Salvando…" : "Salvar configurações"}
        </button>
      </div>
    </>
  );
}
