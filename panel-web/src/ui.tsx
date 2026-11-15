import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { moneyInput, parseMoney } from "./api";

// ── Aviso rápido no rodapé ──
const ToastCtx = createContext<(msg: string, bad?: boolean) => void>(() => {});
export function ToastProvider({ children }: { children: ReactNode }) {
  const [t, setT] = useState<{ msg: string; bad?: boolean } | null>(null);
  useEffect(() => {
    if (!t) return;
    const id = setTimeout(() => setT(null), 3500);
    return () => clearTimeout(id);
  }, [t]);
  const show = useCallback((msg: string, bad?: boolean) => setT({ msg, bad }), []);
  return (
    <ToastCtx.Provider value={show}>
      {children}
      {t && (
        <div className={`toast${t.bad ? " bad" : ""}`} role="status">
          {t.msg}
        </div>
      )}
    </ToastCtx.Provider>
  );
}
export const useToast = () => useContext(ToastCtx);

/** Carrega dados da API com estado de carregamento/erro e recarga. */
export function useLoad<T>(fn: () => Promise<T>, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [n, setN] = useState(0);
  useEffect(() => {
    let alive = true;
    fn()
      .then((d) => alive && (setData(d), setError(null)))
      .catch((e) => alive && setError(e.message));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, n]);
  return { data, error, reload: () => setN((x) => x + 1), setData };
}

export function Loading({ error }: { error?: string | null }) {
  if (error) return <div className="note bad">{error}</div>;
  return <p className="muted">Carregando…</p>;
}

export function Toggle({ checked, onChange, children }: { checked: boolean; onChange: (v: boolean) => void; children?: ReactNode }) {
  return (
    <label className="toggle">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {children}
    </label>
  );
}

/** Campo de dinheiro: o usuário digita "24,90". */
export function MoneyField({ value, onChange, placeholder }: { value: number | null; onChange: (cents: number | null) => void; placeholder?: string }) {
  const [txt, setTxt] = useState(moneyInput(value));
  useEffect(() => {
    if (parseMoney(txt) !== value) setTxt(moneyInput(value));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  return (
    <div className="money-input">
      <input
        type="text"
        inputMode="decimal"
        value={txt}
        placeholder={placeholder ?? "0,00"}
        onChange={(e) => {
          setTxt(e.target.value);
          onChange(parseMoney(e.target.value));
        }}
        onBlur={() => setTxt(moneyInput(parseMoney(txt)))}
      />
    </div>
  );
}

export function Modal({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);
  return (
    <div className="backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={title}>
        <h2>{title}</h2>
        {children}
      </div>
    </div>
  );
}

/** Botão que mostra "Salvando…" e trata o erro com aviso. */
export function useAction() {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<unknown>, ok?: string) => {
    setBusy(true);
    try {
      await fn();
      if (ok) toast(ok);
      return true;
    } catch (e) {
      toast((e as Error).message, true);
      return false;
    } finally {
      setBusy(false);
    }
  };
  return { busy, run };
}

export const UNIT_OPTIONS = [
  { value: "day", label: "Dias" },
  { value: "month", label: "Meses" },
  { value: "year", label: "Anos" },
  { value: "lifetime", label: "Vitalício" },
] as const;
