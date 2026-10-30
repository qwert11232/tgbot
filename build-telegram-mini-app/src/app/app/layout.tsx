import type { Metadata } from "next";
import type { ReactNode } from "react";
import Script from "next/script";
import Link from "next/link";
import { ClipboardList } from "lucide-react";
import { TelegramProvider } from "@/components/miniapp/telegram-provider";

export const metadata: Metadata = {
  title: "ГОРН — магазин",
};

export default function MiniAppLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <Script src="https://telegram.org/js/telegram-web-app.js" strategy="beforeInteractive" />
      <TelegramProvider>
        <div className="mx-auto flex min-h-dvh w-full max-w-md flex-col bg-paper">
          {/* paddingTop с безопасной зоной: в полноэкранном режиме шапка Telegram
              перекрывает верх, без этого логотип уезжал под неё. */}
          <header
            className="sticky z-20 flex items-center justify-between border-b border-line/70 bg-paper/90 px-4 py-3 backdrop-blur"
            style={{ top: "var(--safe-top, 0px)", paddingTop: "calc(0.75rem + var(--safe-top, 0px))" }}
          >
            <Link href="/app" className="font-display text-2xl tracking-tight text-ink">
              ГОРН
            </Link>
            <Link
              href="/app/orders"
              aria-label="Мои заказы"
              className="rounded-full p-2 text-mute transition hover:bg-cream hover:text-ink"
            >
              <ClipboardList size={20} />
            </Link>
          </header>
          {/* Нижний отступ — под домашний индикатор и нижнюю панель Telegram. */}
          <div className="flex-1" style={{ paddingBottom: "var(--safe-bottom, 0px)" }}>
            {children}
          </div>
        </div>
      </TelegramProvider>
    </>
  );
}
