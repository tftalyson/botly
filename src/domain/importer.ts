// Importação de assinantes de outro gerenciador (planilha .xlsx ou .csv).
// Feita para a exportação do AutomatizzeBot ("assinantes.xlsx"), mas reconhece as
// colunas pelo nome ou pelo conteúdo, então serve para planilhas parecidas.
//
// Regras:
// - Uma linha = uma compra. O mesmo cliente pode aparecer várias vezes (renovações):
//   fica o MAIOR vencimento; valor e plano vêm da compra mais recente.
// - ID do Telegram é obrigatório (é o único jeito de cobrar e remover).
// - Vencimento futuro = acesso ativo (entra nos lembretes). Passado = removido.
import ExcelJS from "exceljs";
import { and, eq, inArray } from "drizzle-orm";
import * as s from "../db/schema.js";
import type { Ctx } from "./context.js";
import { atLocal, DEFAULT_TZ } from "../lib/time.js";

export interface RawRow {
  line: number;
  userCell: string;
  amountCents: number | null;
  boughtAt: Date | null;
  expiresAt: Date | null;
  paymentId: string | null;
  /** Situação da compra na planilha (Ativa, Expirada, Pendente...). */
  status: string | null;
}

export interface ParsedRow extends RawRow {
  telegramId: number | null;
  username: string | null;
}

type Col = "user" | "amount" | "bought" | "expires" | "payment" | "status";
const HEADERS: Record<Col, RegExp> = {
  user: /user|usu[aá]rio|telegram|cliente|id\b/i,
  amount: /valor|pre[cç]o|amount|total/i,
  bought: /compra|criad|data\b|in[ií]cio|pago em|pagamento em/i,
  expires: /venc|expira|validade|t[eé]rmino|fim/i,
  payment: /pagamento|payment|transa/i,
  status: /status|situa/i,
};

/** Situações que querem dizer "não pago": a linha é ignorada. */
export const UNPAID = /pendente|aguardando|cancelad|recusad|estornad|reembols|expired_pix|pending|canceled|refunded|failed/i;
const STATUS_WORDS = /\b(ativa|ativo|expirada|expirado|pendente|cancelad[ao]|aprovad[ao]|pago|recusad[ao]|estornad[ao]|active|expired|pending|paid|canceled)\b/i;

const asText = (v: unknown): string => {
  if (v == null) return "";
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "object") {
    const o = v as { text?: string; richText?: { text: string }[]; result?: unknown };
    if (o.richText) return o.richText.map((r) => r.text).join("");
    if (o.text) return String(o.text);
    if (o.result !== undefined) return asText(o.result);
  }
  return String(v).trim();
};

/** "R$ 24,90", "24,90", "24.90", 24.9 → centavos. */
export function parseMoney(v: unknown): number | null {
  if (typeof v === "number") return Math.round(v * 100);
  const t = asText(v).replace(/[^\d,.-]/g, "");
  if (!t) return null;
  const n = Number(t.includes(",") ? t.replace(/\./g, "").replace(",", ".") : t);
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}

/** Data em dd/mm/aaaa [hh:mm[:ss]], ISO ou data do Excel. Sem hora: fim do dia (23:59) no fuso. */
export function parseDate(v: unknown, tz = DEFAULT_TZ, endOfDay = true): Date | null {
  if (v instanceof Date) {
    // O Excel guarda data/hora "de parede" como se fosse UTC.
    const hasTime = v.getUTCHours() + v.getUTCMinutes() + v.getUTCSeconds() > 0;
    const hhmm = hasTime ? `${String(v.getUTCHours()).padStart(2, "0")}:${String(v.getUTCMinutes()).padStart(2, "0")}` : endOfDay ? "23:59" : "00:00";
    return atLocal(v.getUTCFullYear(), v.getUTCMonth() + 1, v.getUTCDate(), hhmm, tz);
  }
  const t = asText(v);
  let m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})(?:[ T,]+(\d{1,2}):(\d{2})(?::\d{2})?)?/);
  if (m) {
    const y = Number(m[3]!.length === 2 ? "20" + m[3] : m[3]);
    const hhmm = m[4] ? `${m[4].padStart(2, "0")}:${m[5]}` : endOfDay ? "23:59" : "00:00";
    return atLocal(y, Number(m[2]), Number(m[1]), hhmm, tz);
  }
  m = t.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?/);
  if (m) return atLocal(Number(m[1]), Number(m[2]), Number(m[3]), m[4] ? `${m[4]}:${m[5]}` : endOfDay ? "23:59" : "00:00", tz);
  return null;
}

/** "Daviii351 5031061482" → { username: "Daviii351", telegramId: 5031061482 }. */
export function parseUser(cell: string): { telegramId: number | null; username: string | null } {
  const ids = cell.match(/\d{5,15}/g);
  const id = ids ? Number(ids[ids.length - 1]) : null;
  const rest = cell
    .replace(/\d{5,15}/g, " ")
    .replace(/[()[\]|,;-]/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const username = rest.length ? rest[0]!.replace(/^@/, "") : null;
  return { telegramId: id && Number.isSafeInteger(id) ? id : null, username: username && /^[\w.]{2,64}$/.test(username) ? username : null };
}

/** Lê a planilha e devolve as linhas (com o mapa de colunas usado). */
export async function readSheet(file: Buffer, fileName: string, tz = DEFAULT_TZ): Promise<{ rows: ParsedRow[]; columns: Partial<Record<Col, string>> }> {
  let table: unknown[][] = [];
  if (/\.csv$/i.test(fileName)) {
    const text = file.toString("utf8").replace(/^﻿/, "");
    const sep = (text.split("\n")[0]!.match(/;/g)?.length ?? 0) > (text.split("\n")[0]!.match(/,/g)?.length ?? 0) ? ";" : ",";
    table = text
      .split(/\r?\n/)
      .filter((l) => l.trim())
      .map((l) => l.split(sep).map((c) => c.replace(/^"|"$/g, "").trim()));
  } else {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(file as unknown as ArrayBuffer);
    const ws = wb.worksheets[0];
    if (!ws) throw new Error("A planilha está vazia.");
    ws.eachRow({ includeEmpty: false }, (row) => {
      const vals = row.values as unknown[];
      table.push(vals.slice(1));
    });
  }
  if (table.length < 2) throw new Error("A planilha não tem linhas de assinantes.");

  // Acha a linha de títulos (a primeira com pelo menos 2 títulos reconhecidos).
  let headerIdx = 0;
  const idx: Partial<Record<Col, number>> = {};
  for (let r = 0; r < Math.min(5, table.length); r++) {
    const cells = table[r]!.map(asText);
    const found: Partial<Record<Col, number>> = {};
    cells.forEach((c, i) => {
      // "ID Pagamento" é pagamento, não usuário; "Vencimento" antes de "compra".
      if (HEADERS.expires.test(c)) found.expires ??= i;
      else if (HEADERS.status.test(c)) found.status ??= i;
      else if (/pagamento|payment|transa/i.test(c) && /id/i.test(c)) found.payment ??= i;
      else if (HEADERS.user.test(c)) found.user ??= i;
      else if (HEADERS.amount.test(c)) found.amount ??= i;
      else if (HEADERS.bought.test(c)) found.bought ??= i;
    });
    if (Object.keys(found).length >= 2) {
      headerIdx = r;
      Object.assign(idx, found);
      break;
    }
  }
  const header = table[headerIdx]!.map(asText);
  const body = table.slice(headerIdx + 1);
  // Sem título reconhecido: adivinha pelo conteúdo das primeiras linhas.
  if (idx.user === undefined) idx.user = header.findIndex((_, i) => body.slice(0, 20).some((r) => /\d{6,15}/.test(asText(r[i]))));
  if (idx.expires === undefined) {
    const dateCols = header.map((_, i) => i).filter((i) => body.slice(0, 20).some((r) => parseDate(r[i], tz)));
    idx.expires = dateCols.at(-1);
    if (idx.bought === undefined && dateCols.length > 1) idx.bought = dateCols[0];
  }
  // Coluna de situação (Ativa/Expirada/Pendente): pelo título ou pelo conteúdo.
  if (idx.status === undefined) {
    const sample = body.slice(0, 50);
    const hit = header.findIndex((_, i) => sample.filter((r) => STATUS_WORDS.test(asText(r[i]))).length > sample.length / 2);
    if (hit >= 0) idx.status = hit;
  }
  if (idx.user === undefined || idx.user < 0) throw new Error("Não achei a coluna com o ID do Telegram dos clientes.");
  if (idx.expires === undefined) throw new Error("Não achei a coluna de vencimento.");

  const columns: Partial<Record<Col, string>> = {};
  (Object.keys(idx) as Col[]).forEach((k) => idx[k] !== undefined && (columns[k] = header[idx[k]!] || `coluna ${idx[k]! + 1}`));
  // Coluna própria de @usuário (planilha completa do AutomatizzeBot), quando existe e não é a do ID.
  const unameIdx = header.findIndex((h, i) => i !== idx.user && /^(user ?name|usu[aá]rio)$/i.test(h.trim()));
  const rows: ParsedRow[] = body.map((r, i) => {
    const userCell = asText(r[idx.user!]);
    const parsed = parseUser(userCell);
    const uname = unameIdx >= 0 ? asText(r[unameIdx]).replace(/^@/, "") : "";
    return {
      line: headerIdx + i + 2,
      userCell,
      ...parsed,
      username: parsed.username ?? (/^[\w.]{2,64}$/.test(uname) ? uname : null),
      amountCents: idx.amount !== undefined ? parseMoney(r[idx.amount]) : null,
      boughtAt: idx.bought !== undefined ? parseDate(r[idx.bought], tz, false) : null,
      expiresAt: parseDate(r[idx.expires!], tz),
      paymentId: idx.payment !== undefined ? asText(r[idx.payment]) || null : null,
      status: idx.status !== undefined ? asText(r[idx.status]) || null : null,
    };
  });
  return { rows, columns };
}

export interface ImportCustomer {
  telegramId: number;
  username: string | null;
  expiresAt: Date;
  amountCents: number | null;
  durationDays: number | null;
  purchases: number;
  totalCents: number;
}
export interface PriceGroup {
  key: string;
  amountCents: number | null;
  durationDays: number | null;
  customers: number;
  active: number;
}
export interface Analysis {
  columns: Partial<Record<Col, string>>;
  lines: number;
  invalid: { line: number; text: string; reason: string }[];
  /** Linhas de Pix gerado e não pago (Pendente, Cancelada...): ignoradas. */
  unpaid: number;
  customers: ImportCustomer[];
  active: number;
  expired: number;
  groups: PriceGroup[];
}

/** Duração em dias arredondada para valores comuns (7, 30, 90, 180, 365, vitalício). */
function roundDuration(days: number): number {
  for (const d of [1, 7, 15, 30, 60, 90, 180, 365]) if (Math.abs(days - d) <= Math.max(1, d * 0.1)) return d;
  if (days > 1000) return 3650;
  return Math.round(days);
}
export const groupKey = (amountCents: number | null, durationDays: number | null) => `${amountCents ?? "?"}|${durationDays ?? "?"}`;

export function analyze(rows: ParsedRow[], now: Date): Analysis {
  const invalid: Analysis["invalid"] = [];
  let unpaid = 0;
  const by = new Map<number, ImportCustomer & { lastBought: number }>();
  for (const r of rows) {
    if (!r.userCell && !r.expiresAt) continue; // linha vazia
    if (r.status && UNPAID.test(r.status)) {
      unpaid++;
      continue;
    }
    if (!r.telegramId) {
      invalid.push({ line: r.line, text: r.userCell.slice(0, 40), reason: "sem ID do Telegram" });
      continue;
    }
    if (!r.expiresAt) {
      invalid.push({ line: r.line, text: r.userCell.slice(0, 40), reason: "sem vencimento" });
      continue;
    }
    const dur = r.boughtAt ? roundDuration((r.expiresAt.getTime() - r.boughtAt.getTime()) / 86_400_000) : null;
    const bought = r.boughtAt?.getTime() ?? r.expiresAt.getTime();
    const cur = by.get(r.telegramId);
    if (!cur) {
      by.set(r.telegramId, { telegramId: r.telegramId, username: r.username, expiresAt: r.expiresAt, amountCents: r.amountCents, durationDays: dur, purchases: 1, totalCents: r.amountCents ?? 0, lastBought: bought });
      continue;
    }
    cur.purchases++;
    cur.totalCents += r.amountCents ?? 0;
    cur.username ??= r.username;
    if (r.expiresAt > cur.expiresAt) cur.expiresAt = r.expiresAt;
    if (bought >= cur.lastBought) {
      cur.lastBought = bought;
      cur.amountCents = r.amountCents;
      cur.durationDays = dur;
      if (r.username) cur.username = r.username;
    }
  }
  const customers = [...by.values()].map(({ lastBought: _l, ...c }) => c);
  const groups = new Map<string, PriceGroup>();
  for (const c of customers) {
    const k = groupKey(c.amountCents, c.durationDays);
    const g = groups.get(k) ?? { key: k, amountCents: c.amountCents, durationDays: c.durationDays, customers: 0, active: 0 };
    g.customers++;
    if (c.expiresAt > now) g.active++;
    groups.set(k, g);
  }
  return {
    columns: {},
    lines: rows.length,
    invalid,
    unpaid,
    customers,
    active: customers.filter((c) => c.expiresAt > now).length,
    expired: customers.filter((c) => c.expiresAt <= now).length,
    groups: [...groups.values()].sort((a, b) => b.customers - a.customers),
  };
}

/** Sugere o plano do bot para cada grupo de valor/duração. */
export function suggestPlans(groups: PriceGroup[], plans: (typeof s.plans.$inferSelect)[]): Record<string, string | null> {
  const days = (p: (typeof s.plans.$inferSelect)) => (p.durationUnit === "day" ? p.durationValue : p.durationUnit === "month" ? p.durationValue * 30 : p.durationUnit === "year" ? p.durationValue * 365 : 3650);
  const out: Record<string, string | null> = {};
  for (const g of groups) {
    const exact = plans.find((p) => p.priceCents === g.amountCents);
    const byDur = g.durationDays ? plans.find((p) => Math.abs(days(p) - g.durationDays!) <= Math.max(1, days(p) * 0.15)) : undefined;
    out[g.key] = (exact ?? byDur)?.id ?? null;
  }
  return out;
}

/**
 * Grava: clientes (marcados como importados), vínculo com o bot (para os lembretes)
 * e acesso ao canal. Nunca encurta um vencimento que já existe no Botly.
 */
export async function applyImport(
  ctx: Ctx,
  a: { accountId: string; botId: string; channelId: string; analysis: Analysis; planMap: Record<string, string | null>; fileName: string; userId?: string | null },
) {
  const now = ctx.now();
  const plans = await ctx.db.select().from(s.plans).where(eq(s.plans.accountId, a.accountId));
  let created = 0;
  let updated = 0;
  let kept = 0;
  const list = a.analysis.customers;
  for (let i = 0; i < list.length; i += 200) {
    const chunk = list.slice(i, i + 200);
    await ctx.db.transaction(async (tx) => {
      const existing = await tx
        .select()
        .from(s.customers)
        .where(and(eq(s.customers.accountId, a.accountId), inArray(s.customers.telegramUserId, chunk.map((c) => c.telegramId))));
      for (const c of chunk) {
        let cust = existing.find((e) => e.telegramUserId === c.telegramId);
        if (!cust) {
          [cust] = await tx
            .insert(s.customers)
            .values({
              accountId: a.accountId,
              telegramUserId: c.telegramId,
              username: c.username,
              imported: true,
              funnelStage: "paid",
              ageConfirmedAt: now,
              totalSpentCents: c.totalCents,
              purchases: c.purchases,
              source: "importado",
            })
            .returning();
        } else if (cust.imported) {
          await tx.update(s.customers).set({ totalSpentCents: Math.max(cust.totalSpentCents, c.totalCents), purchases: Math.max(cust.purchases, c.purchases), username: cust.username ?? c.username }).where(eq(s.customers.id, cust.id));
        }
        await tx.insert(s.customerBots).values({ customerId: cust!.id, botId: a.botId, source: "importado" }).onConflictDoNothing();
        const planId = a.planMap[groupKey(c.amountCents, c.durationDays)] ?? null;
        const plan = plans.find((p) => p.id === planId);
        const active = c.expiresAt > now;
        const cur = (await tx.select().from(s.accesses).where(and(eq(s.accesses.customerId, cust!.id), eq(s.accesses.channelId, a.channelId))))[0];
        const values = {
          status: active ? ("active" as const) : ("removed" as const),
          expiresAt: c.expiresAt,
          planId: plan?.id ?? null,
          lastPriceCents: c.amountCents ?? plan?.priceCents ?? null,
          billingBotId: a.botId,
          removedAt: active ? null : c.expiresAt,
          updatedAt: now,
        };
        if (!cur) {
          await tx.insert(s.accesses).values({ accountId: a.accountId, customerId: cust!.id, channelId: a.channelId, source: "import", ...values });
          created++;
        } else if (cur.expiresAt !== null && cur.expiresAt < c.expiresAt) {
          await tx.update(s.accesses).set(values).where(eq(s.accesses.id, cur.id));
          updated++;
        } else kept++;
      }
    });
  }
  const stats = { linhas: a.analysis.lines, naoPagas: a.analysis.unpaid, clientes: list.length, ativos: a.analysis.active, vencidos: a.analysis.expired, ignorados: a.analysis.invalid.length, novos: created, atualizados: updated, mantidos: kept };
  const [imp] = await ctx.db
    .insert(s.imports)
    .values({ accountId: a.accountId, botId: a.botId, channelId: a.channelId, fileName: a.fileName, status: "done", stats, createdBy: a.userId ?? null })
    .returning();
  return { id: imp!.id, stats };
}
