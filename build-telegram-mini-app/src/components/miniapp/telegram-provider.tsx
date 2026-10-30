"use client";

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";

export interface TgSessionUser {
  id: string;
  telegramId: number;
  firstName: string | null;
  lastName: string | null;
  username: string | null;
}

interface TgContextValue {
  token: string | null;
  user: TgSessionUser | null;
  ready: boolean;
  isTelegram: boolean;
  authError: string | null;
  apiFetch: (path: string, init?: RequestInit) => Promise<Response>;
  tg: TelegramWebAppLike | undefined;
}

const TgContext = createContext<TgContextValue>({
  token: null,
  user: null,
  ready: false,
  isTelegram: false,
  authError: null,
  apiFetch: (path, init) => fetch(path, init),
  tg: undefined,
});

export const useTelegram = () => useContext(TgContext);

/** Минимальное описание Telegram.WebApp, которое реально используется. */
export interface TelegramWebAppLike {
  initData?: string;
  ready?: () => void;
  expand?: () => void;
  setHeaderColor?: (color: string) => void;
  setBackgroundColor?: (color: string) => void;
  openInvoice?: (url: string, callback?: (status: string) => void) => void;
  /** Безопасные зоны устройства (чёлка, домашний индикатор). */
  safeAreaInset?: { top?: number; bottom?: number; left?: number; right?: number };
  /** Зоны, перекрытые интерфейсом Telegram (шапка, нижняя панель). */
  contentSafeAreaInset?: { top?: number; bottom?: number };
  viewportChanged?: { on?: (cb: () => void) => void; off?: (cb: () => void) => void };
  safeAreaChanged?: { on?: (cb: () => void) => void; off?: (cb: () => void) => void };
  contentSafeAreaChanged?: { on?: (cb: () => void) => void; off?: (cb: () => void) => void };
  BackButton?: {
    show?: () => void;
    hide?: () => void;
    onClick?: (cb: () => void) => void;
    offClick?: (cb: () => void) => void;
  };
  HapticFeedback?: {
    impactOccurred?: (style: "light" | "medium" | "heavy" | "rigid" | "soft") => void;
    notificationOccurred?: (type: "error" | "success" | "warning") => void;
    selectionChanged?: () => void;
  };
}

/**
 * Прокидывает в CSS реальные безопасные зоны: сумма «зоны устройства» и «зоны
 * интерфейса Telegram». Без этого в полноэкранном режиме контент уезжает под
 * чёлку и под нижнюю панель. Искусственный минимум не задаём: в обычном
 * (не полноэкранном) режиме Telegram уже показывает свою шапку, и лишний отступ
 * выглядел бы как дыра.
 */
function applySafeArea(tg: TelegramWebAppLike): void {
  if (typeof document === "undefined") return;
  const top = (tg.safeAreaInset?.top ?? 0) + (tg.contentSafeAreaInset?.top ?? 0);
  const bottom = (tg.safeAreaInset?.bottom ?? 0) + (tg.contentSafeAreaInset?.bottom ?? 0);
  document.documentElement.style.setProperty("--safe-top", `${Math.max(0, Math.round(top))}px`);
  document.documentElement.style.setProperty("--safe-bottom", `${Math.max(0, Math.round(bottom))}px`);
}

declare global {
  interface Window {
    Telegram?: { WebApp?: TelegramWebAppLike };
  }
}

/**
 * Авторизация Mini App: читает window.Telegram.WebApp.initData, отправляет на
 * серверную верификацию (/api/auth/telegram), хранит выданный JWT и подставляет
 * его в Authorization: Bearer на все покупательские запросы.
 * Каталог доступен и без авторизации — токен нужен для заказа и его статусов.
 */
export function TelegramProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<Omit<TgContextValue, "apiFetch" | "tg">>({
    token: null,
    user: null,
    ready: false,
    isTelegram: false,
    authError: null,
  });

  useEffect(() => {
    let cancelled = false;
    async function init() {
      const tg = window.Telegram?.WebApp;
      const initData: string = tg?.initData ?? "";
      if (tg) {
        try {
          tg.ready?.();
          tg.expand?.();
          tg.setHeaderColor?.("#f6f2eb");
          tg.setBackgroundColor?.("#f6f2eb");
          applySafeArea(tg);
          // Зоны меняются при развороте экрана и переходе в полный экран.
          tg.viewportChanged?.on?.(() => applySafeArea(tg));
          tg.safeAreaChanged?.on?.(() => applySafeArea(tg));
          tg.contentSafeAreaChanged?.on?.(() => applySafeArea(tg));
        } catch {
          /* старая версия клиента */
        }
      }
      const devBypass = process.env.NEXT_PUBLIC_TG_DEV_BYPASS === "1";
      try {
        if (!initData && !devBypass) {
          if (!cancelled) {
            setState({
              token: null,
              user: null,
              ready: true,
              isTelegram: false,
              authError: "Откройте магазин внутри Telegram — заказ и его статусы доступны только там.",
            });
          }
          return;
        }
        const res = await fetch("/api/auth/telegram", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(initData ? { initData } : { dev: "web-dev" }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error ?? "Ошибка авторизации");
        try {
          localStorage.setItem("tg_token", data.token);
        } catch {
          /* приватный режим */
        }
        if (!cancelled) {
          setState({ token: data.token, user: data.user, ready: true, isTelegram: Boolean(initData), authError: null });
        }
      } catch (err) {
        if (!cancelled) {
          setState({
            token: null,
            user: null,
            ready: true,
            isTelegram: Boolean(initData),
            authError: err instanceof Error ? err.message : "Ошибка авторизации",
          });
        }
      }
    }
    void init();
    return () => {
      cancelled = true;
    };
  }, []);

  const apiFetch = useCallback(
    async (path: string, init: RequestInit = {}) => {
      const headers = new Headers(init.headers);
      if (state.token) headers.set("authorization", `Bearer ${state.token}`);
      if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
      return fetch(path, { ...init, headers });
    },
    [state.token],
  );

  return (
    <TgContext.Provider
      value={{
        ...state,
        apiFetch,
        tg: typeof window !== "undefined" ? window.Telegram?.WebApp : undefined,
      }}
    >
      {children}
    </TgContext.Provider>
  );
}
