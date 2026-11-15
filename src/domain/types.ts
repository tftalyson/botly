// Formatos dos campos JSON do banco (configurações editadas no painel).

export interface AccountSettings {
  /** Fuso usado para "hoje", lembretes e gráficos. */
  timezone?: string;
  /** Canal/grupo do Telegram que recebe o aviso de cada venda (opcional). */
  notifyChatId?: number | null;
  /** Bot que posta nesse canal de avisos. */
  notifyBotId?: string | null;
  /** Horário em que os lembretes de vencimento saem (HH:mm). Padrão 10:00. */
  reminderTime?: string;
  /** Exigir confirmação de maioridade no /start (padrão: sim). */
  ageGate?: boolean;
  /** Corte automático ligado? Desligado = modo simulação (só mostra quem sairia). */
  autoRemove?: boolean;
  /** Horas de tolerância depois do vencimento antes de remover. */
  removeGraceHours?: number;
  /** Dias sem repetir uma oferta recusada. Padrão 30. */
  offerCooldownDays?: number;
  /** Atendimento humano: horário (HH:mm) e mensagem fora do horário. */
  supportStart?: string;
  supportEnd?: string;
  supportOffMessage?: string;
}

export interface TemplateMedia {
  type: "photo" | "video" | "animation";
  /** file_id do Telegram (depois do 1º envio) ou URL pública. */
  fileId?: string | null;
  url?: string | null;
  /** Arquivo enviado pelo painel (tabela media). */
  mediaId?: string | null;
}

export interface BotWelcome {
  text: string;
  media?: TemplateMedia | null;
}

export interface TemplateButton {
  text: string;
  /** Ação interna (renew, renew_upsell, long_plan, plans) ou link externo. */
  action?: string;
  url?: string;
}

/** Como o bot escolhe o gateway de cada Pix. */
export interface BotRouting {
  /**
   * fixed = sempre o 1º da lista; alternar = o que gerou menos cobranças hoje;
   * equilibrar = o que recebeu menos hoje; limite = usa o 1º até o limite do dia e passa ao próximo.
   * Em todos: se o gateway der erro, tenta o próximo (reserva).
   */
  mode: "fixed" | "alternar" | "equilibrar" | "limite";
  gatewayIds: string[];
  /** Só no modo limite: valor máximo recebido por dia em cada gateway (centavos). */
  dailyLimitCents?: Record<string, number>;
}

export interface BotUpsell {
  /** 1) Na compra, antes do Pix: "adicionar canal X por +R$". */
  orderBump?: { enabled: boolean; channelIds: string[]; priceOverrides?: Record<string, number> };
  /** 2) Logo após o pagamento, para quem recusou o 1: desconto por tempo limitado. */
  postSale?: { enabled: boolean; discountPct: number; validMinutes: number };
  /** 3) Na renovação: botão de renovar com extra e botão do plano longo. */
  renewal?: { enabled: boolean; extraChannelId?: string | null; longPlanId?: string | null; longPlanDiscountPct?: number };
}

/** Recuperação de Pix gerado e não pago. As mensagens ficam em templates (kind recovery). */
export interface BotRecovery {
  enabled?: boolean;
  /** Plano mais barato oferecido na última etapa (downsell). */
  downsellPlanId?: string | null;
}

/** Item de um pedido. Cada item libera um ou mais canais por um período. */
export interface OrderItem {
  type: "plan" | "extra" | "bundle";
  refId: string;
  name: string;
  channelIds: string[];
  durationUnit: "day" | "month" | "year" | "lifetime";
  durationValue: number;
  priceCents: number;
  /** Extra comprado no meio do ciclo: vence junto com o plano principal. */
  alignToExpiresAt?: string | null;
}
