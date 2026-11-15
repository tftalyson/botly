/** "R$ 24,90" a partir de centavos. */
export function brl(cents: number): string {
  return "R$ " + (cents / 100).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** Aplica desconto em % e arredonda para o centavo. */
export function discounted(cents: number, pct: number): number {
  return Math.round((cents * (100 - pct)) / 100);
}

/** Taxa da plataforma (pontos-base: 250 = 2,5%). */
export function platformFee(cents: number, bps: number): number {
  return Math.round((cents * bps) / 10_000);
}
