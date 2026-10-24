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
