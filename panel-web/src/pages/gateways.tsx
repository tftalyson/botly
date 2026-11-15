import { useState, type FormEvent } from "react";
import { brl, del, get, post, put, PROVIDER_NAME, type Gateway } from "../api";
import { Loading, Modal, Toggle, useAction, useLoad, useToast } from "../ui";

export function GatewaysPage() {
  const list = useLoad(() => get<Gateway[]>("/api/gateways"));
  const [adding, setAdding] = useState(false);
  const [editKey, setEditKey] = useState<Gateway | null>(null);
  const { busy, run } = useAction();
  const toast = useToast();
  if (!list.data) return <Loading error={list.error} />;
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Formas de pagamento</h1>
          <p>Contas de Pix cadastradas. Em cada bot você escolhe quais usar e como dividir os pagamentos entre elas.</p>
        </div>
        <button className="btn primary" onClick={() => setAdding(true)}>
          Cadastrar
        </button>
      </div>
      {list.data.length === 0 ? (
        <div className="panel empty">
          <h2>Nenhuma forma de pagamento</h2>
          <p>Cadastre a sua conta da PushinPay para os bots começarem a gerar Pix.</p>
          <button className="btn primary" onClick={() => setAdding(true)}>
            Cadastrar PushinPay
          </button>
        </div>
      ) : (
        <div className="panel">
          <div className="list">
            {list.data.map((g) => (
              <div className="list-item" key={g.id}>
                <div className="grow">
                  <span className="title">{g.label}</span> <span className="muted small">{PROVIDER_NAME[g.provider]}</span>
                  {g.sandbox && <span className="chip warn" style={{ marginLeft: 8 }}>Teste</span>}
                  <div className="small muted">{g.bots.length ? `Usada por ${g.bots.map((b) => "@" + b).join(", ")}` : "Nenhum bot usa ainda"}</div>
                </div>
                <div style={{ textAlign: "right" }}>
                  <b style={{ color: "var(--money)" }}>{brl(g.todayCents)}</b>
                  <div className="small muted">hoje, {g.todayCount} Pix</div>
                </div>
                <Toggle checked={g.active} onChange={(v) => run(() => put(`/api/gateways/${g.id}`, { active: v }).then(list.reload), v ? "Ativada" : "Desativada")} />
                <button
                  className="btn small"
                  disabled={busy}
                  onClick={() =>
                    run(async () => {
                      const r = await post<{ ok: boolean; error?: string }>(`/api/gateways/${g.id}/test`);
                      if (!r.ok) throw new Error(r.error);
                      toast("Conexão funcionando");
                    })
                  }
                >
                  Testar
                </button>
                <button className="btn small ghost" onClick={() => setEditKey(g)}>
                  Trocar chave
                </button>
                <button
                  className="btn small ghost danger"
                  disabled={busy}
                  onClick={() => confirm(`Apagar "${g.label}"? Os bots que usam param de gerar Pix por ela.`) && run(() => del(`/api/gateways/${g.id}`).then(list.reload), "Apagada")}
                >
                  Apagar
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
      {adding && <GatewayForm onClose={() => setAdding(false)} onDone={() => (setAdding(false), list.reload())} />}
      {editKey && <GatewayForm gateway={editKey} onClose={() => setEditKey(null)} onDone={() => (setEditKey(null), list.reload())} />}
    </>
  );
}

function GatewayForm({ gateway, onClose, onDone }: { gateway?: Gateway; onClose: () => void; onDone: () => void }) {
  const [provider, setProvider] = useState<Gateway["provider"]>(gateway?.provider ?? "pushinpay");
  const [label, setLabel] = useState(gateway?.label ?? "PushinPay");
  const [key, setKey] = useState("");
  const [sandbox, setSandbox] = useState(gateway?.sandbox ?? false);
  const { busy, run } = useAction();
  async function submit(e: FormEvent) {
    e.preventDefault();
    const ok = await run(() => (gateway ? put(`/api/gateways/${gateway.id}`, { key, sandbox }) : post("/api/gateways", { provider, label, key, sandbox })), "Forma de pagamento salva");
    if (ok) onDone();
  }
  return (
    <Modal title={gateway ? `Trocar chave: ${gateway.label}` : "Cadastrar forma de pagamento"} onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        {!gateway && (
          <>
            <div className="stack" style={{ gap: 8 }}>
              {(["pushinpay", "paggone"] as const).map((p) => (
                <label key={p} className="choice">
                  <input
                    type="radio"
                    name="provider"
                    checked={provider === p}
                    onChange={() => {
                      setProvider(p);
                      if (label === PROVIDER_NAME[provider]) setLabel(PROVIDER_NAME[p]);
                    }}
                  />
                  <div>
                    <b>{PROVIDER_NAME[p]}</b>
                    <span>{p === "pushinpay" ? "Aceita conteúdo adulto. Token em Configurações → API no painel da PushinPay." : "Chave da API no painel da Paggone."}</span>
                  </div>
                </label>
              ))}
            </div>
            <label className="field">
              Apelido
              <small>Para diferenciar quando tiver mais de uma conta.</small>
              <input type="text" value={label} maxLength={40} onChange={(e) => setLabel(e.target.value)} required />
            </label>
          </>
        )}
        <label className="field">
          {provider === "pushinpay" ? "Token da PushinPay" : "Chave da API"}
          <small>Fica guardado criptografado. Ninguém consegue ver depois, nem pelo painel.</small>
          <input type="password" value={key} onChange={(e) => setKey(e.target.value)} autoComplete="off" required />
        </label>
        <Toggle checked={sandbox} onChange={setSandbox}>
          Ambiente de testes (sandbox)
        </Toggle>
        <div className="row">
          <button className="btn primary" disabled={busy}>
            {busy ? "Salvando…" : "Salvar"}
          </button>
          <button type="button" className="btn ghost" onClick={onClose}>
            Cancelar
          </button>
        </div>
      </form>
    </Modal>
  );
}
