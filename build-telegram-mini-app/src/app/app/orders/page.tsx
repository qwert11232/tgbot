"use client";

import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { CheckCircle2, CreditCard, Package } from "lucide-react";
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
  payable?: boolean;
  expiresAt?: string | null;
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

/** Опрос статусов: вебхук Telegram обычно приходит через 1–3 с после оплаты. */
const POLL_INTERVAL_MS = 5000;

function timeLeft(expiresAt: string | null | undefined): string | null {
  if (!expiresAt) return null;
  const diff = new Date(expiresAt).getTime() - Date.now();
  if (!Number.isFinite(diff) || diff <= 0) return null;
  const minutes = Math.ceil(diff / 60_000);
  return minutes >= 60 ? `${Math.round(minutes / 60)} ч` : `${minutes} мин`;
}

function OrdersInner() {
  const { apiFetch, token, ready, authError, tg } = useTelegram();
  const [orders, setOrders] = useState<OrderView[] | null>(null);
  const [payingId, setPayingId] = useState<string | null>(null);
  const [payError, setPayError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const sp = useSearchParams();
  const justPaid = sp.get("paid") === "1";
  const justCreated = sp.get("created") === "1";

  // Загрузка заказов: refreshKey меняется после оплаты и при опросе статусов.
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
        if (!cancelled) setOrders((prev) => prev ?? []);
      });
    return () => {
      cancelled = true;
    };
  }, [apiFetch, token, refreshKey, justPaid]);

  // Пока есть неоплаченные заказы — периодически обновляем статусы,
  // чтобы «Ожидает оплаты» сменилось на «Оплачен» без перезагрузки (P2-15).
  const hasPending = (orders ?? []).some((o) => o.status === "pending_payment");
  useEffect(() => {
    if (!token || !hasPending) return;
    const timer = setTimeout(() => {
      if (typeof document !== "undefined" && document.visibilityState === "visible") {
        setRefreshKey((k) => k + 1);
      }
    }, POLL_INTERVAL_MS);
    return () => clearTimeout(timer);
  }, [token, hasPending, refreshKey]);

  async function pay(order: OrderView) {
    setPayingId(order.id);
    setPayError(null);
    try {
      const res = await apiFetch(`/api/orders/${order.id}/invoice`, { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.invoiceUrl) {
        setPayError(data.error ?? "Не удалось получить ссылку на оплату");
        return;
      }
      if (typeof tg?.openInvoice === "function") {
        tg.openInvoice(data.invoiceUrl as string, (status: string) => {
          if (status === "paid") setRefreshKey((k) => k + 1);
        });
      } else {
        setPayError("Откройте магазин в Telegram, чтобы оплатить заказ.");
      }
    } catch {
      setPayError("Сеть недоступна. Попробуйте ещё раз.");
    } finally {
      setPayingId(null);
    }
  }

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
              : "Заказ создан. Оплатить его можно кнопкой «Оплатить» ниже — заказ хранится час."}
          </span>
        </div>
      )}

      {payError && (
        <div className="mt-4 rounded-2xl bg-clay/10 p-3 text-xs leading-relaxed text-clay-deep">{payError}</div>
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
          {orders.map((o) => {
            const left = o.status === "pending_payment" ? timeLeft(o.expiresAt) : null;
            return (
              <div key={o.id} className="card-shadow rounded-2xl bg-white/70 p-4">
                <div className="flex items-center justify-between">
                  <p className="text-sm font-bold text-ink">Заказ #{o.orderNumber}</p>
                  <span
                    className={`rounded-full px-2.5 py-1 text-[11px] font-semibold ${STATUS_COLORS[o.status] ?? "bg-cream text-ink"}`}
                  >
                    {statusLabel(o.status)}
                  </span>
                </div>
                <p className="mt-1 text-xs text-mute">
                  {formatDate(o.createdAt)}
                  {left ? ` · оплатить в течение ${left}` : ""}
                </p>
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
                <div className="mt-3 flex items-center justify-between border-t border-line/70 pt-3 text-sm font-semibold text-ink">
                  <span>Итого</span>
                  <span>{formatPrice(o.totalMinor)}</span>
                </div>

                {o.status === "pending_payment" && o.payable !== false && (
                  <button
                    onClick={() => void pay(o)}
                    disabled={payingId === o.id}
                    className="mt-3 flex w-full items-center justify-center gap-2 rounded-full bg-clay py-3 text-sm font-semibold text-white transition enabled:hover:bg-clay-deep disabled:opacity-50"
                  >
                    <CreditCard size={16} /> {payingId === o.id ? "Открываем оплату…" : "Оплатить"}
                  </button>
                )}
                {o.status === "pending_payment" && o.payable === false && (
                  <p className="mt-3 rounded-xl bg-cream/70 px-3 py-2 text-[11px] leading-relaxed text-mute">
                    Оплата временно недоступна. Напишите нам в бот — поможем с заказом.
                  </p>
                )}
              </div>
            );
          })}
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
