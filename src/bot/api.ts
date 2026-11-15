import { Api, type Transformer } from "grammy";

/** API "solta" a partir de um token (cadastro, antes de o bot existir no banco). */
export function apiForToken(token: string, transformer?: Transformer): Api {
  const api = new Api(token);
  if (transformer) api.config.use(transformer);
  return api;
}
