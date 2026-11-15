import { Link } from "react-router-dom";
import { brl, get, type Me } from "../api";
import { Loading, useLoad } from "../ui";

interface Overview {
  salesToday: { count: number; cents: number };
  activeSubscribers: number;
  checklist: Record<"gateway" | "bot" | "channel" | "mainChannel" | "plans" | "routing", boolean>;
}

const STEPS: { key: keyof Overview["checklist"]; text: string; to: string; action: string }[] = [
  { key: "gateway", text: "Cadastrar uma forma de pagamento (PushinPay)", to: "/pagamentos", action: "Cadastrar" },
  { key: "bot", text: "Conectar um bot do Telegram", to: "/bots", action: "Conectar" },
  { key: "channel", text: "Colocar o bot como admin do canal VIP", to: "/canais", action: "Ver canais" },
  { key: "mainChannel", text: "Escolher qual canal o bot vende", to: "/bots", action: "Abrir bots" },
  { key: "plans", text: "Criar os planos do bot", to: "/bots", action: "Abrir bots" },
  { key: "routing", text: "Ligar a forma de pagamento no bot", to: "/bots", action: "Abrir bots" },
];

export function HomePage({ me }: { me: Me }) {
  const { data, error } = useLoad(() => get<Overview>("/api/overview"));
  const first = me.user.name.split(" ")[0];
  if (!data) return <Loading error={error} />;
  const pending = STEPS.filter((s) => !data.checklist[s.key]);
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Olá, {first}</h1>
          <p>Resumo de hoje. O painel completo de vendas, com gráficos e ranking, chega na próxima etapa.</p>
        </div>
      </div>
      <div className="hero-money">
        <div className="panel">
          <span className="muted">Vendas aprovadas hoje</span>
          <div className="big">{brl(data.salesToday.cents)}</div>
          <span className="muted">
            {data.salesToday.count} {data.salesToday.count === 1 ? "pagamento" : "pagamentos"}
          </span>
        </div>
        <div className="panel">
          <span className="muted">Assinantes ativos</span>
          <div className="big">{data.activeSubscribers}</div>
          <span className="muted">pessoas com pelo menos um canal em dia</span>
        </div>
      </div>
      {pending.length > 0 && (
        <div className="panel">
          <div className="panel-head">
            <div>
              <h2>Para começar a vender</h2>
              <p>
                {STEPS.length - pending.length} de {STEPS.length} feitos
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
      )}
    </>
  );
}
