// Cliente da API da PushinPay: PIX (QR Code + copia e cola) e consulta da transação.
// Valores em centavos (mínimo 50). Sem dados do pagador e sem cancelamento.
// A consulta direta é limitada (1 por minuto por transação): o Botly confia no aviso
// (webhook) e só confere de tempos em tempos.
import { findEmv, findQr } from "./paggone.js";

export class PushinPayError extends Error {
  constructor(
    message: string,
    public status: number,
    public body?: unknown,
  ) {
    super(message);
  }
}

export const PUSHINPAY_PROD = "https://api.pushinpay.com.br/api";
export const PUSHINPAY_SANDBOX = "https://api-sandbox.pushinpay.com.br/api";

export interface PushinPayTx {
  id?: string;
  status?: string; // created | paid | canceled | expired
  value?: string | number; // centavos
  end_to_end_id?: string | null;
  pix_details?: { emv?: string | null } | null;
}

export class PushinPayClient {
  private base: string;
  constructor(
    private token: string,
    private fetchImpl: typeof fetch = fetch,
    opts: { sandbox?: boolean; baseUrl?: string | null } = {},
  ) {
    this.base = (opts.baseUrl?.trim() || (opts.sandbox ? PUSHINPAY_SANDBOX : PUSHINPAY_PROD)).replace(/\/+$/, "");
  }

  private async req<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.fetchImpl(this.base + path, {
      method,
      headers: { Authorization: `Bearer ${this.token}`, Accept: "application/json", "Content-Type": "application/json" },
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
    if (!res.ok) {
      const details = json?.errors ? ` (${Object.values(json.errors as Record<string, string[]>).flat().join("; ")})` : "";
      throw new PushinPayError(`PushinPay ${method} ${path}: ${json?.message ?? `HTTP ${res.status}`}${details}`, res.status, json ?? text.slice(0, 300));
    }
    return json as T;
  }

  /** Cria um PIX. Devolve o id da transação, o copia e cola e o QR. */
  async createPix(a: { amountCents: number; webhookUrl?: string }) {
    const r = await this.req<any>("POST", "/pix/cashIn", {
      value: Math.max(50, Math.round(a.amountCents)),
      ...(a.webhookUrl ? { webhook_url: a.webhookUrl } : {}),
    });
    const id = r?.id ?? r?.data?.id ?? null;
    const code = (typeof r?.qr_code === "string" && r.qr_code.trim()) || findEmv(r);
    if (!id || !code) throw new PushinPayError(`A PushinPay não devolveu o código PIX. Resposta: ${JSON.stringify(r).slice(0, 300)}`, 502, r);
    const qrRaw = (typeof r?.qr_code_base64 === "string" && r.qr_code_base64) || findQr(r);
    return { id: String(id), code, qrBase64: qrRaw ? qrRaw.replace(/^data:[^;]+;base64,/, "") : null };
  }

  async getTransaction(id: string): Promise<PushinPayTx | null> {
    const r = await this.req<any>("GET", `/transactions/${encodeURIComponent(id)}`);
    if (Array.isArray(r)) return r[0] ?? null; // não encontrada = []
    return (r?.data ?? r) as PushinPayTx;
  }
}

export const ppPaid = (t: PushinPayTx | null | undefined) => String(t?.status ?? "").toLowerCase() === "paid";
export function ppCents(t: PushinPayTx | null | undefined): number | null {
  const n = Number(t?.value);
  return t?.value !== undefined && t?.value !== null && Number.isFinite(n) ? Math.round(n) : null;
}
/** Id da transação num aviso da PushinPay (JSON ou formulário). */
export function ppIdFrom(body: unknown): string | null {
  const b = body as Record<string, any> | null;
  const id = b?.id ?? b?.transaction_id ?? b?.data?.id ?? b?.transaction?.id;
  return typeof id === "string" && id.trim() ? id.trim() : typeof id === "number" ? String(id) : null;
}
