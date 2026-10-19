"use client";

import { useActionState } from "react";
import { Flame, LogIn } from "lucide-react";
import { loginAction, type LoginState } from "@/lib/admin/auth-actions";

export default function AdminLoginPage() {
  const [state, formAction, pending] = useActionState<LoginState, FormData>(loginAction, {});

  return (
    <main className="flex min-h-dvh items-center justify-center bg-ink px-4">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <p className="font-display text-4xl text-paper">ГОРН</p>
          <p className="mt-2 inline-flex items-center gap-1.5 text-xs uppercase tracking-widest text-paper/50">
            <Flame size={12} className="text-clay" /> панель управления
          </p>
        </div>
        <form action={formAction} className="card-shadow rounded-3xl bg-paper p-7">
          <label className="block">
            <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-mute">Email</span>
            <input
              name="email"
              type="email"
              required
              autoComplete="username"
              placeholder="admin@shop.ru"
              className="w-full rounded-xl border border-line bg-white px-4 py-3 text-sm outline-none focus:border-clay"
            />
          </label>
          <label className="mt-4 block">
            <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-mute">Пароль</span>
            <input
              name="password"
              type="password"
              required
              autoComplete="current-password"
              placeholder="••••••••••"
              className="w-full rounded-xl border border-line bg-white px-4 py-3 text-sm outline-none focus:border-clay"
            />
          </label>
          {state?.error && (
            <p className="mt-4 rounded-xl bg-clay/10 px-3.5 py-2.5 text-xs font-medium text-clay-deep">
              {state.error}
            </p>
          )}
          <button
            type="submit"
            disabled={pending}
            className="mt-6 flex w-full items-center justify-center gap-2 rounded-full bg-clay py-3 text-sm font-semibold text-white transition hover:bg-clay-deep disabled:opacity-50"
          >
            <LogIn size={16} /> {pending ? "Проверяем…" : "Войти"}
          </button>
        </form>
        <p className="mt-6 text-center text-[11px] text-paper/40">
          Доступ только для сотрудников. Попытки входа ограничены (8 / 10 мин на IP).
        </p>
      </div>
    </main>
  );
}
