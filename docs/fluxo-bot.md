# Fluxo de conversa do bot (proposta v1)

Exemplo com os planos do @TopHotwifes_bot. Todos os textos, mídias, preços e
ofertas são editáveis no painel. `[Botão]` = botão clicável.

Regra geral: o bot **edita a mesma mensagem** sempre que dá (trocar de plano,
voltar), para a conversa não virar uma pilha de mensagens.

---

## 1. Entrada — /start

Se a conta exige maioridade e a pessoa ainda não confirmou:

> 🔞 Este bot tem conteúdo adulto. Para continuar, confirme que você tem 18 anos ou mais.
>
> `[✅ Tenho 18 anos ou mais]`  `[Sair]`

Depois de confirmar (só uma vez por pessoa), vem a **boas-vindas** (imagem ou vídeo + texto):

> *(vídeo de demonstração)*
> 🔥 Bem-vindo ao VIP Hotwifes!
> Conteúdo novo todo dia, direto no seu Telegram.
>
> `[💎 Ver planos]`
> `[👀 Ver prévias grátis]` ← só aparece se o canal de prévias estiver cadastrado (abre o link)

Se a pessoa **já é assinante ativa** deste canal, a boas-vindas muda:

> ✅ Seu acesso está ativo até **22/11/2026**.
>
> `[🔄 Renovar agora]`  `[🔗 Link do canal]`  `[➕ Outros canais]`

Origem do tráfego: links `t.me/bot?start=insta` gravam "insta" como origem do cliente.

---

## 2. Planos

> 💎 **Escolha seu plano:**
>
> `[Semanal (7 dias) — R$ 10,90]`
> `[Mensal (30 dias) — R$ 24,90]`
> `[⭐ Semestral (6 meses) — R$ 57,00]` ← plano em destaque
> `[👑 Vitalício — R$ 79,90]`
> `[🔥 Pacotes promocionais]` ← só se houver pacotes ativos

### 2a. Pacotes (se clicar)

> 🔥 **Pacotes** — vários canais por um preço só:
>
> `[Combo Hot (3 canais, 30 dias) — R$ 39,90]`
> `[Combo Total (5 canais, 30 dias) — R$ 59,90]`
> `[⬅️ Voltar]`

---

## 3. Order bump (upsell 1 — antes do Pix)

Só se o bot tiver extras ligados e a pessoa ainda não tiver aquele canal nem
tiver recusado nos últimos 30 dias:

> Você escolheu **Mensal — R$ 24,90**.
>
> ➕ Quer adicionar o canal **VIP Trans** por só **+R$ 9,90**?
> (vence junto com o seu plano)
>
> `[✅ Sim, adicionar (total R$ 34,80)]`
> `[Não, só o plano]`

---

## 4. Pagamento

> 🧾 **Resumo:** Mensal + VIP Trans
> 💰 **Total: R$ 34,80**
>
> *(imagem do QR Code)*
> Copie o código Pix abaixo e pague no app do seu banco:
>
> `00020101021226...` ← mensagem separada só com o código, fácil de copiar
>
> ⏳ O Pix vale por 30 minutos. A liberação é automática.
>
> `[✅ Já paguei]`  `[🔁 Gerar outro Pix]`

- **[Já paguei]** consulta o gateway na hora. Se ainda não caiu: "Ainda não recebemos, assim que cair eu te aviso aqui 😉".
- **[Gerar outro Pix]** cria um novo Pix em **outro gateway** (se houver), útil quando o banco do cliente recusa.

---

## 5. Pagamento aprovado

> ✅ **Pagamento confirmado!**
>
> Seu acesso vai até **15/12/2026**.
> Toque no botão abaixo e peça para entrar — eu aprovo na hora.
>
> `[🔓 Entrar no VIP Hotwifes]`
> `[🔓 Entrar no VIP Trans]` ← um botão por canal comprado

Quando a pessoa pede para entrar, o bot gestor confere a assinatura e aprova.
Quem pede sem ter pago é recusado e recebe:

> Para entrar no **VIP Hotwifes** você precisa de um plano ativo. `[💎 Ver planos]`

### 5a. Oferta pós-venda (upsell 2)

Só para quem **recusou** o order bump. Sai 1 minuto depois da aprovação:

> 🎁 **Oferta só para agora:** canal **VIP Trans** com **40% off** — R$ 5,94
> Válida por 15 minutos.
>
> `[Quero aproveitar]`  `[Não, obrigado]`

---

## 6. Recuperação de Pix não pago

Pix gerado e não pago. Para assim que a pessoa paga.

| Quando | Mensagem |
|---|---|
| 15 min | "Seu Pix de R$ 24,90 ainda está esperando 😉 Quer que eu gere outro?" `[Gerar Pix]` |
| 2 h | "Liberei **10% off** para você fechar agora: R$ 22,41" `[Pagar com desconto]` |
| 24 h | "Que tal começar menor? **Semanal por R$ 10,90**" `[Quero o semanal]` `[🔥 Ver pacotes]` |

Depois disso, a pessoa vira lead para campanhas futuras.

---

## 7. Lembretes de vencimento (página Retenção)

Saem pelo **bot da última compra**, no horário configurado (padrão 10h):

**D-3 e D-1:**
> ⏰ Seu acesso ao **VIP Hotwifes** vence em **3 dias** (22/11).
> Renove agora e não perca nada:
>
> `[🔄 Renovar 30 dias — R$ 24,90]`
> `[⭐ Renovar + VIP Trans — R$ 34,80]` ← upsell 3, se ligado
> `[💰 6 meses — R$ 57,00 (economize 62%)]` ← plano longo, se ligado

**No dia (D0):** mesmo texto, com "vence **hoje**".

Renovar **soma** os dias ao vencimento atual (quem renova antes não perde dias).

---

## 8. Vencimento e corte

- Venceu e não renovou → após a tolerância configurada, o bot remove do canal.
- **Modo simulação** (padrão no início): não remove, só mostra na Retenção quem sairia.

> 😢 Seu acesso ao **VIP Hotwifes** terminou.
> Quer voltar? `[🔄 Voltar — R$ 24,90]`

**Volte com desconto:** D+1 sem desconto, D+7 com 15% off (editável na página Lembretes).

---

## 9. Comandos

- `/start` — boas-vindas ou status da assinatura
- `/planos` — lista de planos
- `/meuplano` — vencimento e links de entrada de cada canal
- `/suporte` — link de suporte (configurável)
