// Camada única de pagamento: cada provedor implementa createPix e status.
// Para adicionar um gateway novo, basta um adaptador aqui.
import { decryptJson } from "../lib/crypto.js";
import { PaggoneClient, PAGGONE_SANDBOX, pgCents, pgPaid } from "../integrations/paggone.js";
import { ppCents, ppPaid, PushinPayClient } from "../integrations/pushinpay.js";

export type Provider = "pushinpay" | "paggone";

export interface PixCreated {
  txId: string;
  code: string;
  qrBase64: string | null;
}
export interface PixStatus {
  paid: boolean;
  amountCents: number | null;
}

export interface PixGateway {
  provider: Provider;
  createPix(a: { amountCents: number; ref: string; description: string; expiresAt: Date; webhookUrl: string }): Promise<PixCreated>;
  status(txId: string): Promise<PixStatus>;
  /** Intervalo mínimo entre consultas da mesma cobrança (limite do provedor). */
  pollEveryMs: number;
}

export interface GatewayRow {
  id: string;
  provider: Provider;
  secret: string;
  config: { sandbox?: boolean; baseUrl?: string | null };
}

/** Monta o cliente a partir do cadastro (credenciais criptografadas). */
export function gatewayClient(row: GatewayRow, appSecret: string, fetchImpl: typeof fetch = fetch): PixGateway {
  const s = decryptJson<{ token?: string; apiKey?: string }>(row.secret, appSecret);
  if (row.provider === "pushinpay") {
    const c = new PushinPayClient(s.token ?? "", fetchImpl, { sandbox: row.config.sandbox, baseUrl: row.config.baseUrl });
    return {
      provider: "pushinpay",
      pollEveryMs: 5 * 60_000, // a PushinPay só deixa consultar 1x/min por transação
      async createPix(a) {
        const r = await c.createPix({ amountCents: a.amountCents, webhookUrl: a.webhookUrl });
        return { txId: r.id, code: r.code, qrBase64: r.qrBase64 };
      },
      async status(txId) {
        const t = await c.getTransaction(txId);
        return { paid: ppPaid(t), amountCents: ppCents(t) };
      },
    };
  }
  const c = new PaggoneClient(s.apiKey ?? "", fetchImpl, row.config.baseUrl || (row.config.sandbox ? PAGGONE_SANDBOX : undefined));
  return {
    provider: "paggone",
    pollEveryMs: 60_000,
    async createPix(a) {
      const r = await c.createPix({ amountCents: a.amountCents, description: a.description, ref: a.ref, expiresAt: a.expiresAt, webhookUrl: a.webhookUrl });
      return { txId: r.id, code: r.code, qrBase64: r.qrBase64 };
    },
    async status(txId) {
      const t = await c.getTransaction(txId);
      return { paid: pgPaid(t), amountCents: pgCents(t.amount) };
    },
  };
}
