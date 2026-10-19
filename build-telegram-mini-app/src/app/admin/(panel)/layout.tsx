import type { ReactNode } from "react";
import { requireAdmin } from "@/lib/admin-session";
import { logoutAction } from "@/lib/admin/auth-actions";
import { AdminNav } from "@/components/admin/nav";
import { LogOut } from "lucide-react";

export const dynamic = "force-dynamic";

export default async function AdminPanelLayout({ children }: { children: ReactNode }) {
  // Уровень 2 в каркасе (быстрый путь) — КАЖДАЯ страница панели дополнительно
  // повторяет requireAdmin/requireRole у себя (layout не перемонтируется).
  const actor = await requireAdmin();

  return (
    <div className="min-h-dvh bg-paper lg:pl-60">
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-60 flex-col border-r border-line bg-cream/40 lg:flex">
        <div className="font-display px-5 pb-4 pt-6 text-2xl text-ink">
          ГОРН <span className="font-sans text-[10px] font-semibold uppercase tracking-widest text-mute">админ</span>
        </div>
        <AdminNav role={actor.role} />
        <div className="mt-auto border-t border-line p-4">
          <p className="truncate text-sm font-semibold text-ink">{actor.name}</p>
          <p className="truncate text-xs text-mute">
            {actor.email} · {actor.role === "owner" ? "владелец" : "менеджер"}
          </p>
          <form action={logoutAction}>
            <button className="mt-2.5 inline-flex items-center gap-1.5 text-xs font-medium text-clay-deep hover:underline">
              <LogOut size={13} /> Выйти
            </button>
          </form>
        </div>
      </aside>

      <div className="sticky top-0 z-30 border-b border-line bg-paper/95 backdrop-blur lg:hidden">
        <div className="flex items-center justify-between px-4 pt-3">
          <span className="font-display text-xl text-ink">ГОРН</span>
          <form action={logoutAction}>
            <button className="inline-flex items-center gap-1 text-xs font-medium text-clay-deep">
              <LogOut size={13} /> Выйти
            </button>
          </form>
        </div>
        <AdminNav role={actor.role} />
      </div>

      <main className="mx-auto w-full max-w-5xl px-4 py-8 sm:px-6">{children}</main>
    </div>
  );
}
