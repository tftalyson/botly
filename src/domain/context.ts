import type { Db } from "../db/client.js";

/** Dependências compartilhadas (facilita os testes: relógio e fetch trocáveis). */
export interface Ctx {
  db: Db;
  appSecret: string;
  publicUrl: string;
  fetch: typeof fetch;
  now: () => Date;
  /** Chamado quando um Pix é pago com valor menor que o cobrado (quem monta o ctx liga isso aos avisos). */
  /** Chamado quando um segundo Pix do mesmo pedido (já pago) é pago: pagamento em duplicidade. */
  onDuplicatePaid?: (info: { chargeId: string }) => Promise<void>;
  onUnderpaid?: (info: { chargeId: string; paidCents: number }) => Promise<void>;
  log: { info: (o: unknown, m?: string) => void; warn: (o: unknown, m?: string) => void; error: (o: unknown, m?: string) => void };
}

export const FUNNEL = ["started", "viewed_plans", "chose_plan", "pix_generated", "paid", "joined"] as const;
export type FunnelStage = (typeof FUNNEL)[number];
