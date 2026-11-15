// Chamadas à API do painel. Alterações levam o cabeçalho x-botly (proteção
// contra formulários de outros sites) e erros viram mensagens legíveis.
export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

let onUnauthorized: () => void = () => {};
export const setUnauthorizedHandler = (fn: () => void) => {
  onUnauthorized = fn;
};

export async function api<T = any>(method: string, url: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      credentials: "same-origin",
      headers: { ...(method !== "GET" ? { "x-botly": "1" } : {}), ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError("Sem conexão com o painel. Confira sua internet.", 0);
  }
  const text = await res.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    /* resposta não-JSON */
  }
  if (!res.ok) {
    if (res.status === 401 && !url.startsWith("/api/login") && !url.startsWith("/api/setup")) onUnauthorized();
    throw new ApiError(data?.error ?? `Erro ${res.status}`, res.status);
  }
  return data as T;
}

export const get = <T = any>(url: string) => api<T>("GET", url);
export const post = <T = any>(url: string, body?: unknown) => api<T>("POST", url, body ?? {});
export const put = <T = any>(url: string, body: unknown) => api<T>("PUT", url, body);
export const del = <T = any>(url: string) => api<T>("DELETE", url);

export const brl = (cents: number) => (cents / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });

/** "24,90" → 2490. Vazio ou inválido → null. */
export function parseMoney(v: string): number | null {
  const t = v.replace(/[^\d,.-]/g, "").trim();
  if (!t) return null;
  const n = Number(t.includes(",") ? t.replace(/\./g, "").replace(",", ".") : t);
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}
export const moneyInput = (cents: number | null | undefined) => (cents == null ? "" : (cents / 100).toFixed(2).replace(".", ","));

export type Unit = "day" | "month" | "year" | "lifetime";
export function durationLabel(unit: Unit, value: number) {
  if (unit === "lifetime") return "Vitalício";
  if (unit === "day") return value === 1 ? "1 dia" : `${value} dias`;
  if (unit === "month") return value === 1 ? "1 mês" : `${value} meses`;
  return value === 1 ? "1 ano" : `${value} anos`;
}

export interface Me {
  user: { id: string; name: string; email: string; role: string };
  account: { id: string; name: string };
}
export interface BotListItem {
  id: string;
  username: string;
  name: string;
  status: "active" | "paused" | "error";
  statusDetail: string | null;
  mainChannel: string | null;
  plans: number;
  subscribers: number;
  hasPayment: boolean;
}
export interface Plan {
  id: string;
  name: string;
  durationUnit: Unit;
  durationValue: number;
  priceCents: number;
  highlight: boolean;
  active: boolean;
  sortOrder: number;
}
export interface Media {
  type: "photo" | "video" | "animation";
  url?: string | null;
  mediaId?: string | null;
  fileId?: string | null;
}

/** Limites do Telegram para bots. */
export const MEDIA_LIMITS: Record<string, { kind: Media["type"]; maxMb: number }> = {
  "image/jpeg": { kind: "photo", maxMb: 10 },
  "image/png": { kind: "photo", maxMb: 10 },
  "image/webp": { kind: "photo", maxMb: 10 },
  "image/gif": { kind: "animation", maxMb: 50 },
  "video/mp4": { kind: "video", maxMb: 50 },
  "video/quicktime": { kind: "video", maxMb: 50 },
};

/** Sobe um arquivo de imagem/vídeo para o Botly. */
export async function uploadMedia(file: File): Promise<{ id: string; kind: Media["type"] }> {
  const rule = MEDIA_LIMITS[file.type];
  if (!rule) throw new ApiError("Formato não aceito. Use foto (JPG, PNG, WEBP), vídeo (MP4, MOV) ou GIF.", 400);
  if (file.size > rule.maxMb * 1024 * 1024) throw new ApiError(`Arquivo grande demais: o Telegram aceita até ${rule.maxMb} MB para ${rule.kind === "photo" ? "fotos" : "vídeos e GIFs"}.`, 400);
  const res = await fetch(`/api/media?name=${encodeURIComponent(file.name)}&mime=${encodeURIComponent(file.type)}`, {
    method: "POST",
    credentials: "same-origin",
    headers: { "x-botly": "1", "Content-Type": "application/octet-stream" },
    body: file,
  }).catch(() => null);
  if (!res) throw new ApiError("Sem conexão com o painel. Confira sua internet.", 0);
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(data?.error ?? `Erro ${res.status}`, res.status);
  return data;
}
export const mediaSrc = (m: Media | null | undefined) => (m?.mediaId ? `/api/media/${m.mediaId}` : (m?.url ?? null));
export interface BotDetail {
  id: string;
  username: string;
  name: string;
  status: "active" | "paused" | "error";
  statusDetail: string | null;
  mainChannelId: string | null;
  welcome: { text: string; media?: Media | null };
  previewUrl: string | null;
  previewButton: string | null;
  routing: { mode: "fixed" | "alternar" | "equilibrar" | "limite"; gatewayIds: string[]; dailyLimitCents?: Record<string, number> };
  upsell: {
    orderBump?: { enabled: boolean; channelIds: string[]; priceOverrides?: Record<string, number> };
    renewal?: { enabled: boolean; extraChannelId?: string | null; longPlanId?: string | null };
  };
  showBundles: boolean;
}
export interface Channel {
  id: string;
  title: string;
  type: string;
  telegramChatId: number;
  inviteLink: string | null;
  rightsOk: boolean;
  rightsCheckedAt: string | null;
  extraPriceCents: number | null;
  active: boolean;
  managerBot: { id: string; username: string } | null;
  sellingBots: string[];
  subscribers: number;
}
export interface Gateway {
  id: string;
  provider: "pushinpay" | "paggone";
  label: string;
  active: boolean;
  sandbox: boolean;
  todayCents: number;
  todayCount: number;
  bots: string[];
}
export interface Bundle {
  id: string;
  name: string;
  description: string | null;
  durationUnit: Unit;
  durationValue: number;
  priceCents: number;
  active: boolean;
  channelIds: string[];
}
export const PROVIDER_NAME: Record<Gateway["provider"], string> = { pushinpay: "PushinPay", paggone: "Paggone" };
