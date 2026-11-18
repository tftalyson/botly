// Senhas e sessões do painel e do super admin. Só usa o crypto do Node (sem dependências).
import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number) => Promise<Buffer>;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, 64);
  return `scrypt$${salt.toString("base64")}$${hash.toString("base64")}`;
}

/** Hash falso para gastar o mesmo tempo quando o e-mail não existe. */
export const DUMMY_HASH = "scrypt$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==";

export async function verifyPassword(password: string, stored: string | null | undefined): Promise<boolean> {
  if (!stored) return false;
  const [kind, salt, hash] = stored.split("$");
  if (kind !== "scrypt" || !salt || !hash) return false;
  const expected = Buffer.from(hash, "base64");
  const got = await scrypt(password, Buffer.from(salt, "base64"), expected.length);
  return got.length === expected.length && timingSafeEqual(got, expected);
}

/** Token aleatório para cookie de sessão ou link de primeiro acesso. */
export const newToken = () => randomBytes(32).toString("base64url");
export const tokenHash = (token: string) => createHash("sha256").update(token).digest("hex");

/** Regras mínimas de senha, com mensagem para a tela. */
export function passwordProblem(pw: string): string | null {
  if (pw.length < 8) return "A senha precisa ter pelo menos 8 caracteres.";
  if (!/[a-zA-Z]/.test(pw) || !/\d/.test(pw)) return "Use letras e números na senha.";
  return null;
}

/** Limite simples de tentativas de login (por IP + e-mail), em memória. */
export class LoginLimiter {
  private hits = new Map<string, { n: number; until: number }>();
  constructor(
    private max = 8,
    private windowMs = 15 * 60_000,
  ) {}
  blocked(key: string, now = Date.now()) {
    const h = this.hits.get(key);
    return Boolean(h && h.until > now && h.n >= this.max);
  }
  fail(key: string, now = Date.now()) {
    const h = this.hits.get(key);
    if (this.hits.size > 5000) for (const [k, v] of this.hits) if (v.until <= now) this.hits.delete(k);
    if (!h || h.until <= now) this.hits.set(key, { n: 1, until: now + this.windowMs });
    else h.n++;
  }
  reset(key: string) {
    this.hits.delete(key);
  }
}
