import { useEffect, useState, type FormEvent } from "react";
import { Navigate, NavLink, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { get, post, setUnauthorizedHandler, type Me } from "./api";
import { ToastProvider } from "./ui";
import { HomePage } from "./pages/home";
import { BotsPage } from "./pages/bots";
import { BotPage } from "./pages/bot";
import { ChannelsPage } from "./pages/channels";
import { BundlesPage } from "./pages/bundles";
import { GatewaysPage } from "./pages/gateways";
import { SettingsPage } from "./pages/settings";

function Wordmark() {
  return (
    <a className="wordmark" href="/">
      <b>botly</b>
      <i aria-hidden />
    </a>
  );
}

export function App() {
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const [setupNeeded, setSetupNeeded] = useState(false);

  async function refresh() {
    try {
      setMe(await get<Me>("/api/me"));
    } catch {
      setMe(null);
      setSetupNeeded((await get<{ needed: boolean }>("/api/setup").catch(() => ({ needed: false }))).needed);
    }
  }
  useEffect(() => {
    setUnauthorizedHandler(() => setMe(null));
    void refresh();
  }, []);

  if (me === undefined) return null;
  return <ToastProvider>{me ? <Shell me={me} onLogout={() => setMe(null)} /> : <Auth setup={setupNeeded} onDone={refresh} />}</ToastProvider>;
}

function Shell({ me, onLogout }: { me: Me; onLogout: () => void }) {
  const [open, setOpen] = useState(false);
  const loc = useLocation();
  useEffect(() => setOpen(false), [loc.pathname]);
  return (
    <div className="shell">
      <div className="topbar">
        <Wordmark />
        <button onClick={() => setOpen(true)} aria-label="Abrir menu">
          Menu
        </button>
      </div>
      <aside className={`rail${open ? " open" : ""}`} onClick={(e) => e.target === e.currentTarget && setOpen(false)}>
        <Wordmark />
        <nav className="nav">
          <NavLink to="/" end>
            Início
          </NavLink>
          <NavLink to="/bots">Bots</NavLink>
          <NavLink to="/canais">Canais</NavLink>
          <NavLink to="/pacotes">Pacotes</NavLink>
          <NavLink to="/pagamentos">Formas de pagamento</NavLink>
          <div className="nav-group">Em seguida</div>
          <span>
            Clientes <small>em breve</small>
          </span>
          <span>
            Retenção <small>em breve</small>
          </span>
          <span>
            Lembretes <small>em breve</small>
          </span>
          <div className="nav-group" />
          <NavLink to="/configuracoes">Configurações</NavLink>
        </nav>
        <div className="rail-foot">
          <strong>{me.account.name}</strong>
          {me.user.email}
          <br />
          <button
            onClick={async () => {
              await post("/api/logout").catch(() => {});
              onLogout();
            }}
          >
            Sair
          </button>
        </div>
      </aside>
      <main className="main">
        <div className="page">
          <Routes>
            <Route path="/" element={<HomePage me={me} />} />
            <Route path="/bots" element={<BotsPage />} />
            <Route path="/bots/:id" element={<BotPage />} />
            <Route path="/canais" element={<ChannelsPage />} />
            <Route path="/pacotes" element={<BundlesPage />} />
            <Route path="/pagamentos" element={<GatewaysPage />} />
            <Route path="/configuracoes" element={<SettingsPage />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </div>
      </main>
    </div>
  );
}

function Auth({ setup, onDone }: { setup: boolean; onDone: () => void }) {
  const nav = useNavigate();
  const [f, setF] = useState({ accountName: "", name: "", email: "", password: "" });
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      if (setup) await post("/api/setup", f);
      else await post("/api/login", { email: f.email, password: f.password });
      nav("/");
      onDone();
    } catch (x) {
      setErr((x as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  return (
    <div className="auth">
      <div className="auth-art">
        <Wordmark />
        <div>
          <h1>Seus canais vendendo sozinhos.</h1>
          <p>Planos, Pix, renovação e entrada no canal no automático, com cada bot e cada venda num lugar só.</p>
        </div>
        <span className="small" style={{ color: "#8c87b0" }}>
          botlybrasil.tech
        </span>
      </div>
      <div className="auth-form">
        <form onSubmit={submit}>
          <h2>{setup ? "Primeiro acesso" : "Entrar"}</h2>
          {setup && <p className="muted">Crie o seu usuário de dono. Este passo só aparece uma vez.</p>}
          {setup && (
            <>
              <label className="field">
                Nome da operação
                <input type="text" value={f.accountName} onChange={set("accountName")} placeholder="Ex.: Top Canais" required />
              </label>
              <label className="field">
                Seu nome
                <input type="text" value={f.name} onChange={set("name")} required />
              </label>
            </>
          )}
          <label className="field">
            E-mail
            <input type="email" value={f.email} onChange={set("email")} autoComplete="username" required />
          </label>
          <label className="field">
            Senha
            {setup && <small>Pelo menos 8 caracteres, com letras e números.</small>}
            <input type="password" value={f.password} onChange={set("password")} autoComplete={setup ? "new-password" : "current-password"} required />
          </label>
          {err && <p className="error-text">{err}</p>}
          <button className="btn primary" disabled={busy}>
            {busy ? "Aguarde…" : setup ? "Criar acesso" : "Entrar"}
          </button>
        </form>
      </div>
    </div>
  );
}
