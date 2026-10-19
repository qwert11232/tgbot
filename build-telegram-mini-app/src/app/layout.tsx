import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "ГОРН — керамика ручной работы",
  description: "Интернет-магазин керамики внутри Telegram. Каталог, корзина и оплата — в мини-приложении.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ru">
      <body className="bg-paper text-ink font-sans antialiased">{children}</body>
    </html>
  );
}
