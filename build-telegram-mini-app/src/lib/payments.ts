import type { Order, OrderItem } from "@/db/schema";
import { createInvoiceLink } from "@/lib/telegram-bot";
import { botToken } from "@/lib/telegram-auth";

/**
 * ЗАФИКСИРОВАННАЯ РЕАЛИЗАЦИЯ ОПЛАТЫ: Telegram Payments через Bot API.
 *
 * Режим выбирается переменной PAYMENT_MODE:
 *  - "stars" (по умолчанию) — Telegram Stars, валюта XTR, provider_token НЕ нужен.
 *    Цены магазина хранятся в копейках RUB; конвертация в Stars — по курсу
 *    XTR_PRICE_MINOR (копеек за 1 Star, по умолчанию 130 ≈ 1,30 ₽).
 *  - "fiat" — классический Telegram Payments через внешний платёжный провайдер
 *    (PAYMENT_PROVIDER_TOKEN из настроек бота, валюта PAYMENT_CURRENCY=RUB).
 *
 * Подтверждение оплаты приходит только через вебхук бота
 * (/api/webhooks/telegram): pre_checkout_query → answerPreCheckoutQuery,
 * successful_payment → идемпотентная смена статуса заказа.
 * Редиректа на внешний эквайринг в Mini App нет; опциональный webhook для
 * внешнего эквайринга — /api/webhooks/payment (HMAC-подпись, идемпотентность).
 */

export type PaymentMode = "stars" | "fiat";

/**
 * Режим оплаты. Некорректное значение (опечатка в env) раньше молча
 * превращалось в stars — теперь пишем предупреждение в лог, чтобы ошибка
 * конфигурации была видна в логах деплоя.
 */
export function paymentMode(): PaymentMode {
  const raw = (process.env.PAYMENT_MODE ?? "").trim().toLowerCase();
  if (!raw) return "stars";
  if (raw === "fiat") return "fiat";
  if (raw === "stars") return "stars";
  console.warn(`[payments] PAYMENT_MODE="${process.env.PAYMENT_MODE}" неизвестен, используется stars`);
  return "stars";
}

export function paymentsEnabled(): boolean {
  const token = botToken();
  if (!token) return false;
  if (paymentMode() === "fiat" && !process.env.PAYMENT_PROVIDER_TOKEN) return false;
  return true;
}

/** Курс Stars: копеек за 1 Star. Некорректное env-значение → дефолт 130. */
export function minorPerStar(): number {
  const raw = Number(process.env.XTR_PRICE_MINOR ?? 130);
  if (!Number.isFinite(raw) || raw <= 0) {
    if (process.env.XTR_PRICE_MINOR) {
      console.warn(`[payments] XTR_PRICE_MINOR="${process.env.XTR_PRICE_MINOR}" некорректен, используется 130`);
    }
    return 130;
  }
  return raw;
}

/** Сколько Stars стоит заказ (по курсу из env). Всегда конечное число ≥ 1. */
export function starsAmountForMinor(totalMinor: number): number {
  const amount = Math.ceil(totalMinor / minorPerStar());
  return Number.isFinite(amount) && amount >= 1 ? amount : 1;
}

/** Инвойс в виде ссылки createInvoiceLink — Mini App открывает его через Telegram.WebApp.openInvoice(). */
export async function createOrderInvoiceLink(
  order: Order,
  items: Pick<OrderItem, "productName" | "qty" | "priceMinor">[],
): Promise<string | null> {
  if (!paymentsEnabled()) return null;
  const title = `Заказ #${order.orderNumber}`;
  const description =
    items
      .map((i) => `${i.productName} ×${i.qty}`)
      .join(", ")
      .slice(0, 250) || title;
  const payload = `order_${order.id}`;

  if (paymentMode() === "stars") {
    return createInvoiceLink({
      title,
      description,
      payload,
      currency: "XTR",
      prices: [{ label: title, amount: starsAmountForMinor(order.totalMinor) }],
    });
  }

  return createInvoiceLink({
    title,
    description,
    payload,
    currency: process.env.PAYMENT_CURRENCY ?? "RUB",
    providerToken: process.env.PAYMENT_PROVIDER_TOKEN!,
    prices: items.map((i) => ({
      label: `${i.productName} ×${i.qty}`.slice(0, 64),
      amount: i.priceMinor * i.qty,
    })),
  });
}

/** Ожидаемые суммы для сверки в pre_checkout_query. */
export function expectedInvoiceAmount(order: Order): { currency: string; amount: number } {
  if (paymentMode() === "stars") {
    return { currency: "XTR", amount: starsAmountForMinor(order.totalMinor) };
  }
  return { currency: process.env.PAYMENT_CURRENCY ?? "RUB", amount: order.totalMinor };
}
