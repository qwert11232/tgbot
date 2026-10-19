import Link from "next/link";
import { asc } from "drizzle-orm";
import { db } from "@/db";
import { staffUsers } from "@/db/schema";
import { requireAdmin } from "@/lib/admin-session";
import { formatDate } from "@/lib/format";
import { StaffManager } from "@/components/admin/staff-manager";
import { ShieldAlert } from "lucide-react";

export const dynamic = "force-dynamic";

export default async function AdminStaffPage() {
  // Уровень 3: явная проверка роли НА СТРАНИЦЕ (нельзя полагаться только на layout).
  const actor = await requireAdmin();

  if (actor.role !== "owner") {
    return (
      <div className="card-shadow mx-auto mt-12 max-w-md rounded-2xl bg-white/70 p-8 text-center">
        <ShieldAlert size={28} className="mx-auto text-clay-deep" />
        <h1 className="font-display mt-4 text-2xl text-ink">Доступ ограничен</h1>
        <p className="mt-2 text-sm leading-relaxed text-mute">
          Раздел «Сотрудники» доступен только владельцу (owner). Менеджеры работают с товарами и заказами.
        </p>
        <Link href="/admin" className="mt-5 inline-block rounded-full bg-ink px-6 py-2.5 text-sm font-semibold text-paper">
          На панель
        </Link>
      </div>
    );
  }

  const staff = await db.select().from(staffUsers).orderBy(asc(staffUsers.createdAt));

  return (
    <div className="max-w-3xl">
      <h1 className="font-display text-3xl text-ink">Сотрудники</h1>
      <p className="mt-1 text-sm leading-relaxed text-mute">
        Единственного владельца нельзя понизить, деактивировать или удалить; изменить себя тоже нельзя.
        Смена роли или пароля мгновенно отзывает все сессии сотрудника.
      </p>
      <div className="mt-6">
        <StaffManager
          currentUserId={actor.id}
          staff={staff.map((s) => ({
            id: s.id,
            email: s.email,
            name: s.name,
            role: s.role,
            isActive: s.isActive,
            createdAt: formatDate(s.createdAt),
          }))}
        />
      </div>
    </div>
  );
}
