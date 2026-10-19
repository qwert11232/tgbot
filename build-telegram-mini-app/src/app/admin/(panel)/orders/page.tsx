import Link from "next/link";
import { desc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { orders, tgUsers, orderStatusEnum } from "@/db/schema";
import { requireAdmin } from "@/lib/admin-session";
import { formatDate, formatPrice, statusLabel } from "@/lib/format";
import { StatusBadge } from "@/app/admin/(panel)/page";

export const dynamic = "force-dynamic";

const STATUSES = orderStatusEnum.enumValues;

export default async function AdminOrdersPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  await requireAdmin(); // уровень 3: проверка на каждой странице
  const sp = await searchParams;
  const status = STATUSES.includes(sp.status as (typeof STATUSES)[number])
    ? (sp.status as (typeof STATUSES)[number])
    : null;

  const rows = await db
    .select({ order: orders, tgUsername: tgUsers.username, tgFirstName: tgUsers.firstName })
    .from(orders)
    .leftJoin(tgUsers, eq(orders.userId, tgUsers.id))
    .where(status ? eq(orders.status, status) : undefined)
    .orderBy(desc(orders.createdAt))
    .limit(150);

  const countsRes = await db.execute(
    sql`SELECT status, count(*)::int AS c FROM orders GROUP BY status`,
  );
  const countRows = (Array.isArray(countsRes) ? countsRes : (countsRes as { rows?: unknown[] }).rows) as
    | { status: string; c: number }[]
    | [];
  const countByStatus = new Map((countRows ?? []).map((r) => [r.status, Number(r.c)]));

  return (
    <div>
      <h1 className="font-display text-3xl text-ink">Заказы</h1>

      <div className="no-scrollbar mt-5 flex gap-2 overflow-x-auto pb-1">
        <FilterChip href="/admin/orders" active={!status} label={`Все`} />
        {STATUSES.map((s) => (
          <FilterChip
            key={s}
            href={`/admin/orders?status=${s}`}
            active={status === s}
            label={`${statusLabel(s)}${countByStatus.has(s) ? ` · ${countByStatus.get(s)}` : ""}`}
          />
        ))}
      </div>

      <div className="card-shadow mt-4 overflow-hidden rounded-2xl bg-white/70">
        {rows.length === 0 ? (
          <p className="px-5 py-8 text-sm text-mute">Заказов с таким статусом нет.</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line text-left text-xs text-mute">
                <th className="px-5 py-3 font-medium">№</th>
                <th className="px-5 py-3 font-medium">Покупатель</th>
                <th className="hidden px-5 py-3 font-medium md:table-cell">Телефон</th>
                <th className="px-5 py-3 font-medium">Сумма</th>
                <th className="px-5 py-3 font-medium">Статус</th>
                <th className="hidden px-5 py-3 font-medium sm:table-cell">Создан</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ order, tgUsername }) => (
                <tr key={order.id} className="border-b border-line/60 last:border-0 hover:bg-cream/50">
                  <td className="px-5 py-3 font-semibold">
                    <Link href={`/admin/orders/${order.id}`} className="text-clay-deep hover:underline">
                      #{order.orderNumber}
                    </Link>
                  </td>
                  <td className="px-5 py-3">
                    {order.customerName}
                    {tgUsername && <span className="ml-1 text-xs text-mute">@{tgUsername}</span>}
                  </td>
                  <td className="hidden px-5 py-3 text-mute md:table-cell">{order.phone}</td>
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
      <p className="mt-3 text-xs text-mute">Показано до 150 последних заказов.</p>
    </div>
  );
}

function FilterChip({ href, active, label }: { href: string; active: boolean; label: string }) {
  return (
    <Link
      href={href}
      className={`shrink-0 rounded-full px-4 py-2 text-xs font-semibold transition ${
        active ? "bg-ink text-paper" : "border border-line bg-white text-ink hover:border-mute"
      }`}
    >
      {label}
    </Link>
  );
}
