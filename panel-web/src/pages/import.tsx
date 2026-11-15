import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { brl, get, post, type BotListItem, type Channel } from "../api";
import { Loading, Toggle, useAction, useLoad } from "../ui";

interface Group {
  key: string;
  amountCents: number | null;
  durationDays: number | null;
  customers: number;
  active: number;
}
interface Preview {
  columns: Record<string, string>;
  lines: number;
  customers: number;
  active: number;
  expired: number;
  alreadyInBotly: number;
  invalid: { line: number; text: string; reason: string }[];
  invalidCount: number;
  groups: Group[];
  suggested: Record<string, string | null>;
  plans: { id: string; name: string; priceCents: number }[];
  sample: { telegramId: number; username: string | null; expiresAt: string; amountCents: number | null; purchases: number }[];
}
interface Done {
  stats: Record<string, number>;
}
interface PastImport {
  id: string;
  fileName: string;
  createdAt: string;
  stats: Record<string, number>;
  bot: string | null;
  channel: string | null;
}

const COL_LABEL: Record<string, string> = { user: "Cliente (ID do Telegram)", amount: "Valor", bought: "Data da compra", expires: "Vencimento", payment: "ID do pagamento" };
const durLabel = (d: number | null) => (d == null ? "duração desconhecida" : d >= 3650 ? "vitalício" : d === 1 ? "1 dia" : `${d} dias`);
const fmt = (iso: string) => new Date(iso).toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo" });

function fileToBase64(f: File): Promise<string> {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result).split(",")[1] ?? "");
    r.onerror = () => rej(new Error("Não consegui ler o arquivo."));
    r.readAsDataURL(f);
  });
}

export function ImportPage() {
  const bots = useLoad(() => get<BotListItem[]>("/api/bots"));
  const chans = useLoad(() => get<Channel[]>("/api/channels"));
  const past = useLoad(() => get<PastImport[]>("/api/imports"));
  const [botId, setBotId] = useState("");
  const [channelId, setChannelId] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [prev, setPrev] = useState<Preview | null>(null);
  const [planMap, setPlanMap] = useState<Record<string, string | null>>({});
  const [done, setDone] = useState<Done | null>(null);
  const [onlyActive, setOnlyActive] = useState(true);
  const { busy, run } = useAction();

  // Canal padrão = canal principal do bot escolhido.
  useEffect(() => {
    if (!botId || !bots.data || !chans.data) return;
    const b = bots.data.find((x) => x.id === botId);
    const ch = chans.data.find((c) => c.title === b?.mainChannel);
    if (ch) setChannelId(ch.id);
  }, [botId, bots.data, chans.data]);

  if (!bots.data || !chans.data) return <Loading error={bots.error ?? chans.error} />;

  async function payload() {
    if (!file) throw new Error("Escolha o arquivo.");
    if (!botId || !channelId) throw new Error("Escolha o bot e o canal.");
    return { botId, channelId, fileName: file.name, data: await fileToBase64(file) };
  }
  const preview = () =>
    run(async () => {
      setDone(null);
      const p = await post<Preview>("/api/import/preview", await payload());
      setPrev(p);
      setPlanMap(p.suggested);
    });
  const confirm = () =>
    run(async () => {
      const r = await post<Done>("/api/import/confirm", { ...(await payload()), planMap, onlyActive });
      setDone(r);
      setPrev(null);
      past.reload();
    }, "Importação concluída");

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Importar assinantes</h1>
          <p>Traga os assinantes de outro gerenciador com o vencimento de cada um. Os ativos passam a receber os lembretes e são removidos se não renovarem.</p>
        </div>
      </div>

      {!done && (
        <div className="panel stack">
          <ol className="howto">
            <li>
              No AutomatizzeBot, abra <b>Assinantes</b> do bot, filtre por <b>Aprovado</b> e clique no ícone de planilha ao lado de <b>BUSCAR</b>. Ele baixa o <code>assinantes.xlsx</code>.
            </li>
            <li>Escolha abaixo o bot que vai cobrar esses clientes no Botly e o canal deles.</li>
            <li>Suba o arquivo, confira a prévia e confirme.</li>
          </ol>
          <div className="note warn small">
            Faça a importação no <b>dia da virada</b>, com o bot do Botly usando o <b>mesmo token</b> do bot antigo. Assim o bot consegue mandar mensagem para todos eles.
          </div>
          <div className="grid-2">
            <label className="field">
              Bot que vai cobrar
              <select value={botId} onChange={(e) => (setBotId(e.target.value), setPrev(null))}>
                <option value="">Escolha</option>
                {bots.data.map((b) => (
                  <option key={b.id} value={b.id}>
                    @{b.username}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              Canal desses assinantes
              <select value={channelId} onChange={(e) => (setChannelId(e.target.value), setPrev(null))}>
                <option value="">Escolha</option>
                {chans.data.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.title}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <label className="field">
            Planilha (.xlsx ou .csv)
            <input type="file" accept=".xlsx,.csv" onChange={(e) => (setFile(e.target.files?.[0] ?? null), setPrev(null))} />
          </label>
          {!prev && (
            <div className="row">
              <button className="btn primary" disabled={busy || !file || !botId || !channelId} onClick={preview}>
                {busy ? "Lendo…" : "Ver prévia"}
              </button>
            </div>
          )}
        </div>
      )}

      {prev && (
        <PreviewPanel prev={prev} planMap={planMap} setPlanMap={setPlanMap} onlyActive={onlyActive} setOnlyActive={setOnlyActive} busy={busy} onConfirm={confirm} onCancel={() => setPrev(null)} />
      )}

      {done && (
        <div className="panel stack">
          <h2>Importação concluída</h2>
          <div className="grid-4">
            <Stat label="Clientes importados" value={done.stats.clientes} />
            <Stat label="Ativos (recebem lembretes)" value={done.stats.ativos} />
            {done.stats.vencidos > 0 && <Stat label="Já vencidos" value={done.stats.vencidos} />}
            <Stat label="Linhas ignoradas" value={done.stats.ignorados} />
          </div>
          <p className="small muted">
            {done.stats.novos} novos, {done.stats.atualizados} com vencimento atualizado, {done.stats.mantidos} já estavam no Botly com vencimento igual ou maior.
          </p>
          <div className="row">
            <Link className="btn primary" to="/retencao">
              Ver lembretes na Retenção
            </Link>
            <button className="btn" onClick={() => (setDone(null), setFile(null))}>
              Importar outra planilha
            </button>
          </div>
        </div>
      )}

      {past.data && past.data.length > 0 && (
        <div className="panel" style={{ marginTop: 16 }}>
          <h2 style={{ marginBottom: 8 }}>Importações anteriores</h2>
          <div className="list">
            {past.data.map((p) => (
              <div className="list-item" key={p.id}>
                <div className="grow">
                  <span className="title">{p.fileName}</span>
                  <div className="small muted">
                    {fmt(p.createdAt)}, @{p.bot} → {p.channel}
                  </div>
                </div>
                <span className="small">
                  {p.stats.clientes} clientes, {p.stats.ativos} ativos
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  );
}

function Stat({ label, value }: { label: string; value: number | undefined }) {
  return (
    <div>
      <div className="muted small">{label}</div>
      <div style={{ font: "800 28px var(--display)" }}>{value ?? 0}</div>
    </div>
  );
}

function PreviewPanel({
  prev,
  planMap,
  setPlanMap,
  onlyActive,
  setOnlyActive,
  busy,
  onConfirm,
  onCancel,
}: {
  prev: Preview;
  planMap: Record<string, string | null>;
  setPlanMap: (m: Record<string, string | null>) => void;
  onlyActive: boolean;
  setOnlyActive: (v: boolean) => void;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const unmapped = prev.groups.filter((g) => g.active > 0 && !planMap[g.key]).reduce((x, g) => x + g.active, 0);
  return (
    <div className="panel stack" style={{ marginTop: 16 }}>
      <h2>Prévia</h2>
      <div className="grid-4">
        <Stat label="Clientes únicos" value={prev.customers} />
        <Stat label="Ativos (recebem lembretes)" value={prev.active} />
        <Stat label="Já vencidos" value={prev.expired} />
        <Stat label="Linhas ignoradas" value={prev.invalidCount} />
      </div>
      <p className="small muted">
        {prev.lines} linhas lidas. Quem aparece mais de uma vez (renovações) vira um cliente só, com o maior vencimento.
        {prev.alreadyInBotly ? ` ${prev.alreadyInBotly} já estão no Botly neste canal: só têm o vencimento atualizado se o da planilha for maior.` : ""}
      </p>
      <div className="small">
        <b>Colunas reconhecidas:</b>{" "}
        {Object.entries(prev.columns)
          .map(([k, v]) => `${COL_LABEL[k] ?? k} = “${v}”`)
          .join("; ")}
      </div>

      <div>
        <h3>Qual plano cada valor representa</h3>
        <p className="small muted">É o plano oferecido no botão “Renovar” dos lembretes. Sem plano, o cliente recebe a lista de planos.</p>
      </div>
      <div className="list">
        {prev.groups.map((g) => (
          <div className="list-item" key={g.key}>
            <div className="grow">
              <b>{g.amountCents != null ? brl(g.amountCents) : "Sem valor"}</b> <span className="muted">{durLabel(g.durationDays)}</span>
              <div className="small muted">
                {g.customers} clientes, {g.active} ativos
              </div>
            </div>
            <select value={planMap[g.key] ?? ""} onChange={(e) => setPlanMap({ ...planMap, [g.key]: e.target.value || null })} style={{ maxWidth: 260 }}>
              <option value="">Sem plano</option>
              {prev.plans.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} — {brl(p.priceCents)}
                </option>
              ))}
            </select>
          </div>
        ))}
      </div>
      {!prev.plans.length && <div className="note warn small">Este bot ainda não tem planos. Crie os planos antes, para o botão “Renovar” já ir com o valor certo.</div>}

      {prev.sample.length > 0 && (
        <div>
          <h3 style={{ marginBottom: 6 }}>Próximos a vencer</h3>
          <div className="list">
            {prev.sample.map((c) => (
              <div className="list-item" key={c.telegramId} style={{ padding: "8px 4px" }}>
                <span className="grow">{c.username ? "@" + c.username : c.telegramId}</span>
                <span className="small muted">
                  {c.purchases} {c.purchases === 1 ? "compra" : "compras"}
                </span>
                <span className="small">vence {fmt(c.expiresAt)}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {prev.invalidCount > 0 && (
        <details>
          <summary className="small">Ver linhas ignoradas ({prev.invalidCount})</summary>
          <ul className="small muted">
            {prev.invalid.map((i) => (
              <li key={i.line}>
                Linha {i.line}: “{i.text}”, {i.reason}
              </li>
            ))}
          </ul>
        </details>
      )}

      <Toggle checked={onlyActive} onChange={setOnlyActive}>
        Importar só os assinantes ativos ({prev.active}){prev.expired ? `, deixando de fora os ${prev.expired} já vencidos` : ""}
      </Toggle>
      {unmapped > 0 && <div className="note warn small">{unmapped} ativos ficam sem plano. Eles recebem a lista de planos no lembrete, em vez do botão direto.</div>}
      <div className="row">
        <button className="btn primary" disabled={busy || !prev.customers} onClick={onConfirm}>
          {busy ? "Importando…" : `Importar ${onlyActive ? prev.active : prev.customers} ${onlyActive ? "assinantes ativos" : "clientes"}`}
        </button>
        <button className="btn ghost" onClick={onCancel}>
          Cancelar
        </button>
      </div>
    </div>
  );
}
