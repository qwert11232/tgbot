import Link from "next/link";
import { desc, eq, inArray, lte, and, sql } from "drizzle-orm";
import { db } from "@/db";
import { orders, products, tgUsers } from "@/db/schema";
import { requireAdmin } from "@/lib/admin-session";
import { formatDate, formatPrice, statusLabel } from "@/lib/format";

export const dynamic = "force-dynamic";

async function scalar(sqlText: ReturnType<typeof sql>): Promise<number> {
  const res = await db.execute(sqlText);
  const rows = (Array.isArray(res) ? res : (res as { rows?: Record<string, unknown>[] }).rows) ?? [];
  return Number(Object.values(rows[0] ?? { v: 0 })[0] ?? 0);
}

export default async function AdminDashboardPage() {
  await requireAdmin(); // уровень 3: проверка на каждой странице

  const [activeProducts, lowStock, pendingOrders, revenue] = await Promise.all([
    scalar(sql`SELECT count(*) AS v FROM products WHERE is_active`),
    scalar(sql`SELECT count(*) AS v FROM products WHERE is_active AND stock <= 3`),
    scalar(sql`SELECT count(*) AS v FROM orders WHERE status = 'pending_payment'`),
    scalar(
      sql`SELECT coalesce(sum(total_minor), 0) AS v FROM orders WHERE status IN ('paid','processing','shipped','delivered')`,
    ),
  ]);

  const recent = await db
    .select({ order: orders, tgFirstName: tgUsers.firstName, tgUsername: tgUsers.username })
    .from(orders)
    .leftJoin(tgUsers, eq(orders.userId, tgUsers.id))
    .orderBy(desc(orders.createdAt))
    .limit(8);

  const stats = [
    { label: "Активных товаров", value: String(activeProducts), href: "/admin/products" },
    { label: "Заканчиваются (≤3 шт.)", value: String(lowStock), href: "/admin/products" },
    { label: "Ждут оплаты", value: String(pendingOrders), href: "/admin/orders?status=pending_payment" },
    { label: "Выручка", value: formatPrice(revenue), href: "/admin/orders" },
  ];

  return (
    <div>
      <h1 className="font-display text-3xl text-ink">Панель</h1>

      <div className="mt-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        {stats.map((s) => (
          <Link
            key={s.label}
            href={s.href}
            className="card-shadow rounded-2xl bg-white/70 p-5 transition hover:bg-white"
          >
            <p className="text-xs font-semibold uppercase tracking-wide text-mute">{s.label}</p>
            <p className="mt-2 text-2xl font-bold text-ink">{s.value}</p>
          </Link>
        ))}
      </div>

      <div className="mt-10 flex items-center justify-between">
        <h2 className="text-sm font-bold uppercase tracking-wide text-mute">Последние заказы</h2>
        <Link href="/admin/orders" className="text-xs font-semibold text-clay-deep hover:underline">
          все заказы →
        </Link>
      </div>
      <div className="card-shadow mt-3 overflow-hidden rounded-2xl bg-white/70">
        {recent.length === 0 ? (
          <p className="px-5 py-8 text-sm text-mute">Заказов пока нет — они появятся после первых продаж.</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line text-left text-xs text-mute">
                <th className="px-5 py-3 font-medium">№</th>
                <th className="px-5 py-3 font-medium">Покупатель</th>
                <th className="px-5 py-3 font-medium">Сумма</th>
                <th className="px-5 py-3 font-medium">Статус</th>
                <th className="hidden px-5 py-3 font-medium sm:table-cell">Дата</th>
              </tr>
            </thead>
            <tbody>
              {recent.map(({ order, tgFirstName, tgUsername }) => (
                <tr key={order.id} className="border-b border-line/60 last:border-0 hover:bg-cream/50">
                  <td className="px-5 py-3 font-semibold">
                    <Link href={`/admin/orders/${order.id}`} className="text-clay-deep hover:underline">
                      #{order.orderNumber}
                    </Link>
                  </td>
                  <td className="px-5 py-3">
                    {order.customerName}
                    {tgUsername && <span className="ml-1 text-xs text-mute">@{tgUsername}</span>}
                    {!tgUsername && tgFirstName && <span className="ml-1 text-xs text-mute">({tgFirstName})</span>}
                  </td>
                  <td className="px-5 py-3 font-medium">{formatPrice(order.totalMinor)}</td>
                  <td className="px-5 py-3">
                    <StatusBadge status={order.status} />
                  </td>
                  <td className="hidden px-5 py-3 text-mute sm:table-cell">{formatDate(order.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

export function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    pending_payment: "bg-amber-100 text-amber-800",
    paid: "bg-emerald-100 text-emerald-800",
    processing: "bg-sky-100 text-sky-800",
    shipped: "bg-indigo-100 text-indigo-800",
    delivered: "bg-emerald-100 text-emerald-800",
    cancelled: "bg-stone-200 text-stone-500",
  };
  return (
    <span className={`rounded-full px-2.5 py-1 text-[11px] font-semibold ${colors[status] ?? "bg-cream text-ink"}`}>
      {statusLabel(status)}
    </span>
  );
}
