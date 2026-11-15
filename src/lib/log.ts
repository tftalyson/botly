// Log em JSON de uma linha (lido nos logs do Easypanel).
type Level = "info" | "warn" | "error";
function line(level: Level, o: unknown, m?: string) {
  const extra = o && typeof o === "object" ? (o as Record<string, unknown>) : { data: o };
  const out = JSON.stringify({ t: new Date().toISOString(), level, msg: m, ...extra });
  (level === "error" ? console.error : console.log)(out);
}
export const log = {
  info: (o: unknown, m?: string) => line("info", o, m),
  warn: (o: unknown, m?: string) => line("warn", o, m),
  error: (o: unknown, m?: string) => line("error", o, m),
};
export const silentLog = { info: () => {}, warn: () => {}, error: () => {} };
