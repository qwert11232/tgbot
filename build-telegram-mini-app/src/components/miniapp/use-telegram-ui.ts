"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useTelegram } from "./telegram-provider";

/**
 * Нативная кнопка «назад» в шапке Telegram вместо самодельной.
 *
 * В Mini App браузерная кнопка «назад» недоступна, поэтому подстраницы
 * (товар, корзина, оформление, заказы) без этого хука оставались без выхода —
 * пользователь мог уйти только закрытием мини-приложения.
 */
export function useTelegramBack(fallbackHref = "/app", enabled = true): void {
  const { tg } = useTelegram();
  const router = useRouter();

  useEffect(() => {
    const back = tg?.BackButton;
    if (!back?.show) return;

    const onClick = () => {
      // Если история пустая (переход по прямой ссылке) — уводим на каталог.
      if (typeof window !== "undefined" && window.history.length > 1) router.back();
      else router.push(fallbackHref);
    };

    if (enabled) back.show?.();
    else back.hide?.();
    back.onClick?.(onClick);

    return () => {
      back.offClick?.(onClick);
      back.hide?.();
    };
  }, [tg, router, fallbackHref, enabled]);
}

export type HapticKind = "light" | "medium" | "success" | "error" | "select";

/**
 * Тактильный отклик. Вне Telegram (обычный браузер) молча ничего не делает,
 * поэтому вызывать можно без проверок.
 */
export function haptic(kind: HapticKind = "light"): void {
  if (typeof window === "undefined") return;
  const hf = window.Telegram?.WebApp?.HapticFeedback;
  if (!hf) return;
  try {
    if (kind === "success" || kind === "error") hf.notificationOccurred?.(kind);
    else if (kind === "select") hf.selectionChanged?.();
    else hf.impactOccurred?.(kind);
  } catch {
    /* старые клиенты без HapticFeedback */
  }
}
