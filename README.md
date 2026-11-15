# Botly

Plataforma para vender acesso a canais do Telegram por bots: planos, Pix,
upsell, lembretes de vencimento, renovação e corte automáticos. Multi-conta.

## Rodar no computador

```bash
docker compose -f docker-compose.dev.yml up -d
cp .env.example .env   # preencher
npm install
npm run dev
```

## Variáveis

| Variável | Para que serve |
|---|---|
| `DATABASE_URL` | Postgres do Botly (separado da MIA) |
| `REDIS_URL` | Redis do Botly |
| `APP_SECRET` | 32+ caracteres; criptografa tokens dos bots e chaves dos gateways |
| `PUBLIC_URL` | Endereço público da API (webhooks do Telegram e dos gateways) |
| `BOTLY_ROLE` | `api`, `panel` ou `admin` |

## Documentos

- `docs/fluxo-bot.md` — fluxo de conversa do bot
- `CLAUDE.md` — decisões do projeto
