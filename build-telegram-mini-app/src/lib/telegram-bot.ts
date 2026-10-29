import { botToken } from "@/lib/telegram-auth";

/**
 * База Bot API. Переопределяется через TELEGRAM_API_BASE — это нужно для
 * тестов (локальный mock вместо api.telegram.org) и для прокси в закрытых
 * сетях. В production переменную задавать не нужно.
 */
function apiBase(): string {
  return (process.env.TELEGRAM_API_BASE ?? "https://api.telegram.org").replace(/\/+$/, "");
}

/** Таймаут запроса к Bot API: зависший вызов не должен держать вебхук. */
const BOT_TIMEOUT_MS = 8000;

interface TgApiResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
}

/**
 * Минимальный клиент Bot API на fetch. Токен берётся из process.env.BOT_TOKEN
 * лениво (внутри вызова), чтобы сборка не требовала env. При отсутствии токена
 * вызовы молча возвращают null — магазин работает, уведомления/инвойсы отключены.
 */
export async function botCall<T = unknown>(method: string, body: Record<string, unknown>): Promise<T | null> {
  const token = botToken();
  if (!token) return null;
  try {
    const res = await fetch(`${apiBase()}/bot${token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(BOT_TIMEOUT_MS),
    });
    const data = (await res.json().catch(() => null)) as TgApiResponse<T> | null;
    if (!data?.ok) {
      console.error(`[bot] ${method} failed:`, data?.description ?? res.status);
      return null;
    }
    return data.result ?? null;
  } catch (err) {
    console.error(`[bot] ${method} network error:`, err);
    return null;
  }
}

export function sendMessage(
  chatId: number | string,
  text: string,
  extra?: Record<string, unknown>,
): Promise<unknown> {
  return botCall("sendMessage", { chat_id: chatId, text, parse_mode: "HTML", ...extra });
}

export function answerPreCheckoutQuery(
  queryId: string,
  ok: boolean,
  errorMessage?: string,
): Promise<unknown> {
  return ok
    ? botCall("answerPreCheckoutQuery", { pre_checkout_query_id: queryId, ok: true })
    : botCall("answerPreCheckoutQuery", {
        pre_checkout_query_id: queryId,
        ok: false,
        error_message: errorMessage ?? "Платёж отклонён",
      });
}

export interface InvoicePrice {
  label: string;
  amount: number;
}

export function createInvoiceLink(params: {
  title: string;
  description: string;
  payload: string;
  currency: string;
  prices: InvoicePrice[];
  providerToken?: string;
}): Promise<string | null> {
  return botCall<string>("createInvoiceLink", {
    title: params.title.slice(0, 32),
    description: params.description.slice(0, 255),
    payload: params.payload.slice(0, 128),
    currency: params.currency,
    prices: params.prices,
    ...(params.providerToken ? { provider_token: params.providerToken } : {}),
  });
}

/** Кнопка «Открыть магазин» для /start. */
export function webAppKeyboard(url: string) {
  return {
    inline_keyboard: [[{ text: "Открыть магазин", web_app: { url } }]],
  };
}
