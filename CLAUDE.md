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

## Endereços (domínio botlybrasil.tech)
- `painel.botlybrasil.tech` painel das contas · `admin.botlybrasil.tech` super admin · `api.botlybrasil.tech` webhooks (Telegram e gateways).
- Raiz `botlybrasil.tech`: landing page de vendas com SEO (para vender o Botly a donos de canais), com um painel próprio isolado em algo como `/admin-pv`. **Fica para depois**: primeiro o sistema funcionando.
- VPS própria do Botly na Hostinger com Easypanel (separada da VPS da MIA). IP: 191.96.1.178.

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

## O que já existe
- `src/bot/handlers.ts`: conversa completa (maioridade, boas-vindas com mídia/prévias, planos, pacotes, order bump, Pix com QR + copia e cola, Já paguei, Gerar outro Pix em outro gateway, /meuplano, pedido de entrada aprovado só pelo bot gestor, bot promovido a admin → canal cadastrado sozinho).
- `src/domain/sales.ts`: pedido, Pix com reserva de gateway, `markChargePaid` (não duplica; extra vence junto com o plano; renovação soma).
- `src/api/server.ts`: `/tg/:botId` (confere o segredo do Telegram) e `/pay/:provider/:gatewayId?token=` (sempre confere na API do gateway).
- `src/jobs/ticks.ts`: conferência de Pix pendentes a cada minuto (PushinPay a cada 5 min por cobrança), por 24 h.
- `src/cli/setup.ts`: configuração pelo Console do Easypanel enquanto o painel não existe (conta, gateway, bot, canal, plano, pagamento, boasvindas, previas, avisos, listar).
- Painel (`BOTLY_ROLE=panel`, `src/panel/server.ts` + `panel-web/`): primeiro acesso cria conta + dono (usa a conta do Console se já existir), login por cookie, Início (vendas de hoje, assinantes, passos para começar), Bots (conectar com passo a passo do BotFather; página do bot com abas Geral/Planos/Pagamento/Ofertas e prévia do chat ao vivo), Canais (bot gestor, preço como extra, conferir permissões, adicionar pelo ID), Pacotes, Formas de pagamento (chave criptografada, testar), Configurações (maioridade, canal de avisos).
- Visual do painel: névoa fria #EEF0F6, tinta violeta #1A1633, marca #5B2EFF, verde-água #0E9F86 só para dinheiro; títulos Bricolage Grotesque, texto Figtree. Elemento marcante = prévia do chat na página do bot.
- Retenção (`src/domain/retention.ts`): modelos padrão D-3, D-1, D0 (lembrete) e D+1, D+7 15% (volte); `planOutbox` monta a fila dos próximos 8 dias (chave única acesso+modelo+vencimento) a cada 10 min; `sendDue` manda a cada minuto pelo bot da última compra (pula quem renovou, horário passado há +12 h, quem bloqueou o bot); botões rn:/rnx:/p: (renovar, renovar + extra, plano longo) e wb: (volte com o desconto do modelo); `cutExpired` a cada 5 min: vencido além da tolerância vira expired; com `settings.autoRemove` remove do canal (padrão: simulação). Painel: páginas Retenção (Hoje/Amanhã/7 dias, esperado, renovaram, lista de quem sairia + chave do corte) e Lembretes (horário, tolerância, textos, dias, desconto, mídia); aba Ofertas do bot com “Na renovação”.
- Importação (`src/domain/importer.ts` + página Importar assinantes): lê .xlsx/.csv (colunas reconhecidas pelo nome ou conteúdo; ID = último número de 5+ dígitos da célula; data sem hora = 23:59 no fuso), agrupa por cliente (maior vencimento; valor/duração da compra mais recente), grupos valor+duração → plano do bot (sugestão automática), grava clientes (imported, funil "paid"), vínculo com o bot e acesso (ativo ou removido); nunca encurta vencimento existente; já monta os lembretes.
- Mídia por upload (tabela `media`, bytea): POST /api/media (corpo binário; foto JPG/PNG/WEBP até 10 MB, vídeo MP4/MOV e GIF até 50 MB = limites do Telegram); boas-vindas guarda `mediaId` e o bot sobe o arquivo no 1º /start e passa a usar o file_id.
- Deploy: os dois serviços (botly e painel) implantam pelo mesmo push; em 15/11 falharam juntos em 0 s ("### Error" sem detalhe). Se repetir, implantar um de cada vez.
- Testes: `test/flow.test.ts` (Telegram e PushinPay simulados, fluxo inteiro), `test/panel.test.ts` (API do painel) e `test/retention.test.ts` (fila, envio, renovação pelo botão, corte simulado/real, volte com desconto).

## Ainda falta (próximas etapas)
Ordem combinada: 1) ✅ lembretes + corte (simulação) + página Retenção; 2) ✅ importação do AutomatizzeBot (falta: leads/usuários que nunca compraram); 3) Clientes + Dashboard; 4) recuperação de Pix + oferta pós-venda.
- Painel: Clientes, Dashboard completo (gráficos, ranking), upload de mídia, super admin.
- Recuperação de Pix, oferta pós-venda, importação de leads (quem nunca comprou).

## Confirmado em produção
- 15/11: compra real com PushinPay (R$ 1,00, bot de teste @cervoadmbot, canal privado "Cervo – Atualizações"): Pix gerado e pagamento reconhecido NA HORA pelo aviso da PushinPay (token no caminho do endereço).
- Pedido de entrada aprovado sozinho para quem pagou; remoção (ban + unban) funciona em canal só com "Adicionar inscritos".
- Em canal o app não mostra "banir usuários": só "Adicionar inscritos" é exigido.

## A validar
- Split da PushinPay (campo de divisão no cashIn): conferir na documentação antes de ligar a taxa.
