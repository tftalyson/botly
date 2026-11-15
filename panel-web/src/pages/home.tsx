import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { brl, get, type BotListItem, type Me } from "../api";
import { Loading, Modal, useLoad } from "../ui";

type RangeKey = "today" | "yesterday" | "7d" | "week" | "month" | "30d" | "all" | "custom";
interface Numbers {
  revenueCents: number;
  sales: number;
  newSales: number;
  renewals: number;
  bundles: number;
  bundleCents: number;
  extraCents: number;
  started: number;
  convertedFromStarted: number;
  pixOrders: number;
  pixPaid: number;
  bumpOffered: number;
  bumpAccepted: number;
  renewalsWithExtra: number;
  lost: number;
  conversion: number | null;
  pixConversion: number | null;
  renewal: number | null;
  bumpTake: number | null;
  renewalUpsell: number | null;
  bundleShare: number | null;
  avgTicket: number | null;
}
interface Dash {
  range: { key: RangeKey; from: string; to: string; bucket: "day" | "month" };
  current: Numbers;
  previous: Numbers | null;
  series: { day: string; newCents: number; renewalCents: number; bundleCents: number; count: number }[];
  funnel: { step: string; n: number }[];
  botRank: { bot: string; cents: number; sales: number; renewals: number }[];
  planRank: { name: string; bot: string; sales: number; cents: number }[];
  activeSubscribers: number;
  projections: {
    renewalsDue30: { count: number; potentialCents: number; expectedCents: number; rate: number; rateIsEstimate: boolean };
    monthPace: { soFarCents: number; projectedCents: number; daysInMonth: number; dayOfMonth: number };
  };
}
interface Overview {
  checklist: Record<"gateway" | "bot" | "channel" | "mainChannel" | "plans" | "routing", boolean>;
}

const RANGES: [RangeKey, string][] = [
  ["today", "Hoje"],
  ["yesterday", "Ontem"],
  ["7d", "7 dias"],
  ["week", "Esta semana"],
  ["month", "Este mês"],
  ["30d", "30 dias"],
  ["all", "Tudo"],
  ["custom", "Escolher datas"],
];
const PREV_LABEL: Record<RangeKey, string> = {
  today: "ontem",
  yesterday: "anteontem",
  "7d": "7 dias antes",
  week: "semana passada",
  month: "período anterior",
  "30d": "30 dias antes",
  all: "",
  custom: "período anterior",
};
// Cores das séries (validadas para daltonismo; ver skill dataviz). Ordem fixa.
const SERIES = [
  { key: "newCents", label: "Vendas novas", color: "#5B2EFF" },
  { key: "renewalCents", label: "Renovações", color: "#0E9F86" },
  { key: "bundleCents", label: "Pacotes", color: "#D98A00" },
] as const;

const STEPS: { key: keyof Overview["checklist"]; text: string; to: string; action: string }[] = [
  { key: "gateway", text: "Cadastrar uma forma de pagamento (PushinPay)", to: "/pagamentos", action: "Cadastrar" },
  { key: "bot", text: "Conectar um bot do Telegram", to: "/bots", action: "Conectar" },
  { key: "channel", text: "Colocar o bot como admin do canal VIP", to: "/canais", action: "Ver canais" },
  { key: "mainChannel", text: "Escolher qual canal o bot vende", to: "/bots", action: "Abrir bots" },
  { key: "plans", text: "Criar os planos do bot", to: "/bots", action: "Abrir bots" },
  { key: "routing", text: "Ligar a forma de pagamento no bot", to: "/bots", action: "Abrir bots" },
];

const pctTxt = (v: number | null) => (v == null ? "—" : `${(v * 100).toLocaleString("pt-BR", { maximumFractionDigits: 1 })}%`);
const isoDay = (d: Date) => new Date(d.getTime() - 3 * 3600_000).toISOString().slice(0, 10);

export function HomePage({ me }: { me: Me }) {
  const [range, setRange] = useState<RangeKey>("7d");
  const today = isoDay(new Date());
  const [custom, setCustom] = useState({ from: isoDay(new Date(Date.now() - 13 * 86_400_000)), to: today });
  const bots = useLoad(() => get<BotListItem[]>("/api/bots"));
  // Bots escolhidos (null = todos); fica salvo neste navegador.
  const [sel, setSel] = useState<string[] | null>(() => {
    try {
      const v = JSON.parse(localStorage.getItem("botly.dashBots") ?? "null");
      return Array.isArray(v) ? v : null;
    } catch {
      return null;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem("botly.dashBots", JSON.stringify(sel));
    } catch {}
  }, [sel]);
  // Ignora bots que não existem mais.
  const valid = sel && bots.data ? sel.filter((id) => bots.data!.some((b) => b.id === id)) : sel;
  const q = (range === "custom" ? `range=custom&from=${custom.from}&to=${custom.to}` : `range=${range}`) + (valid ? `&bots=${valid.join(",")}` : "");
  const d = useLoad(() => get<Dash>(`/api/dashboard?${q}`), [q]);
  const ov = useLoad(() => get<Overview>("/api/overview"));
  const first = me.user.name.split(" ")[0];
  const pending = ov.data ? STEPS.filter((s) => !ov.data!.checklist[s.key]) : [];

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Olá, {first}</h1>
          <p>Vendas, conversão e retenção dos seus bots. Os números comparam com o período anterior do mesmo tamanho.</p>
        </div>
      </div>

      {ov.data && pending.length > 0 && <Checklist data={ov.data} pending={pending.length} />}

      <div className="filters">
        <div className="period-bar" role="group" aria-label="Período">
          {RANGES.map(([k, label]) => (
            <button key={k} className={range === k ? "on" : ""} aria-pressed={range === k} onClick={() => setRange(k)}>
              {label}
            </button>
          ))}
        </div>
        {bots.data && bots.data.length > 1 && <BotPicker bots={bots.data} value={valid} onChange={setSel} />}
      </div>
      {range === "custom" && (
        <div className="row" style={{ marginBottom: 16 }}>
          <label className="field" style={{ width: 170 }}>
            De
            <input type="date" value={custom.from} max={custom.to} onChange={(e) => setCustom({ ...custom, from: e.target.value })} />
          </label>
          <label className="field" style={{ width: 170 }}>
            Até
            <input type="date" value={custom.to} min={custom.from} max={today} onChange={(e) => setCustom({ ...custom, to: e.target.value })} />
          </label>
        </div>
      )}

      {!d.data ? (
        <Loading error={d.error} />
      ) : (
        <Body d={d.data} prevLabel={PREV_LABEL[range]} q={q} />
      )}
    </>
  );
}

function Checklist({ data, pending }: { data: Overview; pending: number }) {
  return (
    <div className="panel" style={{ marginBottom: 16 }}>
      <div className="panel-head">
        <div>
          <h2>Para começar a vender</h2>
          <p>
            {STEPS.length - pending} de {STEPS.length} feitos
          </p>
        </div>
      </div>
      <ol className="steps">
        {STEPS.map((s) => (
          <li key={s.key} className={data.checklist[s.key] ? "done" : ""}>
            <span className="t">{s.text}</span>
            {!data.checklist[s.key] && (
              <Link className="btn small" to={s.to}>
                {s.action}
              </Link>
            )}
          </li>
        ))}
      </ol>
    </div>
  );
}

/** Variação contra o período anterior: % para valores, pontos percentuais para taxas. */
function Delta({ cur, prev, kind, label }: { cur: number | null; prev: number | null | undefined; kind: "money" | "count" | "rate"; label: string }) {
  if (cur == null || prev == null || !label) return null;
  let txt: string;
  let up: boolean;
  if (kind === "rate") {
    const pp = (cur - prev) * 100;
    if (Math.abs(pp) < 0.05) return <span className="delta">igual a {label}</span>;
    up = pp > 0;
    txt = `${up ? "+" : "−"}${Math.abs(pp).toLocaleString("pt-BR", { maximumFractionDigits: 1 })} p.p.`;
  } else {
    if (prev === 0) return cur > 0 ? <span className="delta up">novo vs {label}</span> : <span className="delta">igual a {label}</span>;
    const p = ((cur - prev) / prev) * 100;
    if (Math.abs(p) < 0.5) return <span className="delta">igual a {label}</span>;
    up = p > 0;
    txt = `${up ? "+" : "−"}${Math.abs(p).toLocaleString("pt-BR", { maximumFractionDigits: 0 })}%`;
  }
  return (
    <span className={`delta ${up ? "up" : "down"}`}>
      {up ? "▲" : "▼"} {txt} vs {label}
    </span>
  );
}

function Body({ d, prevLabel, q }: { d: Dash; prevLabel: string; q: string }) {
  const [people, setPeople] = useState<number | null>(null);
  const c = d.current;
  const p = d.previous;
  return (
    <>
      <div className="kpis">
        <div className="kpi hero">
          <span className="label">Faturamento</span>
          <b className="value">{brl(c.revenueCents)}</b>
          <Delta cur={c.revenueCents} prev={p?.revenueCents} kind="money" label={prevLabel} />
        </div>
        <Kpi label="Vendas aprovadas" value={String(c.sales)} sub={`${c.newSales} novas, ${c.renewals} renovações, ${c.bundles} pacotes`} delta={<Delta cur={c.sales} prev={p?.sales} kind="count" label={prevLabel} />} />
        <Kpi label="Ticket médio" value={c.avgTicket != null ? brl(c.avgTicket) : "—"} sub="por compra" delta={<Delta cur={c.avgTicket} prev={p?.avgTicket} kind="money" label={prevLabel} />} />
        <Kpi
          label="Conversão"
          value={pctTxt(c.conversion)}
          sub={`${c.convertedFromStarted} de ${c.started} que deram /start compraram`}
          delta={<Delta cur={c.conversion} prev={p?.conversion} kind="rate" label={prevLabel} />}
        />
        <Kpi label="Renovação" value={pctTxt(c.renewal)} sub={`${c.renewals} renovaram, ${c.lost} não renovaram`} delta={<Delta cur={c.renewal} prev={p?.renewal} kind="rate" label={prevLabel} />} />
        <Kpi label="Upsell aceito" value={pctTxt(c.bumpTake)} sub={`${c.bumpAccepted} de ${c.bumpOffered} ofertas de canal extra`} delta={<Delta cur={c.bumpTake} prev={p?.bumpTake} kind="rate" label={prevLabel} />} />
      </div>

      <div className="panel">
        <RevenueChart series={d.series} bucket={d.range.bucket} />
      </div>

      <div className="dash-grid">
        <div className="panel">
          <h2>Funil de vendas</h2>
          <p className="small muted" style={{ margin: "4px 0 16px" }}>
            Pessoas únicas em cada etapa, no período. A porcentagem é de quem passou da etapa anterior. Toque numa etapa para ver quem são.
          </p>
          <Funnel steps={d.funnel} onPick={setPeople} />
          {people !== null && <FunnelPeople q={q} initial={people} counts={d.funnel.map((f) => f.n)} onClose={() => setPeople(null)} />}
          <div className="mini-stats">
            <div>
              <span className="muted small">Pix gerados que foram pagos</span>
              <b>{pctTxt(c.pixConversion)}</b>
              <span className="muted small">
                {c.pixPaid} de {c.pixOrders}
              </span>
            </div>
          </div>
        </div>

        <div className="panel">
          <h2>Upsell e pacotes</h2>
          <p className="small muted" style={{ margin: "4px 0 16px" }}>
            Quanto o cliente gasta além do plano.
          </p>
          <div className="mini-stats">
            <div>
              <span className="muted small">Canal extra antes do Pix</span>
              <b>{pctTxt(c.bumpTake)}</b>
              <span className="muted small">
                {c.bumpAccepted} aceitaram de {c.bumpOffered}
              </span>
            </div>
            <div>
              <span className="muted small">Receita com canais extras</span>
              <b className="money">{brl(c.extraCents)}</b>
              <span className="muted small">{c.revenueCents ? pctTxt(c.extraCents / c.revenueCents) : "—"} do faturamento</span>
            </div>
            <div>
              <span className="muted small">Renovações com extra</span>
              <b>{pctTxt(c.renewalUpsell)}</b>
              <span className="muted small">
                {c.renewalsWithExtra} de {c.renewals}
              </span>
            </div>
            <div>
              <span className="muted small">Pacotes vendidos</span>
              <b>{c.bundles}</b>
              <span className="muted small">
                {brl(c.bundleCents)}, {pctTxt(c.bundleShare)} do faturamento
              </span>
            </div>
          </div>
        </div>
      </div>

      <div className="panel">
        <h2>Projeções</h2>
        <p className="small muted" style={{ margin: "4px 0 16px" }}>
          Estimativas a partir do que já aconteceu. Servem de direção, não de promessa.
        </p>
        <div className="mini-stats">
          <div>
            <span className="muted small">Renovações nos próximos 30 dias</span>
            <b className="money">{brl(d.projections.renewalsDue30.expectedCents)}</b>
            <span className="muted small">
              esperado com {pctTxt(d.projections.renewalsDue30.rate)} de renovação{d.projections.renewalsDue30.rateIsEstimate ? " (estimativa: ainda sem histórico)" : " (média dos últimos 30 dias)"}
            </span>
          </div>
          <div>
            <span className="muted small">Se todos renovarem</span>
            <b>{brl(d.projections.renewalsDue30.potentialCents)}</b>
            <span className="muted small">{d.projections.renewalsDue30.count} assinaturas vencem em 30 dias</span>
          </div>
          <div>
            <span className="muted small">Ritmo do mês</span>
            <b className="money">{brl(d.projections.monthPace.projectedCents)}</b>
            <span className="muted small">
              {brl(d.projections.monthPace.soFarCents)} até o dia {d.projections.monthPace.dayOfMonth} de {d.projections.monthPace.daysInMonth}
            </span>
          </div>
          <div>
            <span className="muted small">Assinantes ativos agora</span>
            <b>{d.activeSubscribers}</b>
            <span className="muted small">pessoas com pelo menos um canal em dia</span>
          </div>
        </div>
      </div>

      <div className="dash-grid">
        <div className="panel">
          <h2 style={{ marginBottom: 12 }}>Ranking de bots</h2>
          {d.botRank.length ? (
            <div className="scroll-x">
            <table className="rank">
              <thead>
                <tr>
                  <th>Bot</th>
                  <th>Vendas</th>
                  <th>Renovações</th>
                  <th className="num">Faturamento</th>
                </tr>
              </thead>
              <tbody>
                {d.botRank.map((b, i) => (
                  <tr key={b.bot}>
                    <td>
                      <span className="pos">{i + 1}</span>@{b.bot}
                    </td>
                    <td>{b.sales}</td>
                    <td>{b.renewals}</td>
                    <td className="num">{brl(b.cents)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
          ) : (
            <p className="muted small">Sem vendas no período.</p>
          )}
        </div>
        <div className="panel">
          <h2 style={{ marginBottom: 12 }}>Planos mais vendidos</h2>
          {d.planRank.length ? (
            <div className="scroll-x">
            <table className="rank">
              <thead>
                <tr>
                  <th>Plano</th>
                  <th>Bot</th>
                  <th>Vendas</th>
                  <th className="num">Receita</th>
                </tr>
              </thead>
              <tbody>
                {d.planRank.map((r, i) => (
                  <tr key={r.name + r.bot}>
                    <td>
                      <span className="pos">{i + 1}</span>
                      {r.name}
                    </td>
                    <td className="muted">@{r.bot}</td>
                    <td>{r.sales}</td>
                    <td className="num">{brl(r.cents)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
          ) : (
            <p className="muted small">Sem vendas no período.</p>
          )}
        </div>
      </div>
    </>
  );
}

function Kpi({ label, value, sub, delta }: { label: string; value: string; sub: string; delta: React.ReactNode }) {
  return (
    <div className="kpi">
      <span className="label">{label}</span>
      <b className="value">{value}</b>
      <span className="sub">{sub}</span>
      {delta}
    </div>
  );
}

function Funnel({ steps, onPick }: { steps: { step: string; n: number }[]; onPick: (i: number) => void }) {
  const max = Math.max(1, ...steps.map((s) => s.n));
  return (
    <div className="funnel">
      {steps.map((s, i) => {
        const prev = i ? steps[i - 1]!.n : null;
        return (
          <button type="button" className="frow" key={s.step} onClick={() => onPick(i)} disabled={!s.n} title={s.n ? "Ver quem são" : undefined}>
            <span className="fl">{s.step}</span>
            <div className="ftrack">
              <div className="fbar" style={{ width: `${(s.n / max) * 100}%` }} />
            </div>
            <span className="fn">{s.n}</span>
            <span className="fp">{prev ? pctTxt(s.n / prev) : prev === 0 ? "—" : ""}</span>
          </button>
        );
      })}
    </div>
  );
}

/** Colunas empilhadas por dia (ou mês): vendas novas, renovações e pacotes. */
function RevenueChart({ series, bucket }: { series: Dash["series"]; bucket: "day" | "month" }) {
  const [hover, setHover] = useState<number | null>(null);
  const [table, setTable] = useState(false);
  const W = 1000;
  const H = 240;
  const pad = { l: 64, r: 8, t: 12, b: 28 };
  const totals = series.map((s) => s.newCents + s.renewalCents + s.bundleCents);
  const maxV = Math.max(...totals, 0);
  const ticks = useMemo(() => niceTicks(maxV), [maxV]);
  const top = ticks[ticks.length - 1] || 1;
  const n = series.length || 1;
  const band = (W - pad.l - pad.r) / n;
  const bw = Math.min(24, Math.max(3, band * 0.6));
  const y = (v: number) => pad.t + (H - pad.t - pad.b) * (1 - v / top);
  const label = (day: string) => {
    const [yy, mm, dd] = day.split("-");
    return bucket === "month" ? `${mm}/${yy!.slice(2)}` : `${dd}/${mm}`;
  };
  const every = Math.ceil(n / 10);
  const total = totals.reduce((a, b) => a + b, 0);
  return (
    <div>
      <div className="panel-head" style={{ marginBottom: 8 }}>
        <div>
          <h2>Faturamento por {bucket === "month" ? "mês" : "dia"}</h2>
          <p>{brl(total)} no período</p>
        </div>
        <div className="row">
          <div className="legend">
            {SERIES.map((s) => (
              <span key={s.key}>
                <i style={{ background: s.color }} />
                {s.label}
              </span>
            ))}
          </div>
          <button className="btn small ghost" onClick={() => setTable(!table)}>
            {table ? "Ver gráfico" : "Ver tabela"}
          </button>
        </div>
      </div>
      {table ? (
        <div style={{ overflowX: "auto" }}>
          <table className="rank">
            <thead>
              <tr>
                <th>{bucket === "month" ? "Mês" : "Dia"}</th>
                {SERIES.map((s) => (
                  <th key={s.key} className="num">
                    {s.label}
                  </th>
                ))}
                <th className="num">Total</th>
                <th className="num">Vendas</th>
              </tr>
            </thead>
            <tbody>
              {series.map((r, i) => (
                <tr key={r.day}>
                  <td>{label(r.day)}</td>
                  {SERIES.map((s) => (
                    <td key={s.key} className="num">
                      {brl(r[s.key])}
                    </td>
                  ))}
                  <td className="num">{brl(totals[i]!)}</td>
                  <td className="num">{r.count}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="scroll-x">
        <div className="chart-wrap" onMouseLeave={() => setHover(null)}>
          <svg viewBox={`0 0 ${W} ${H}`} className="chart" role="img" aria-label={`Faturamento por ${bucket === "month" ? "mês" : "dia"}`}>
            {ticks.map((t) => (
              <g key={t}>
                <line x1={pad.l} x2={W - pad.r} y1={y(t)} y2={y(t)} className="grid" />
                <text x={pad.l - 8} y={y(t) + 4} textAnchor="end" className="axis">
                  {t >= 100000 ? `R$ ${(t / 100000).toLocaleString("pt-BR")} mil` : `R$ ${(t / 100).toLocaleString("pt-BR")}`}
                </text>
              </g>
            ))}
            {series.map((r, i) => {
              const cx = pad.l + band * i + band / 2;
              let acc = 0;
              const segs = SERIES.map((s) => ({ ...s, v: r[s.key] })).filter((s) => s.v > 0);
              return (
                <g key={r.day}>
                  {/* área de toque maior que a barra */}
                  <rect x={pad.l + band * i} y={pad.t} width={band} height={H - pad.t - pad.b} fill="transparent" onMouseEnter={() => setHover(i)} onClick={() => setHover(i)} />
                  {segs.map((s, j) => {
                    const y0 = y(acc);
                    acc += s.v;
                    const y1 = y(acc);
                    const h = Math.max(0, y0 - y1 - (j < segs.length - 1 ? 2 : 0));
                    const topSeg = j === segs.length - 1;
                    return topSeg ? (
                      <path key={s.key} d={roundTop(cx - bw / 2, y1, bw, h + (j ? 0 : 0), 4)} fill={s.color} opacity={hover == null || hover === i ? 1 : 0.45} pointerEvents="none" />
                    ) : (
                      <rect key={s.key} x={cx - bw / 2} y={y1 + 2} width={bw} height={Math.max(0, y0 - y1 - 2)} fill={s.color} opacity={hover == null || hover === i ? 1 : 0.45} pointerEvents="none" />
                    );
                  })}
                  {i % every === 0 && (
                    <text x={cx} y={H - 8} textAnchor="middle" className="axis">
                      {label(r.day)}
                    </text>
                  )}
                </g>
              );
            })}
            <line x1={pad.l} x2={W - pad.r} y1={y(0)} y2={y(0)} className="base" />
          </svg>
          {hover != null && series[hover] && (
            <div className="tip" style={{ left: `${((pad.l + band * hover + band / 2) / W) * 100}%` }}>
              <b>{label(series[hover]!.day)}</b>
              {SERIES.map((s) => (
                <div key={s.key}>
                  <i style={{ background: s.color }} />
                  {s.label}
                  <span>{brl(series[hover]![s.key])}</span>
                </div>
              ))}
              <div className="tip-total">
                Total<span>{brl(totals[hover]!)}</span>
              </div>
              <div className="muted">{series[hover]!.count} vendas</div>
            </div>
          )}
        </div>
        </div>
      )}
    </div>
  );
}

function roundTop(x: number, y: number, w: number, h: number, r: number) {
  const rr = Math.min(r, w / 2, h);
  return `M${x},${y + h} L${x},${y + rr} Q${x},${y} ${x + rr},${y} L${x + w - rr},${y} Q${x + w},${y} ${x + w},${y + rr} L${x + w},${y + h} Z`;
}

function niceTicks(max: number): number[] {
  if (max <= 0) return [0, 1000, 2000, 3000];
  const raw = max / 4;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw)!;
  const out: number[] = [];
  for (let v = 0; v <= max + step * 0.001; v += step) out.push(Math.round(v));
  if (out[out.length - 1]! < max) out.push(out[out.length - 1]! + step);
  return out;
}

function BotPicker({ bots, value, onChange }: { bots: BotListItem[]; value: string[] | null; onChange: (v: string[] | null) => void }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);
  const all = value === null;
  const label = all ? "Todos os bots" : value.length === 0 ? "Nenhum bot" : value.length === 1 ? `@${bots.find((b) => b.id === value[0])?.username}` : `${value.length} de ${bots.length} bots`;
  const toggle = (id: string) => {
    const cur = value ?? bots.map((b) => b.id);
    const next = cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id];
    onChange(next.length === bots.length ? null : next);
  };
  return (
    <div className="bot-picker" ref={box}>
      <button className={`btn${all ? "" : " filtered"}`} aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        {label} <span aria-hidden>▾</span>
      </button>
      {open && (
        <div className="bot-pop" role="group" aria-label="Bots no painel">
          <label className="check">
            <input type="checkbox" checked={all} onChange={() => onChange(all ? [] : null)} />
            <strong>Todos os bots</strong>
          </label>
          <hr />
          {bots.map((b) => (
            <label key={b.id} className="check">
              <input type="checkbox" checked={all || value!.includes(b.id)} onChange={() => toggle(b.id)} />
              <span>
                @{b.username}
                {b.mainChannel && <small>{b.mainChannel}</small>}
              </span>
              <button
                type="button"
                className="only"
                onClick={(e) => {
                  e.preventDefault();
                  onChange([b.id]);
                }}
              >
                só este
              </button>
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Quem são as pessoas de cada etapa do funil ───

const STEP_KEYS = ["started", "viewed_plans", "chose_plan", "pix_generated", "paid"] as const;
type StepKey = (typeof STEP_KEYS)[number];
const STEP_TAB: Record<StepKey, string> = { started: "Iniciaram", viewed_plans: "Viram planos", chose_plan: "Escolheram", pix_generated: "Geraram Pix", paid: "Pagaram" };
const STEP_STOP: Record<StepKey, string> = { started: "Só deu /start", viewed_plans: "Viu os planos", chose_plan: "Escolheu, não gerou Pix", pix_generated: "Gerou Pix, não pagou", paid: "Pagou" };
interface Person {
  customerId: string;
  name: string | null;
  username: string | null;
  telegramUserId: number | null;
  bot: string | null;
  first: string;
  last: string;
  reached: StepKey;
  chosen: { name: string; cents: number } | null;
  pix: { items: string[]; cents: number; status: string; at: string; count: number } | null;
  paid: { items: string[]; cents: number; at: string } | null;
}
const at = (iso: string) => new Date(iso).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });

function FunnelPeople({ q, initial, counts, onClose }: { q: string; initial: number; counts: number[]; onClose: () => void }) {
  const [step, setStep] = useState<StepKey>(STEP_KEYS[initial] ?? "started");
  const [onlyStopped, setOnlyStopped] = useState(false);
  const r = useLoad(() => get<{ total: number; people: Person[] }>(`/api/dashboard/people?${q}&step=${step}`), [q, step]);
  const list = (r.data?.people ?? []).filter((p) => !onlyStopped || p.reached === step);
  const tabs = useRef<HTMLDivElement>(null);
  useEffect(() => {
    tabs.current?.querySelector(".on")?.scrollIntoView({ inline: "center", block: "nearest" });
  }, [step]);
  return (
    <Modal title="Quem passou pelo funil" onClose={onClose} wide>
      <div className="tabs fp-tabs" ref={tabs}>
        {STEP_KEYS.map((k, i) => (
          <button key={k} className={step === k ? "on" : ""} onClick={() => setStep(k)}>
            {STEP_TAB[k]} <small>{counts[i] ?? 0}</small>
          </button>
        ))}
      </div>
      {step !== "paid" && (
        <label className="check-line">
          <input type="checkbox" checked={onlyStopped} onChange={(e) => setOnlyStopped(e.target.checked)} /> Só quem parou nesta etapa
        </label>
      )}
      {!r.data ? (
        <Loading error={r.error} />
      ) : list.length === 0 ? (
        <p className="muted">Ninguém aqui no período.</p>
      ) : (
        <div className="scroll-x">
          <table className="rank people">
            <thead>
              <tr>
                <th>Pessoa</th>
                <th>Bot</th>
                <th>Plano escolhido</th>
                <th>Pix</th>
                <th>Chegou até</th>
                <th>Última ação</th>
              </tr>
            </thead>
            <tbody>
              {list.map((p) => (
                <tr key={p.customerId}>
                  <td className="who">
                    <strong>{p.name || (p.username ? `@${p.username}` : `ID ${p.telegramUserId}`)}</strong>
                    {p.name && p.username && <small className="muted">@{p.username}</small>}
                  </td>
                  <td data-label="Bot" className="muted">@{p.bot ?? "?"}</td>
                  <td data-label="Plano escolhido">{p.chosen ? `${p.chosen.name} · ${brl(p.chosen.cents)}` : <span className="muted">—</span>}</td>
                  <td data-label="Pix">
                    {p.paid ? (
                      <span className="money">
                        {brl(p.paid.cents)} pago
                        <small className="muted">{p.paid.items.join(" + ")}</small>
                      </span>
                    ) : p.pix ? (
                      <span>
                        {brl(p.pix.cents)} {p.pix.status === "paid" ? <span className="money">pago</span> : <span className="pend">em aberto</span>}
                        <small className="muted">
                          {p.pix.items.join(" + ")}
                          {p.pix.count > 1 ? ` · ${p.pix.count} Pix gerados` : ""}
                        </small>
                      </span>
                    ) : (
                      <span className="muted">—</span>
                    )}
                  </td>
                  <td data-label="Chegou até">
                    <span className={`chip ${p.reached === "paid" ? "ok" : p.reached === "pix_generated" ? "warn" : "plain"}`}>{STEP_STOP[p.reached]}</span>
                  </td>
                  <td data-label="Última ação" className="muted nowrap">{at(p.last)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {r.data.total > r.data.people.length && <p className="small muted">Mostrando as {r.data.people.length} mais recentes de {r.data.total}.</p>}
        </div>
      )}
    </Modal>
  );
}
