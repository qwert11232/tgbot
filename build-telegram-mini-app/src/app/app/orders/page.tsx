"use client";

import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { CheckCircle2, Package } from "lucide-react";
import { useTelegram } from "@/components/miniapp/telegram-provider";
import { formatDate, formatPrice, statusLabel } from "@/lib/format";

interface OrderItemView {
  id: string;
  productName: string;
  priceMinor: number;
  qty: number;
}

interface OrderView {
  id: string;
  orderNumber: number;
  status: string;
  totalMinor: number;
  createdAt: string;
  paidAt: string | null;
  items: OrderItemView[];
}

const STATUS_COLORS: Record<string, string> = {
  pending_payment: "bg-amber-100 text-amber-800",
  paid: "bg-emerald-100 text-emerald-800",
  processing: "bg-sky-100 text-sky-800",
  shipped: "bg-indigo-100 text-indigo-800",
  delivered: "bg-emerald-100 text-emerald-800",
  cancelled: "bg-stone-200 text-stone-600",
};

function OrdersInner() {
  const { apiFetch, token, ready, authError } = useTelegram();
  const [orders, setOrders] = useState<OrderView[] | null>(null);
  const sp = useSearchParams();
  const justPaid = sp.get("paid") === "1";
  const justCreated = sp.get("created") === "1";

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    apiFetch("/api/orders")
      .then(async (r) => {
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? "Ошибка загрузки");
        return r.json();
      })
      .then((d) => {
        if (!cancelled) setOrders(d.orders ?? []);
      })
      .catch(() => {
        if (!cancelled) setOrders([]);
      });
    return () => {
      cancelled = true;
    };
  }, [token, apiFetch, justPaid]);

  if (ready && !token) {
    return (
      <div className="flex flex-col items-center px-6 py-24 text-center">
        <Package size={32} className="text-mute" />
        <p className="mt-4 font-display text-xl text-ink">Заказы недоступны</p>
        <p className="mt-2 text-sm leading-relaxed text-mute">{authError ?? "Требуется авторизация Telegram."}</p>
      </div>
    );
  }

  if (orders === null) {
    return <p className="px-4 py-16 text-center text-sm text-mute">Загрузка заказов…</p>;
  }

  return (
    <div className="px-4 pb-16 pt-5">
      <h1 className="font-display text-2xl text-ink">Мои заказы</h1>

      {(justPaid || justCreated) && (
        <div className="mt-4 flex items-start gap-2 rounded-2xl bg-emerald-50 p-3 text-xs leading-relaxed text-emerald-800">
          <CheckCircle2 size={16} className="mt-0.5 shrink-0" />
          <span>
            {justPaid
              ? "Оплата прошла. Статус обновится в течение нескольких секунд — бот пришлёт подтверждение."
              : "Заказ создан. Ссылку на оплату можно получить повторно, оформив заказ ещё раз с тем же составом."}
          </span>
        </div>
      )}

      {orders.length === 0 ? (
        <div className="flex flex-col items-center py-20 text-center">
          <p className="text-sm text-mute">Пока пусто. Ваш первый заказ уже ждёт в каталоге.</p>
          <Link href="/app" className="mt-6 rounded-full bg-ink px-8 py-3 text-sm font-semibold text-paper">
            В каталог
          </Link>
        </div>
      ) : (
        <div className="mt-5 space-y-3">
          {orders.map((o) => (
            <div key={o.id} className="card-shadow rounded-2xl bg-white/70 p-4">
              <div className="flex items-center justify-between">
                <p className="text-sm font-bold text-ink">Заказ #{o.orderNumber}</p>
                <span
                  className={`rounded-full px-2.5 py-1 text-[11px] font-semibold ${STATUS_COLORS[o.status] ?? "bg-cream text-ink"}`}
                >
                  {statusLabel(o.status)}
                </span>
              </div>
              <p className="mt-1 text-xs text-mute">{formatDate(o.createdAt)}</p>
              <div className="mt-3 space-y-1 border-t border-line/70 pt-3">
                {o.items.map((i) => (
                  <div key={i.id} className="flex justify-between text-[13px] text-ink/80">
                    <span className="pr-3">
                      {i.productName} <span className="text-mute">×{i.qty}</span>
                    </span>
                    <span className="shrink-0">{formatPrice(i.priceMinor * i.qty)}</span>
                  </div>
                ))}
              </div>
              <div className="mt-3 flex justify-between border-t border-line/70 pt-3 text-sm font-semibold text-ink">
                <span>Итого</span>
                <span>{formatPrice(o.totalMinor)}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function OrdersPage() {
  return (
    <Suspense fallback={<p className="px-4 py-16 text-center text-sm text-mute">Загрузка…</p>}>
      <OrdersInner />
    </Suspense>
  );
}
