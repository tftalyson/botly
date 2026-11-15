# Botly — contexto do projeto

Plataforma multi-conta para vender acesso a canais/grupos do Telegram por bots:
planos, Pix, upsell, lembretes de vencimento, renovação e corte automáticos.
Dono: Talyson (fala português; respostas sempre em português, linguagem simples, sem jargão).
Vai ser vendida para outras contas; no futuro, taxa por venda via split. A conta do dono tem taxa 0.

**Sistema separado da MIA**: repositório, serviços, Postgres e Redis próprios. Nunca mexer na MIA a partir daqui.
Só copiamos código (crypto, integrações PushinPay e Paggone).

## Decisões tomadas (não mudar sem o Talyson pedir)
- Stack: Node 22 + TypeScript, Fastify, Drizzle + Postgres, Redis, grammY (Telegram). Painel em React/Vite (a fazer).
- Um build, três papéis por `BOTLY_ROLE`: `api` (bots, webhooks, tarefas), `panel` (painel das contas), `admin` (super admin, login e endereço separados).
- Multi-conta desde o início. `accounts.platform_fee_bps` = taxa por venda (0 para o dono); toda cobrança grava `platform_fee_cents`.
- Canal pertence à CONTA. Vários bots podem vender o mesmo canal. Cada canal tem um **bot gestor** (cria o link, aprova entradas, remove).
- Acesso = cliente + canal (um vencimento só). Venda guarda o bot que vendeu. Lembretes saem pelo bot da última compra (`accesses.billing_bot_id`).
- Entrada no canal: link com **pedido de aprovação**, criado automaticamente pelo bot gestor. Só aprova quem tem acesso ativo.
- Cada bot vende um canal principal; outros canais só como extra (upsell) ou dentro de pacotes (pacotes são da conta).
- Upsell em 3 momentos, no máximo 1 oferta por momento: order bump antes do Pix; oferta pós-venda (só para quem recusou o bump); botões na renovação (com extra / plano longo). Oferta recusada não volta por 30 dias. Extra vence junto com o plano.
- Recuperação de Pix: 15 min lembrete; 2 h 10% off; 24 h plano mais barato ou pacote.
- Gateway: começar com **PushinPay** (aceita conteúdo adulto). Rotação: fixed | alternar | equilibrar | limite, com reserva automática se der erro.
- Renovação soma dias ao vencimento atual. Corte começa em **modo simulação** até o Talyson ligar.
- Fluxo de conversa: `docs/fluxo-bot.md` (v1 aprovada pelo Talyson em 15/11).

## Migração do AutomatizzeBot (app.automatizzebot.com.br)
- Conta do Talyson tem 8 bots (4346 @tophotfreebot é teste antigo, fica fora).
- Tela `/bots/subscriptions/{botId}` tem botão de exportar (ícone ao lado de BUSCAR) → `assinantes.xlsx` (`?search_payment_status=approved&export=1`). Colunas: usuário/ID, ID pagamento, valor, assinatura (código + Ativa/Expirada), compra, vencimento.
- Mesmo cliente aparece uma vez por compra: ficar com o maior vencimento por cliente + canal.
- Canais VIP (só estes 5): Top Hotwifes Brasil, Xcornos (amadores), TopFlixVip, Top Trans Brasil, Top Blacks (Negonas).
  Links diferentes no AutomatizzeBot podem ser do mesmo canal. Mapa provável: @TopHotwifes_bot → Top Hotwifes;
  @xcornos_bot e @cornos_brbot → Xcornos; @topflixvipsbot e @LunaMineira_Bot → TopFlixVip; @TopTransBRBot → Top Trans;
  TopBlacksBot → Top Blacks. Confirmar pelo ID do canal no cadastro.
- Usuários/leads (`/bots/sessions/{botId}`) não têm exportação; dá para ler as páginas (HTML do servidor).
- Virada: exportar no dia, usar o MESMO token dos bots, desligar o AutomatizzeBot e revogar os links fixos antigos dos canais.

## Regras de trabalho
- Testes: `DATABASE_URL=postgres://postgres:dev@127.0.0.1:5432/botly_test npx vitest run`. Typecheck: `npm run typecheck`.
- Mudou o schema: `npm run db:generate -- --name <nome>` e commitar a migração.
- Commits em português, terminando com as linhas de atribuição pedidas pela sessão.
- Nunca pedir chaves/tokens no chat (ficam nas variáveis do Easypanel ou no painel).
- Perguntar quando houver dúvida de regra de negócio.

## A validar
- Split da PushinPay (campo de divisão no cashIn): conferir na documentação antes de ligar a taxa.
