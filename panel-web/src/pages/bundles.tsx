import { useState } from "react";
import { brl, del, durationLabel, get, post, put, type Bundle, type Channel, type Unit } from "../api";
import { Loading, Modal, MoneyField, Toggle, UNIT_OPTIONS, useAction, useLoad } from "../ui";

export function BundlesPage() {
  const list = useLoad(() => get<Bundle[]>("/api/bundles"));
  const chans = useLoad(() => get<Channel[]>("/api/channels"));
  const [edit, setEdit] = useState<Bundle | "new" | null>(null);
  const { busy, run } = useAction();
  if (!list.data || !chans.data) return <Loading error={list.error ?? chans.error} />;
  const name = (id: string) => chans.data!.find((c) => c.id === id)?.title ?? "?";
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Pacotes</h1>
          <p>Vários canais por um preço fechado. Aparecem em todos os bots, no botão “Pacotes promocionais”.</p>
        </div>
        <button className="btn primary" onClick={() => setEdit("new")} disabled={chans.data.length < 2}>
          Novo pacote
        </button>
      </div>
      {list.data.length === 0 ? (
        <div className="panel empty">
          <h2>Nenhum pacote</h2>
          <p>{chans.data.length < 2 ? "Você precisa de pelo menos 2 canais cadastrados para montar um pacote." : "Monte um combo com 2 ou mais canais por um preço menor que a soma."}</p>
        </div>
      ) : (
        <div className="panel">
          <div className="list">
            {list.data.map((b) => (
              <div className="list-item" key={b.id}>
                <div className="grow">
                  <span className="title">{b.name}</span> {!b.active && <span className="chip">Desativado</span>}
                  <div className="small muted">
                    {b.channelIds.map(name).join(", ")}. {durationLabel(b.durationUnit, b.durationValue)}.
                  </div>
                </div>
                <b>{brl(b.priceCents)}</b>
                <button className="btn small" onClick={() => setEdit(b)}>
                  Editar
                </button>
                <button className="btn small ghost danger" disabled={busy} onClick={() => confirm(`Apagar o pacote "${b.name}"?`) && run(() => del(`/api/bundles/${b.id}`).then(list.reload), "Pacote apagado")}>
                  Apagar
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
      {edit && <BundleForm bundle={edit === "new" ? null : edit} channels={chans.data} onClose={() => setEdit(null)} onDone={() => (setEdit(null), list.reload())} />}
    </>
  );
}

function BundleForm({ bundle, channels, onClose, onDone }: { bundle: Bundle | null; channels: Channel[]; onClose: () => void; onDone: () => void }) {
  const [f, setF] = useState({
    name: bundle?.name ?? "",
    description: bundle?.description ?? "",
    durationUnit: (bundle?.durationUnit ?? "month") as Unit,
    durationValue: bundle?.durationValue ?? 1,
    priceCents: bundle?.priceCents ?? null,
    active: bundle?.active ?? true,
    channelIds: bundle?.channelIds ?? [],
  });
  const { busy, run } = useAction();
  const save = async () => {
    const ok = await run(async () => {
      if (f.channelIds.length < 2) throw new Error("Escolha pelo menos 2 canais.");
      if (!f.priceCents) throw new Error("Defina o preço do pacote.");
      const body = { ...f, durationValue: f.durationUnit === "lifetime" ? 1 : f.durationValue };
      if (bundle) await put(`/api/bundles/${bundle.id}`, body);
      else await post("/api/bundles", body);
    }, "Pacote salvo");
    if (ok) onDone();
  };
  return (
    <Modal title={bundle ? "Editar pacote" : "Novo pacote"} onClose={onClose}>
      <div className="stack">
        <label className="field">
          Nome no botão
          <input type="text" value={f.name} maxLength={60} placeholder="Combo Hot" onChange={(e) => setF({ ...f, name: e.target.value })} />
        </label>
        <div className="field">
          Canais incluídos
          {channels.map((c) => (
            <Toggle key={c.id} checked={f.channelIds.includes(c.id)} onChange={(v) => setF({ ...f, channelIds: v ? [...f.channelIds, c.id] : f.channelIds.filter((x) => x !== c.id) })}>
              {c.title}
            </Toggle>
          ))}
        </div>
        <div className="grid-2">
          <label className="field">
            Duração
            <div className="row" style={{ flexWrap: "nowrap" }}>
              <input type="number" min={1} style={{ width: 80 }} value={f.durationUnit === "lifetime" ? "" : f.durationValue} disabled={f.durationUnit === "lifetime"} onChange={(e) => setF({ ...f, durationValue: Math.max(1, Number(e.target.value) || 1) })} />
              <select value={f.durationUnit} onChange={(e) => setF({ ...f, durationUnit: e.target.value as Unit })}>
                {UNIT_OPTIONS.map((u) => (
                  <option key={u.value} value={u.value}>
                    {u.label}
                  </option>
                ))}
              </select>
            </div>
          </label>
          <label className="field">
            Preço
            <MoneyField value={f.priceCents} onChange={(v) => setF({ ...f, priceCents: v })} />
          </label>
        </div>
        <Toggle checked={f.active} onChange={(v) => setF({ ...f, active: v })}>
          Ativo
        </Toggle>
        <div className="row">
          <button className="btn primary" disabled={busy} onClick={save}>
            {busy ? "Salvando…" : "Salvar pacote"}
          </button>
          <button className="btn ghost" onClick={onClose}>
            Cancelar
          </button>
        </div>
      </div>
    </Modal>
  );
}
