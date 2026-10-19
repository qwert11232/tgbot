import Link from "next/link";
import { Flame, ShoppingBag, Lock } from "lucide-react";

export default function Landing() {
  const botUsername = process.env.NEXT_PUBLIC_BOT_USERNAME ?? "";
  const tgLink = botUsername ? `https://t.me/${botUsername}?startapp` : "/app";

  return (
    <main className="min-h-dvh bg-ink text-paper">
      <div
        className="pointer-events-none absolute inset-0 opacity-60"
        style={{
          background:
            "radial-gradient(60rem 40rem at 80% -10%, rgba(192,104,64,0.28), transparent 60%), radial-gradient(40rem 30rem at -10% 90%, rgba(125,143,118,0.16), transparent 55%)",
        }}
      />
      <div className="relative mx-auto flex min-h-dvh w-full max-w-4xl flex-col px-6 py-10">
        <header className="flex items-center justify-between text-sm text-paper/60">
          <span className="inline-flex items-center gap-2">
            <Flame size={16} className="text-clay" /> гончарная мастерская
          </span>
          <Link href="/admin/login" className="inline-flex items-center gap-1.5 transition hover:text-paper">
            <Lock size={14} /> для сотрудников
          </Link>
        </header>

        <div className="flex flex-1 flex-col items-start justify-center py-16">
          <h1 className="font-display text-[22vw] leading-none tracking-tight text-paper sm:text-8xl">
            ГОРН
          </h1>
          <p className="mt-6 max-w-xl text-lg leading-relaxed text-paper/70">
            Керамика ручной работы: кружки, вазы, посуда. Магазин живёт внутри
            Telegram — каталог, корзина и оплата Stars или картой, не выходя из
            мессенджера.
          </p>
          <div className="mt-10 flex flex-wrap items-center gap-4">
            <a
              href={tgLink}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-2 rounded-full bg-clay px-7 py-3.5 text-sm font-semibold text-white transition hover:bg-clay-deep"
            >
              <ShoppingBag size={16} /> Открыть магазин в Telegram
            </a>
            <Link
              href="/admin/login"
              className="rounded-full border border-paper/25 px-7 py-3.5 text-sm font-semibold text-paper/80 transition hover:border-paper/60 hover:text-paper"
            >
              Панель управления
            </Link>
          </div>
        </div>

        <footer className="text-xs text-paper/40">
          Telegram Mini App · оплата через Telegram Payments · уведомления о
          заказе — ботом
        </footer>
      </div>
    </main>
  );
}
