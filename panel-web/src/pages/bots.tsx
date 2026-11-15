import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { get, post, type BotListItem } from "../api";
import { Loading, Modal, useLoad } from "../ui";

export function BotsPage() {
  const { data, error } = useLoad(() => get<BotListItem[]>("/api/bots"));
  const [adding, setAdding] = useState(false);
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Bots</h1>
          <p>Cada bot vende um canal principal com os planos dele. Vários bots podem vender o mesmo canal.</p>
        </div>
        <button className="btn primary" onClick={() => setAdding(true)}>
          Conectar bot
        </button>
      </div>
      {!data ? (
        <Loading error={error} />
      ) : data.length === 0 ? (
        <div className="panel empty">
          <h2>Nenhum bot conectado</h2>
          <p>Crie um bot no @BotFather do Telegram e cole o token aqui. Leva dois minutos.</p>
          <button className="btn primary" onClick={() => setAdding(true)}>
            Conectar o primeiro bot
          </button>
        </div>
      ) : (
        <div className="panel">
          <div className="list">
            {data.map((b) => (
              <div className="list-item" key={b.id}>
                <div className="avatar">{b.name.slice(0, 1).toUpperCase()}</div>
                <div className="grow">
                  <Link className="title" to={`/bots/${b.id}`}>
                    @{b.username}
                  </Link>
                  <div className="small muted">
                    {b.mainChannel ? `Vende ${b.mainChannel}` : "Sem canal escolhido"}, {b.plans} {b.plans === 1 ? "plano" : "planos"}, {b.subscribers} assinantes
                  </div>
                </div>
                <BotStatus b={b} />
                <Link className="btn small" to={`/bots/${b.id}`}>
                  Configurar
                </Link>
              </div>
            ))}
          </div>
        </div>
      )}
      {adding && <AddBot onClose={() => setAdding(false)} />}
    </>
  );
}

function BotStatus({ b }: { b: BotListItem }) {
  if (b.status === "error") return <span className="chip bad">Desconectado</span>;
  if (b.status === "paused") return <span className="chip">Pausado</span>;
  if (!b.mainChannel || !b.plans || !b.hasPayment) return <span className="chip warn">Falta configurar</span>;
  return <span className="chip ok">Vendendo</span>;
}

export function AddBot({ onClose }: { onClose: () => void }) {
  const nav = useNavigate();
  const [token, setToken] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      const r = await post<{ id: string }>("/api/bots", { token });
      nav(`/bots/${r.id}?novo=1`);
    } catch (x) {
      setErr((x as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal title="Conectar bot" onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        <ol className="howto">
          <li>
            No Telegram, abra o <a href="https://t.me/BotFather" target="_blank" rel="noreferrer">@BotFather</a> e mande <code>/newbot</code>.
          </li>
          <li>Escolha o nome que os clientes vão ver e depois um usuário terminado em <code>bot</code>.</li>
          <li>
            Ele responde com um <b>token</b>, parecido com <code>7412345678:AAH…</code>. Copie e cole abaixo.
          </li>
        </ol>
        <div className="note warn small">
          Para migrar um bot que já vende em outro sistema, use o token dele. Assim que conectar aqui, ele para de responder no sistema antigo.
        </div>
        <label className="field">
          Token do bot
          <input type="text" value={token} onChange={(e) => setToken(e.target.value)} placeholder="1234567890:AA..." autoComplete="off" required />
        </label>
        {err && <p className="error-text">{err}</p>}
        <div className="row">
          <button className="btn primary" disabled={busy}>
            {busy ? "Conectando…" : "Conectar"}
          </button>
          <button type="button" className="btn ghost" onClick={onClose}>
            Cancelar
          </button>
        </div>
      </form>
    </Modal>
  );
}
