import Link from "next/link";
import { asc, eq } from "drizzle-orm";
import { notFound } from "next/navigation";
import { db } from "@/db";
import { orderItems, orders, tgUsers } from "@/db/schema";
import { requireAdmin } from "@/lib/admin-session";
import { formatDate, formatPrice, statusLabel } from "@/lib/format";
import { ORDER_TRANSITIONS } from "@/lib/order-transitions";
import { OrderStatusForm } from "@/components/admin/order-status-form";

export const dynamic = "force-dynamic";

export default async function AdminOrderDetailPage({ params }: { params: Promise<{ id: string }> }) {
  await requireAdmin(); // уровень 3: проверка на каждой странице
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();

  const [order] = await db.select().from(orders).where(eq(orders.id, id)).limit(1);
  if (!order) notFound();

  const items = await db
    .select()
    .from(orderItems)
    .where(eq(orderItems.orderId, order.id))
    .orderBy(asc(orderItems.productName));

  const [buyer] = await db.select().from(tgUsers).where(eq(tgUsers.id, order.userId)).limit(1);

  const transitions = ORDER_TRANSITIONS[order.status];

  return (
    <div className="max-w-3xl">
      <Link href="/admin/orders" className="text-xs font-semibold text-mute hover:text-ink">
        ← все заказы
      </Link>

      <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
        <h1 className="font-display text-3xl text-ink">Заказ #{order.orderNumber}</h1>
        <OrderStatusForm orderId={order.id} status={order.status} allowed={transitions} />
      </div>

      <div className="mt-6 grid gap-4 md:grid-cols-2">
        <section className="card-shadow rounded-2xl bg-white/70 p-5">
          <h2 className="text-xs font-bold uppercase tracking-wide text-mute">Покупатель</h2>
          <dl className="mt-3 space-y-1.5 text-sm">
            <Row k="Имя" v={order.customerName} />
            <Row k="Телефон" v={order.phone} />
            <Row k="Адрес" v={order.address || "—"} />
            <Row k="Комментарий" v={order.comment || "—"} />
            {buyer && (
              <Row
                k="Telegram"
                v={`${buyer.firstName ?? ""} ${buyer.lastName ?? ""}`.trim() + (buyer.username ? ` · @${buyer.username}` : "")}
              />
            )}
          </dl>
        </section>

        <section className="card-shadow rounded-2xl bg-white/70 p-5">
          <h2 className="text-xs font-bold uppercase tracking-wide text-mute">Статус и оплата</h2>
          <dl className="mt-3 space-y-1.5 text-sm">
            <Row k="Статус" v={statusLabel(order.status)} />
            <Row k="Создан" v={formatDate(order.createdAt)} />
            <Row k="Оплачен" v={order.paidAt ? formatDate(order.paidAt) : "—"} />
            <Row
              k="Способ"
              v={
                order.paymentProvider === "telegram_stars"
                  ? "Telegram Stars"
                  : order.paymentProvider === "telegram_fiat"
                    ? "Telegram Payments (карта)"
                    : order.paymentProvider === "external"
                      ? "Внешний эквайринг"
                      : "—"
              }
            />
            <Row k="ID платежа" v={order.paymentChargeId ?? "—"} mono />
          </dl>
        </section>
      </div>

      <section className="card-shadow mt-4 overflow-hidden rounded-2xl bg-white/70">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-line text-left text-xs text-mute">
              <th className="px-5 py-3 font-medium">Позиция</th>
              <th className="px-5 py-3 font-medium">Цена</th>
              <th className="px-5 py-3 font-medium">Кол-во</th>
              <th className="px-5 py-3 text-right font-medium">Сумма</th>
            </tr>
          </thead>
          <tbody>
            {items.map((i) => (
              <tr key={i.id} className="border-b border-line/60 last:border-0">
                <td className="px-5 py-3 font-medium">{i.productName}</td>
                <td className="px-5 py-3 text-mute">{formatPrice(i.priceMinor)}</td>
                <td className="px-5 py-3">×{i.qty}</td>
                <td className="px-5 py-3 text-right font-medium">{formatPrice(i.priceMinor * i.qty)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="bg-cream/50">
              <td colSpan={3} className="px-5 py-3 text-right text-xs font-bold uppercase tracking-wide text-mute">
                Итого
              </td>
              <td className="px-5 py-3 text-right text-base font-bold">{formatPrice(order.totalMinor)}</td>
            </tr>
          </tfoot>
        </table>
      </section>
    </div>
  );
}

function Row({ k, v, mono }: { k: string; v: string; mono?: boolean }) {
  return (
    <div className="flex gap-2">
      <dt className="w-28 shrink-0 text-mute">{k}</dt>
      <dd className={`min-w-0 break-words ${mono ? "font-mono text-xs" : ""}`}>{v}</dd>
    </div>
  );
}
