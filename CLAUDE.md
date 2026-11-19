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
- Lista de planos/pacotes: `trackCatalog` (handlers.ts) guarda em `customer_bots.catalog_msg_id` a última mensagem de planos ou pacotes enviada ao cliente e APAGA a anterior (planos e preços podem mudar; apagar falha em silêncio se já sumiu ou passou de 48 h). Trocar entre planos e pacotes edita a mesma mensagem. Teste: `test/catalog.test.ts`.
- `src/domain/sales.ts`: pedido, Pix com reserva de gateway, `markChargePaid` (não duplica; extra vence junto com o plano; renovação soma).
- `src/api/server.ts`: `/tg/:botId` (confere o segredo do Telegram) e `/pay/:provider/:gatewayId?token=` (sempre confere na API do gateway).
- `src/jobs/ticks.ts`: conferência de Pix pendentes a cada minuto (PushinPay a cada 5 min por cobrança), por 24 h.
- `src/cli/setup.ts`: configuração pelo Console do Easypanel enquanto o painel não existe (conta, gateway, bot, canal, plano, pagamento, boasvindas, previas, avisos, listar).
- Painel (`BOTLY_ROLE=panel`, `src/panel/server.ts` + `panel-web/`): primeiro acesso cria conta + dono (usa a conta do Console se já existir), login por cookie, Início (vendas de hoje, assinantes, passos para começar), Bots (conectar com passo a passo do BotFather; página do bot com abas Geral/Planos/Pagamento/Ofertas e prévia do chat ao vivo), Canais (bot gestor, preço como extra, conferir permissões, adicionar pelo ID), Pacotes, Formas de pagamento (chave criptografada, testar), Configurações (maioridade, canal de avisos).
- Visual do painel: névoa fria #EEF0F6, tinta violeta #1A1633, marca #5B2EFF, verde-água #0E9F86 só para dinheiro; títulos Bricolage Grotesque, texto Figtree. Elemento marcante = prévia do chat na página do bot.
- Retenção (`src/domain/retention.ts`): modelos padrão D-3, D-1, D0 (lembrete) e D+1, D+7 15% (volte); `planOutbox` monta a fila dos próximos 8 dias (chave única acesso+modelo+vencimento) a cada 10 min; `sendDue` manda a cada minuto pelo bot da última compra (pula quem renovou, horário passado há +12 h, quem bloqueou o bot); botões rn:/rnx:/p: (renovar, renovar + extra, plano longo) e wb: (volte com o desconto do modelo); `cutExpired` a cada 5 min: vencido além da tolerância vira expired; com `settings.autoRemove` remove do canal (padrão: simulação). Painel: páginas Retenção (Hoje/Amanhã/7 dias, esperado, renovaram, lista de quem sairia + chave do corte) e Lembretes (horário, tolerância, textos, dias, desconto, mídia); aba Ofertas do bot com “Na renovação”.
- Importação (`src/domain/importer.ts` + página Importar assinantes): lê .xlsx/.csv (colunas reconhecidas pelo nome ou conteúdo; ID = último número de 5+ dígitos da célula; data sem hora = 23:59 no fuso), agrupa por cliente (maior vencimento; valor/duração da compra mais recente), grupos valor+duração → plano do bot (sugestão automática), grava clientes (imported, funil "paid"), vínculo com o bot e acesso (ativo ou removido); nunca encurta vencimento existente; já monta os lembretes.
- Importação por sistema de origem (`src/domain/import-sources.ts`, GET /api/import/sources, `imports.source`): a página começa com "De qual sistema você está vindo?" (cartões); cada sistema tem passo a passo, avisos, tipos de arquivo e `parse` próprios. Hoje: `automatizzebot` e `planilha` (genérica). Para acrescentar outro: nova entrada na lista (e leitor, se o arquivo for diferente); o formato do resto (prévia, planos, confirmação) é comum.
- Mídia por upload (tabela `media`, bytea): POST /api/media (corpo binário; foto JPG/PNG/WEBP até 10 MB, vídeo MP4/MOV e GIF até 50 MB = limites do Telegram); boas-vindas guarda `mediaId` e o bot sobe o arquivo no 1º /start e passa a usar o file_id.
- Deploy: os dois serviços (botly e painel) implantam pelo mesmo push; em 15/11 falharam juntos em 0 s ("### Error" sem detalhe). Se repetir, implantar um de cada vez.
- Dashboard (Início, `src/panel/dashboard.ts`, GET /api/dashboard?range=today|yesterday|7d|week|month|30d|all|custom&from&to): faturamento, vendas (novas/renovações/pacotes), ticket médio, conversão (/start → compra), Pix pago/gerado, renovação (renovou ÷ renovou+perdeu), upsell (bump aceito/oferecido, receita de extras, renovação com extra), pacotes (qtd, receita, % do faturamento); comparação com o período anterior; gráfico diário empilhado (mensal acima de 95 dias) com dica e tabela; funil; projeções (renovações em 30 dias × taxa dos últimos 30 dias; ritmo do mês); ranking de bots e planos; funil com etapa "Entraram no canal" (compra nova paga + accesses.joined_at de um canal da compra a partir do pagamento; evento joined conta para o bot que vendeu); funil clicável → GET /api/dashboard/people?step=started|viewed_plans|chose_plan|pix_generated|paid|joined (mesmos filtros; por pessoa: bot, plano escolhido, último Pix com valor/itens/status, se pagou, até onde chegou; até 500 mais recentes); filtro de bots (`&bots=id1,id2`, vazio = todos; pedidos e eventos pelo bot, acessos pelo bot da última compra; escolha salva no navegador). Cores das séries validadas (skill dataviz): #5B2EFF novas, #0E9F86 renovações, #D98A00 pacotes.
- Nome de exibição do canal (`channels.display_name`, `chName()`): usado em todas as mensagens do bot; título do Telegram fica discreto.
- Atendimento (`src/domain/support.ts`, página Atendimento `/atendimento`): assinante ativo vê no /start o menu "Seus acessos" (entrar nos canais, Renovar / mudar de plano, Outros canais e pacotes = canais que ainda não tem, vendidos por qualquer bot da conta, Suporte); quem não comprou vê "Dúvidas? Fale com a gente". Suporte resolve sozinho "não consigo entrar" (reenvia botões) e "paguei e não liberou" (confere os Pix das últimas 48 h na hora); "Falar com um atendente" abre conversa (`support_tickets`/`support_messages`; open = aguardando, active, closed). Com conversa aberta, tudo o que o cliente manda (texto, foto, arquivo, áudio) vai para o painel; sem conversa, mensagem solta responde "toque em Suporte". Painel: conversas de todos os bots, atualiza a cada 4–5 s, contador no menu; responder assume ("👤 Nome entrou na conversa") e cada mensagem sai como "<b>Nome:</b> texto"; nome do atendente = `users.support_name` (vazio = nome do painel); ações: reenviar links, dar dias ao acesso, encerrar. Horário em `settings.supportStart/End` (padrão 10:00–22:00) + `supportOffMessage` ({inicio} {fim}); fora do horário o cliente recebe o aviso mas a conversa abre igual. Novo pedido avisa o canal de avisos da conta. Fotos vêm do Telegram pelo bot da conversa (GET /api/support/file/:id).
- Valor diferente (`bot/notify.ts` `announceUnderpaid`, ligado em `ctx.onUnderpaid` no `main.ts`): Pix pago com valor MENOR que o do pedido continua sem liberar acesso, mas agora: grava evento `underpaid` (uma vez por cobrança+valor), explica ao cliente pelo bot, abre conversa no Atendimento (assunto "pagamento com valor diferente", com nota do sistema) e avisa o canal de avisos.
- Pagamento em duplicidade (`announceDuplicate`, `ctx.onDuplicatePaid` chamado por `markChargePaid` quando o pedido já estava pago): não mexe no acesso; grava evento `duplicate_paid`, avisa o cliente, abre/reaproveita a conversa no Atendimento com nota do sistema e avisa o canal de avisos (decidir: devolver ou dar dias).
- Rastro do cliente no Atendimento (`support.ts` `customerTrail`, campo `trail` em GET /api/support/:id): etapas do funil (deu /start → entrou no canal), "Parou antes de" e lista dos últimos 80 eventos em português; painel lateral do cliente.
- Blindagem (Fase A): `sendDue` reserva cada lembrete (status `sending`) antes de enviar, então dois processos não duplicam; envio interrompido há +10 min vira falha (não reenvia). Apagar forma de pagamento com Pix em aberto (24 h) é bloqueado (409, sugere desativar); exclusão vai para o registro de auditoria.
- Segurança do painel (Fase A): login/CSRF conferidos em `onRequest` (antes de ler o corpo); corpo > 1 MB só em /api/media e /api/import; CSP, HSTS (produção), Permissions-Policy; login gasta o mesmo tempo com e-mail inexistente (DUMMY_HASH) e tem limite por IP (40) além de IP+e-mail (8); log do webhook de pagamento não guarda o corpo. Corte reconfere o acesso antes de banir; Retenção avisa quando há vencidos em canal sem bot gestor.
- Testes: `test/flow.test.ts` (Telegram e PushinPay simulados, fluxo inteiro), `test/panel.test.ts` (API do painel) e `test/retention.test.ts` (fila, envio, renovação pelo botão, corte simulado/real, volte com desconto).
- Recuperação de Pix (`src/domain/recovery.ts`, `recoveryTick` a cada minuto, DESLIGADA por padrão: aba Ofertas do bot → "Recuperar Pix não pago" + plano mais barato opcional): modelos kind "recovery" (padrão 15 min sem desconto, 2 h 10%, 24 h; editáveis em Lembretes → "Pix gerado e não pago", minutos após o 1º Pix); último passo = plano mais barato do bot (`bots.recovery.downsellPlanId`) se for menor que o pedido. O tempo conta do Pix MAIS RECENTE do pedido (o pedido é reaproveitado quando o cliente volta ao mesmo plano; `createPixForOrder` zera `recovery_step` se não há Pix em aberto, e "gerar outro Pix" com um em aberto não zera). Cada passo é reservado em `orders.recovery_step` (sem duplicar); passo atrasado +3 h é pulado; não manda a quem pagou depois ou bloqueou o bot. Botão `rc:<pedido>:<modelo>` cria pedido kind "recovery" com desconto, cancela o antigo e gera o Pix. Eventos `recovery_sent`/`recovery_clicked` (aparecem no rastro). Teste: `test/recovery.test.ts`.
- Oferta pós-venda (`src/domain/postsale.ts`, `bots.upsell.postSale {enabled, discountPct, validMinutes}`, DESLIGADA por padrão; aba Ofertas → "Oferta depois da compra"): ao confirmar o pagamento de pedido novo/recuperação sem extra, se o cliente recusou o canal extra nas últimas 48 h (evento `bump_declined`), `announcePaid` manda mensagem à parte com o MESMO canal com desconto e prazo; botão `ps:<pedido>` cria pedido kind "upsell" (extra com a duração do plano, desconto e prazo vêm do evento `postsale_offered`, não do botão). Uma oferta por pedido. Eventos `postsale_offered`/`postsale_clicked` no rastro. Teste: `test/postsale.test.ts`.
- Transmissões / mailing (`src/domain/broadcast.ts`, tabelas `broadcasts`/`broadcast_recipients`, página `/transmissoes`, API /api/broadcasts*): público = quem falou com os bots escolhidos e não bloqueou (`customer_bots.can_message`), UMA vez por pessoa (pelo bot do último contato); segmentos all | active | expired (já teve acesso, nenhum ativo) | never (compras 0 e sem acesso) + filtro opcional por canal (tem / não tem acesso ativo) + vence em até N dias (só active); contagem ao vivo (POST /api/broadcasts/audience). Conteúdo: texto HTML com {nome}, mídia opcional (mesmo upload das boas-vindas; file_id guardado em memória por bot), botão: nenhum | planos | link | oferta (plano do bot + desconto + prazo em minutos desde o envio; só com UM bot; callback `bo:<transmissão>` cria pedido com source `bc:<id>`). Agendamento: o público é montado na hora do envio (`startDue`), destinatários gravados e enviados em lotes de 20/s por um relógio próprio (a cada 10 s, rodada de até 25 s, `running` separado dos lembretes); reserva por UPDATE ... SKIP LOCKED; 403 → `can_message=false` (status blocked); erro de rede/429 volta para a fila; cancelar para o envio. Números por transmissão: enviadas, bloquearam, falhas, cliques (evento `broadcast_clicked`), vendas e receita (pedidos pagos com source `bc:<id>`). Eventos `broadcast_sent`/`broadcast_clicked` no rastro. Testes: `test/broadcast.test.ts` + 1 caso em `test/panel.test.ts`.

## Ainda falta (próximas etapas)
Ordem combinada: 1) ✅ lembretes + corte (simulação) + página Retenção; 2) ✅ importação do AutomatizzeBot (falta: leads/usuários que nunca compraram); 3) ✅ Dashboard, falta Clientes; 4) ✅ recuperação de Pix e oferta pós-venda.
- Painel: Clientes, super admin.
- Transmissões, ideias: enviar teste para o meu Telegram antes, repetir/duplicar uma transmissão, filtro por origem (?start=) e por funil, pausar/retomar, botão de descadastrar (/parar).
- Atendimento, ideias: respostas prontas, gerar Pix pelo atendimento, várias pessoas atendendo (usuários da conta).
- Importação de leads (quem nunca comprou).

## Confirmado em produção
- 15/11: compra real com PushinPay (R$ 1,00, bot de teste @cervoadmbot, canal privado "Cervo – Atualizações"): Pix gerado e pagamento reconhecido NA HORA pelo aviso da PushinPay (token no caminho do endereço).
- Pedido de entrada aprovado sozinho para quem pagou; remoção (ban + unban) funciona em canal só com "Adicionar inscritos".
- Em canal o app não mostra "banir usuários": só "Adicionar inscritos" é exigido.

## A validar
- Split da PushinPay (campo de divisão no cashIn): conferir na documentação antes de ligar a taxa.
