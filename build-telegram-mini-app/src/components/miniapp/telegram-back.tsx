"use client";

import { useTelegramBack } from "./use-telegram-ui";

/**
 * Включает нативную кнопку «назад» в шапке Telegram на серверных страницах
 * (например, карточке товара), где нельзя вызвать хук напрямую.
 */
export function TelegramBack({ href = "/app" }: { href?: string }) {
  useTelegramBack(href);
  return null;
}
