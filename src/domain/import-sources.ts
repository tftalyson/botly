// Sistemas de onde dá para importar assinantes. Cada sistema tem as suas instruções
// (como exportar) e o seu leitor de arquivo. Para acrescentar outro: crie a entrada
// abaixo com o passo a passo e a função `parse` que devolve as linhas do arquivo dele.
import { readSheet, type ParsedRow } from "./importer.js";

export interface SourceRead {
  rows: ParsedRow[];
  columns: Record<string, string>;
}

export interface ImportSource {
  id: string;
  name: string;
  /** Frase curta no cartão de escolha. */
  tagline: string;
  /** Passo a passo de como exportar neste sistema. */
  steps: string[];
  /** Avisos específicos deste sistema. */
  warnings: string[];
  /** Tipos de arquivo aceitos (atributo accept do campo de arquivo). */
  accept: string;
  /** Texto do campo de arquivo. */
  fileHint: string;
  parse(file: Buffer, fileName: string, tz: string): Promise<SourceRead>;
}

const FILE_ERR = "Não consegui ler o arquivo. Envie a planilha .xlsx exportada (ou um .csv).";

export const IMPORT_SOURCES: ImportSource[] = [
  {
    id: "automatizzebot",
    name: "AutomatizzeBot",
    tagline: "Planilha assinantes.xlsx exportada do painel do AutomatizzeBot.",
    steps: [
      "No AutomatizzeBot, abra Assinantes do bot e filtre por Aprovado.",
      "Clique no ícone de planilha ao lado de BUSCAR: ele baixa o assinantes.xlsx.",
      "Escolha abaixo o bot do Botly que vai cobrar esses clientes e o canal deles.",
      "Suba o arquivo, confira a prévia e confirme.",
    ],
    warnings: [
      "Importe no dia da virada, com o bot do Botly usando o mesmo token do bot antigo. Assim o bot consegue mandar mensagem para todos eles.",
      "O mesmo cliente aparece uma vez por compra na planilha: o Botly fica com o maior vencimento de cada um.",
    ],
    accept: ".xlsx,.csv",
    fileHint: "assinantes.xlsx",
    parse: (file, fileName, tz) => readSheet(file, fileName, tz),
  },
  {
    id: "planilha",
    name: "Outra planilha",
    tagline: "Qualquer planilha (.xlsx ou .csv) com o ID do Telegram e o vencimento de cada cliente.",
    steps: [
      "Prepare a planilha com uma linha por cliente (ou por compra).",
      "Precisa ter: o ID do Telegram (número) e o vencimento. Se tiver valor, data da compra e situação, melhor.",
      "Escolha abaixo o bot do Botly que vai cobrar esses clientes e o canal deles.",
      "Suba o arquivo, confira a prévia e confirme.",
    ],
    warnings: ["Sem o ID do Telegram não dá para cobrar nem remover a pessoa: linhas sem ID são ignoradas e aparecem na prévia."],
    accept: ".xlsx,.csv",
    fileHint: "planilha .xlsx ou .csv",
    parse: (file, fileName, tz) => readSheet(file, fileName, tz),
  },
];

export const DEFAULT_SOURCE = "automatizzebot";
export const sourceById = (id: string | undefined) => IMPORT_SOURCES.find((x) => x.id === (id ?? DEFAULT_SOURCE));
export { FILE_ERR };
