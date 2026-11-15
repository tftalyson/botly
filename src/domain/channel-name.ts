/** Nome do canal para o cliente: o nome de exibição, se houver; senão o título no Telegram. */
export const chName = (ch: { title: string; displayName?: string | null }) => ch.displayName?.trim() || ch.title;
