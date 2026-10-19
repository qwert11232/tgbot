const priceFormatter = new Intl.NumberFormat("ru-RU", {
  style: "currency",
  currency: "RUB",
  minimumFractionDigits: 0,
  maximumFractionDigits: 2,
});

export function formatPrice(minor: number): string {
  return priceFormatter.format(minor / 100);
}

export function formatDate(date: Date | string | null | undefined): string {
  if (!date) return "—";
  const d = typeof date === "string" ? new Date(date) : date;
  return new Intl.DateTimeFormat("ru-RU", { dateStyle: "medium", timeStyle: "short" }).format(d);
}

const STATUS_LABELS: Record<string, string> = {
  pending_payment: "Ожидает оплаты",
  paid: "Оплачен",
  processing: "В сборке",
  shipped: "Отправлен",
  delivered: "Доставлен",
  cancelled: "Отменён",
};

export function statusLabel(status: string): string {
  return STATUS_LABELS[status] ?? status;
}
