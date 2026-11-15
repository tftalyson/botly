// Cliente da API da paggOne (Paggone): PIX (QR Code + copia e cola) e consulta da
// transação. Só PIX: não tem cartão nem cancelamento de PIX em aberto.
// Valores em centavos dos dois lados.

export class PaggoneError extends Error {
  constructor(
    message: string,
    public status: number,
    public body?: unknown,
  ) {
    super(message);
  }
}

export const PAGGONE_PROD = "https://api.paggpay.com/v1";
export const PAGGONE_SANDBOX = "https://sandbox-api.paggpay.com/v1";

export interface PaggoneTransaction {
  id: string;
  status: string;
  /** Decimal em texto (ex.: "29.90") na consulta; centavos no aviso. */
  amount?: string | number;
  paid_at?: string | null;
  reference_id?: string | null;
  pix?: { reference_id?: string | null; code?: string | null; qr_code?: string | null } | null;
}

/** "yyyy-mm-dd HH:mm:ss" no horário de Brasília. */
function pgDate(d: Date, timeZone = "America/Sao_Paulo") {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" })
      .formatToParts(d)
      .map((x) => [x.type, x.value]),
  );
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`;
}

export class PaggoneClient {
  constructor(
    private apiKey: string,
    private fetchImpl: typeof fetch = fetch,
    private base: string = PAGGONE_PROD,
  ) {}

  private async req<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.fetchImpl(this.base + path, {
      method,
      headers: { Authorization: `Bearer ${this.apiKey}`, Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20_000),
    });
    const text = await res.text();
    let json: any;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      /* não-JSON */
    }
    if (!res.ok) throw new PaggoneError(`Paggone ${method} ${path}: ${json?.message ?? `HTTP ${res.status}`}`, res.status, json ?? text);
    return json as T;
  }

  /** Cria um PIX. `ref` é a referência da nossa cobrança (volta em reference_id). */
  async createPix(a: { amountCents: number; description: string; ref: string; expiresAt: Date; webhookUrl?: string; payerName?: string | null; payerPhone?: string | null }) {
    const r = await this.req<{ data?: { pix?: { id?: string | null; code?: string | null; qrcode?: string | null }; transaction?: { id?: string } } }>("POST", "/pix", {
      value: Math.round(a.amountCents),
      reference_id: a.ref,
      description: a.description,
      expires_at: pgDate(a.expiresAt),
      ...(a.webhookUrl ? { webhook_url: a.webhookUrl } : {}),
      ...(a.payerName ? { payer_name: a.payerName } : {}),
      ...(a.payerPhone ? { payer_phone: a.payerPhone } : {}),
    });
    // A resposta pode variar entre contas/versões: procura o que precisa em qualquer lugar dela.
    let txn = findTxn(r);
    let code = findEmv(r);
    let qrRaw = findQr(r);
    const pixId = (r as any)?.data?.pix?.id ?? (r as any)?.pix?.id ?? null;
    // O código pode demorar uns instantes: consulta a transação (e o PIX) antes de desistir.
    for (let i = 0; (txn || pixId) && !code && i < 3; i++) {
      if (i) await new Promise((res) => setTimeout(res, 1500));
      if (txn) {
        const t = await this.req<unknown>("GET", `/transactions/${encodeURIComponent(txn)}`).catch(() => null);
        code = findEmv(t);
        qrRaw = qrRaw ?? findQr(t);
      }
      if (!code && pixId) {
        const p = await this.req<unknown>("GET", `/pix/${encodeURIComponent(pixId)}`).catch(() => null);
        code = findEmv(p);
        qrRaw = qrRaw ?? findQr(p);
        txn = txn ?? findTxn(p);
      }
    }
    if (!code || !txn) throw new PaggoneError(`A Paggone não devolveu o código PIX. Resposta: ${JSON.stringify(r).slice(0, 300)}`, 502, r);
    // O QR vem como "data:image/png;base64,…": o WhatsApp quer só o base64.
    const qr = qrRaw ? qrRaw.replace(/^data:[^;]+;base64,/, "") : null;
    return { id: txn, code, qrBase64: qr };
  }

  async getTransaction(id: string): Promise<PaggoneTransaction> {
    const r = await this.req<{ data: PaggoneTransaction }>("GET", `/transactions/${encodeURIComponent(id)}`);
    return r.data;
  }

  /** Teste de conexão (saldo da conta). */
  balance() {
    return this.req<unknown>("GET", "/balance");
  }
}

export const pgPaid = (t: PaggoneTransaction | null | undefined) => Boolean(t && (t.status === "succeeded" || t.status === "paid"));

/** Centavos de um valor da Paggone (decimal em texto na consulta, inteiro em centavos no aviso). */
export function pgCents(v: string | number | undefined | null): number | null {
  if (v === undefined || v === null || v === "") return null;
  if (typeof v === "number") return Math.round(v);
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}

/** Todos os textos de um JSON, com o caminho (para achar campos com nomes diferentes). */
function strings(x: unknown, path = "", out: [string, string][] = []): [string, string][] {
  if (typeof x === "string") out.push([path, x]);
  else if (Array.isArray(x)) x.forEach((y, i) => strings(y, `${path}.${i}`, out));
  else if (x && typeof x === "object") for (const [k, v] of Object.entries(x)) strings(v, path ? `${path}.${k}` : k, out);
  return out;
}
/** Código PIX copia e cola (EMV): sempre começa com "000201". */
export function findEmv(x: unknown): string | null {
  return strings(x).find(([, v]) => /^000201/.test(v.trim()))?.[1].trim() ?? null;
}
/** Imagem do QR: "data:image/…" ou um base64 grande num campo de QR. */
export function findQr(x: unknown): string | null {
  const all = strings(x);
  return all.find(([, v]) => v.startsWith("data:image"))?.[1] ?? all.find(([k, v]) => /qr/i.test(k) && !/^000201/.test(v) && v.length > 200 && /^[A-Za-z0-9+/=\s]+$/.test(v))?.[1] ?? null;
}
/** Id da transação ("txn_…"). */
export function findTxn(x: unknown): string | null {
  return strings(x).find(([k, v]) => /^txn_/.test(v) && !/originator/i.test(k))?.[1] ?? null;
}
