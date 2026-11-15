import { useState, type FormEvent } from "react";
import { del, get, post, put, type BotListItem, type Channel } from "../api";
import { Loading, Modal, MoneyField, useAction, useLoad } from "../ui";

export function ChannelsPage() {
  const chans = useLoad(() => get<Channel[]>("/api/channels"));
  const bots = useLoad(() => get<BotListItem[]>("/api/bots"));
  const [adding, setAdding] = useState(false);
  if (!chans.data || !bots.data) return <Loading error={chans.error ?? bots.error} />;
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Canais</h1>
          <p>Os canais e grupos VIP que você vende. Cada um tem um bot gestor, que cria o link de entrada, aprova quem pagou e remove quem venceu.</p>
        </div>
        <button className="btn" onClick={() => setAdding(true)} disabled={!bots.data.length}>
          Adicionar pelo ID
        </button>
      </div>
      <div className="note" style={{ marginBottom: 16 }}>
        Para cadastrar um canal, adicione um dos seus bots como <b>administrador</b> dele no Telegram, com a permissão “Adicionar inscritos” (em grupo: “Convidar usuários via link” e “Banir usuários”). Ele aparece aqui sozinho.
      </div>
      {chans.data.length === 0 ? (
        <div className="panel empty">
          <h2>Nenhum canal ainda</h2>
          <p>{bots.data.length ? "Coloque um bot como administrador do canal VIP e recarregue esta página." : "Conecte um bot primeiro, na página Bots."}</p>
        </div>
      ) : (
        <div className="panel">
          <div className="list">
            {chans.data.map((c) => (
              <ChannelRow key={c.id} c={c} bots={bots.data!} reload={chans.reload} />
            ))}
          </div>
        </div>
      )}
      {adding && <AddChannel bots={bots.data} onClose={() => setAdding(false)} onDone={() => (setAdding(false), chans.reload())} />}
    </>
  );
}

function ChannelRow({ c, bots, reload }: { c: Channel; bots: BotListItem[]; reload: () => void }) {
  const { busy, run } = useAction();
  const [price, setPrice] = useState<number | null>(c.extraPriceCents);
  return (
    <div className="list-item" style={{ alignItems: "flex-start" }}>
      <div className="avatar">{c.title.slice(0, 1).toUpperCase()}</div>
      <div className="grow stack" style={{ gap: 10 }}>
        <div className="row">
          <span className="title">{c.title}</span>
          {!c.active ? <span className="chip">Desativado</span> : c.rightsOk ? <span className="chip ok">Pronto</span> : <span className="chip bad">Falta permissão</span>}
          <span className="small muted">{c.subscribers} assinantes ativos</span>
        </div>
        <div className="small muted">
          {c.sellingBots.length ? `Vendido por ${c.sellingBots.map((u) => "@" + u).join(", ")}` : "Nenhum bot vende este canal como principal"}
        </div>
        {!c.rightsOk && c.active && (
          <div className="note bad small">
            O bot gestor precisa ser administrador com “Adicionar inscritos” ligado (em grupo: “Convidar usuários via link” e “Banir usuários”). Ajuste no Telegram e clique em Conferir.
          </div>
        )}
        <div className="grid-2">
          <label className="field">
            Bot gestor
            <select
              value={c.managerBot?.id ?? ""}
              disabled={busy}
              onChange={(e) => run(() => put(`/api/channels/${c.id}`, { managerBotId: e.target.value }).then(reload), "Bot gestor trocado")}
            >
              {!c.managerBot && <option value="">Escolha</option>}
              {bots.map((b) => (
                <option key={b.id} value={b.id}>
                  @{b.username}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            Preço como adicional
            <small>Quando outro bot oferece este canal junto (“adicionar por +R$” e “renovar + canal”). Vazio = não é oferecido.</small>
            <div className="row" style={{ flexWrap: "nowrap" }}>
              <MoneyField value={price} onChange={setPrice} placeholder="Ex.: 9,90" />
              {price !== c.extraPriceCents && (
                <button className="btn small primary" disabled={busy} onClick={() => run(() => put(`/api/channels/${c.id}`, { extraPriceCents: price }).then(reload), "Preço salvo")}>
                  Salvar
                </button>
              )}
            </div>
          </label>
        </div>
      </div>
      <div className="row">
        <button
          className="btn small"
          disabled={busy}
          onClick={() =>
            run(async () => {
              const r = await post<{ rights: { ok: boolean; missing: string[] } }>(`/api/channels/${c.id}/check`);
              reload();
              if (!r.rights.ok) throw new Error(`Ainda falta: ${r.rights.missing.join(", ")}.`);
            }, "Tudo certo com as permissões")
          }
        >
          Conferir
        </button>
        <button className="btn small ghost" disabled={busy} onClick={() => run(() => put(`/api/channels/${c.id}`, { active: !c.active }).then(reload), c.active ? "Canal desativado" : "Canal ativado")}>
          {c.active ? "Desativar" : "Ativar"}
        </button>
        <button
          className="btn small ghost danger"
          disabled={busy}
          onClick={() => {
            const msg = c.subscribers
              ? `"${c.title}" tem ${c.subscribers} assinantes ativos. Remover do Botly apaga os acessos e lembretes deles (eles continuam no canal do Telegram, mas o Botly deixa de cobrar e remover). Continuar?`
              : `Remover "${c.title}" do Botly? O canal no Telegram não é apagado.`;
            if (!confirm(msg)) return;
            void run(() => del(`/api/channels/${c.id}?confirmar=1`).then(reload), "Canal removido");
          }}
        >
          Remover
        </button>
      </div>
    </div>
  );
}

function AddChannel({ bots, onClose, onDone }: { bots: BotListItem[]; onClose: () => void; onDone: () => void }) {
  const [botId, setBotId] = useState(bots[0]?.id ?? "");
  const [chat, setChat] = useState("");
  const { busy, run } = useAction();
  async function submit(e: FormEvent) {
    e.preventDefault();
    const ok = await run(() => post("/api/channels", { botId, chat }), "Canal cadastrado");
    if (ok) onDone();
  }
  return (
    <Modal title="Adicionar canal pelo ID" onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        <p className="muted small">Use quando o canal não apareceu sozinho. O bot escolhido já precisa ser administrador dele.</p>
        <label className="field">
          Bot gestor
          <select value={botId} onChange={(e) => setBotId(e.target.value)}>
            {bots.map((b) => (
              <option key={b.id} value={b.id}>
                @{b.username}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          ID do canal ou @usuário
          <small>O ID de canal privado começa com -100. Encaminhe uma mensagem do canal para o @userinfobot para descobrir.</small>
          <input type="text" value={chat} onChange={(e) => setChat(e.target.value)} placeholder="-1001234567890" required />
        </label>
        <div className="row">
          <button className="btn primary" disabled={busy}>
            {busy ? "Conferindo…" : "Adicionar"}
          </button>
          <button type="button" className="btn ghost" onClick={onClose}>
            Cancelar
          </button>
        </div>
      </form>
    </Modal>
  );
}
