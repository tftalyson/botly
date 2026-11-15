// Datas: vencimentos e "início do dia" no fuso da conta.

export type DurationUnit = "day" | "month" | "year" | "lifetime";
export const DEFAULT_TZ = "America/Sao_Paulo";

/** Soma um período a uma data. Mês e ano respeitam o calendário (31/01 + 1 mês = 28 ou 29/02). */
export function addDuration(from: Date, unit: DurationUnit, value: number): Date | null {
  if (unit === "lifetime") return null;
  const d = new Date(from.getTime());
  if (unit === "day") {
    d.setTime(d.getTime() + value * 86_400_000);
    return d;
  }
  const months = unit === "month" ? value : value * 12;
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return d;
}

/**
 * Novo vencimento ao pagar. Renovar antes de vencer SOMA ao vencimento atual (ninguém
 * perde dias); já vencido conta a partir de agora. null = vitalício (continua vitalício).
 */
export function extendExpiry(current: Date | null | undefined, hadLifetime: boolean, now: Date, unit: DurationUnit, value: number): Date | null {
  if (hadLifetime || unit === "lifetime") return null;
  const base = current && current.getTime() > now.getTime() ? current : now;
  return addDuration(base, unit, value);
}

/** Partes da data/hora num fuso. */
export function zoned(d: Date, tz = DEFAULT_TZ) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" })
      .formatToParts(d)
      .map((x) => [x.type, x.value]),
  );
  return { year: +p.year!, month: +p.month!, day: +p.day!, hour: +p.hour!, minute: +p.minute!, second: +p.second! };
}

/** Início do dia (00:00) no fuso, como instante UTC. */
export function startOfDay(d: Date, tz = DEFAULT_TZ): Date {
  const z = zoned(d, tz);
  const asUtc = Date.UTC(z.year, z.month - 1, z.day, z.hour, z.minute, z.second);
  const offset = asUtc - Math.floor(d.getTime() / 1000) * 1000; // fuso − UTC
  return new Date(Date.UTC(z.year, z.month - 1, z.day) - offset);
}

/** "22/11/2026" no fuso. */
export function fmtDate(d: Date | null | undefined, tz = DEFAULT_TZ): string {
  if (!d) return "vitalício";
  return new Intl.DateTimeFormat("pt-BR", { timeZone: tz, day: "2-digit", month: "2-digit", year: "numeric" }).format(d);
}

/** Texto curto da duração: "7 dias", "1 mês", "6 meses", "Vitalício". */
export function durationLabel(unit: DurationUnit, value: number): string {
  if (unit === "lifetime") return "Vitalício";
  if (unit === "day") return value === 1 ? "1 dia" : `${value} dias`;
  if (unit === "month") return value === 1 ? "1 mês" : `${value} meses`;
  return value === 1 ? "1 ano" : `${value} anos`;
}
