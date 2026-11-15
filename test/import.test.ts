// Importação no formato da exportação do AutomatizzeBot.
import ExcelJS from "exceljs";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb } from "../src/db/client.js";
import { runMigrations } from "../src/db/migrate.js";
import * as s from "../src/db/schema.js";
import type { Ctx } from "../src/domain/context.js";
import { analyze, parseDate, parseUser, readSheet } from "../src/domain/importer.js";
import { encryptJson } from "../src/lib/crypto.js";
import { silentLog } from "../src/lib/log.js";
import { buildPanel } from "../src/panel/server.js";
import { hashPassword } from "../src/panel/auth.js";

const URL = process.env.DATABASE_URL ?? "postgres://postgres:dev@127.0.0.1:5432/botly_test";
const { db, sql: pg } = createDb(URL);
const now = new Date("2026-11-15T15:00:00Z");
const ctx: Ctx = { db, appSecret: "i".repeat(40), publicUrl: "https://api.t", fetch, now: () => now, log: silentLog };

async function sheet(): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Assinantes");
  ws.addRow(["Username/User Id", "ID Pagamento", "Valor", "Assinatura", "Compra", "Vencimento"]);
  ws.addRow(["5765807843", "a33ab027", "R$ 10,90", "A6OKDX2T Ativa", "15/11/2026", "22/11/2026"]);
  ws.addRow(["Daviii351 5031061482", "a3324ff1", "R$ 10,90", "BU16FG8F Ativa", "10/11/2026", "17/11/2026"]);
  // Mesmo cliente renovando: fica o maior vencimento e o valor da compra mais recente.
  ws.addRow(["2001274540", "a327e1f2", "R$ 10,90", "DCOC4VW7 Expirada", "05/11/2026", "12/11/2026"]);
  ws.addRow(["2001274540", "a339802c", "R$ 24,90", "YMBFEQ1F Ativa", "14/11/2026", "14/12/2026"]);
  ws.addRow(["ReiMarcoIII 701966326", "a3272b49", "R$ 79,90", "NQHDQ56B Ativa", "05/11/2026", "02/11/2036"]);
  ws.addRow(["7413220461", "a32bfabd", "R$ 10,90", "DE8QCV2X Expirada", "07/11/2026", "14/11/2026"]);
  ws.addRow(["semid", "x", "R$ 10,90", "Z Ativa", "07/11/2026", "14/12/2026"]);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

beforeAll(async () => {
  await runMigrations(URL);
  await db.execute(sql`truncate accounts, super_admins cascade`);
});
afterAll(async () => {
  await pg.end();
});

describe("leitura", () => {
  it("usuário, datas e valores", () => {
    expect(parseUser("Daviii351 5031061482")).toEqual({ telegramId: 5031061482, username: "Daviii351" });
    expect(parseUser("7979202508")).toEqual({ telegramId: 7979202508, username: null });
    // Sem hora = fim do dia em São Paulo (23:59 = 02:59Z do dia seguinte).
    expect(parseDate("22/11/2026")!.toISOString()).toBe("2026-11-23T02:59:00.000Z");
  });

  it("planilha do AutomatizzeBot: agrupa renovações e separa ativos de vencidos", async () => {
    const { rows, columns } = await readSheet(await sheet(), "assinantes.xlsx");
    expect(columns.user).toBe("Username/User Id");
    expect(columns.expires).toBe("Vencimento");
    expect(columns.payment).toBe("ID Pagamento");
    const a = analyze(rows, now);
    expect(a.customers.length).toBe(5);
    expect(a.invalid.length).toBe(1);
    expect(a.active).toBe(4);
    expect(a.expired).toBe(1);
    const renewed = a.customers.find((c) => c.telegramId === 2001274540)!;
    expect(renewed.purchases).toBe(2);
    expect(renewed.amountCents).toBe(2490);
    expect(renewed.durationDays).toBe(30);
    expect(a.groups.find((g) => g.amountCents === 7990)!.durationDays).toBe(3650);
  });
});

describe("importação pelo painel", () => {
  it("prévia sugere os planos e a confirmação grava clientes e acessos", async () => {
    const [acc] = await db.insert(s.accounts).values({ name: "I", slug: "i", settings: {} }).returning();
    await db.insert(s.users).values({ accountId: acc!.id, email: "i@x.com", name: "I", passwordHash: await hashPassword("senha1234") });
    const [ch] = await db.insert(s.channels).values({ accountId: acc!.id, telegramChatId: -100, title: "VIP", type: "channel", rightsOk: true }).returning();
    const [bot] = await db
      .insert(s.bots)
      .values({ accountId: acc!.id, telegramBotId: 9, username: "b", name: "B", tokenEnc: encryptJson({ token: "9:x" }, ctx.appSecret), webhookSecret: "w", mainChannelId: ch!.id })
      .returning();
    const [semanal] = await db.insert(s.plans).values({ accountId: acc!.id, botId: bot!.id, name: "Semanal", durationUnit: "day", durationValue: 7, priceCents: 1090 }).returning();
    const [mensal] = await db.insert(s.plans).values({ accountId: acc!.id, botId: bot!.id, name: "Mensal", durationUnit: "month", durationValue: 1, priceCents: 2490 }).returning();
    const app = buildPanel(ctx, { webDir: "/x" });
    const login = await app.inject({ method: "POST", url: "/api/login", payload: { email: "i@x.com", password: "senha1234" }, headers: { "x-botly": "1" } });
    const cookie = String(login.headers["set-cookie"]).split(";")[0]!;
    const body = { botId: bot!.id, channelId: ch!.id, fileName: "assinantes.xlsx", data: (await sheet()).toString("base64") };
    const prev = (await app.inject({ method: "POST", url: "/api/import/preview", payload: body, headers: { cookie, "x-botly": "1" } })).json();
    expect(prev.customers).toBe(5);
    expect(prev.active).toBe(4);
    expect(prev.suggested["1090|7"]).toBe(semanal!.id);
    expect(prev.suggested["2490|30"]).toBe(mensal!.id);
    const conf = await app.inject({ method: "POST", url: "/api/import/confirm", payload: { ...body, planMap: prev.suggested }, headers: { cookie, "x-botly": "1" } });
    expect(conf.json().stats.novos).toBe(5);
    const accs = await db.select().from(s.accesses).where(eq(s.accesses.channelId, ch!.id));
    expect(accs.filter((a) => a.status === "active").length).toBe(4);
    expect(accs.filter((a) => a.status === "removed").length).toBe(1);
    const renewedCust = (await db.select().from(s.customers).where(eq(s.customers.telegramUserId, 2001274540)))[0]!;
    const renewedAcc = accs.find((a) => a.customerId === renewedCust.id)!;
    expect(renewedAcc.planId).toBe(mensal!.id);
    expect(renewedCust.totalSpentCents).toBe(3580);
    // Lembretes já planejados para os importados (ex.: vence 17/11 → D-1 amanhã).
    const ob = await db.select().from(s.outbox);
    expect(ob.length).toBeGreaterThan(0);
    // Só ativos: em outro canal, o vencido fica de fora.
    const [ch2] = await db.insert(s.channels).values({ accountId: acc!.id, telegramChatId: -200, title: "VIP 2", type: "channel", rightsOk: true }).returning();
    const only = (await app.inject({ method: "POST", url: "/api/import/confirm", payload: { ...body, channelId: ch2!.id, planMap: prev.suggested, onlyActive: true }, headers: { cookie, "x-botly": "1" } })).json();
    expect(only.stats.clientes).toBe(4);
    expect(only.stats.vencidos).toBe(0);
    // Importar de novo não duplica nem encurta.
    const again = (await app.inject({ method: "POST", url: "/api/import/confirm", payload: { ...body, planMap: prev.suggested }, headers: { cookie, "x-botly": "1" } })).json();
    expect(again.stats.novos).toBe(0);
    expect(again.stats.mantidos).toBe(5);
    await app.close();
  });
});
