"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { OrderStatus } from "@/db/schema";
import { updateOrderStatusAction } from "@/lib/admin/order-actions";
import { statusLabel } from "@/lib/format";

/**
 * Смена статуса заказа. Граф переходов приходит со страницы (ORDER_TRANSITIONS),
 * серверный action повторно валидирует переход под блокировкой строки заказа.
 */
export function OrderStatusForm({
  orderId,
  status,
  allowed,
}: {
  orderId: string;
  status: OrderStatus;
  allowed: OrderStatus[];
}) {
  const router = useRouter();
  const [pending, setPending] = useState<OrderStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function change(next: OrderStatus) {
    if (next === "cancelled" && !window.confirm("Отменить заказ? Остатки вернутся на склад.")) return;
    setPending(next);
    setError(null);
    const res = await updateOrderStatusAction(orderId, next);
    setPending(null);
    if (!res.ok) setError(res.error);
    else router.refresh();
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="rounded-full bg-ink px-3.5 py-1.5 text-xs font-semibold text-paper">
        {statusLabel(status)}
      </span>
      {allowed.map((next) => (
        <button
          key={next}
          onClick={() => void change(next)}
          disabled={pending !== null}
          className={`rounded-full px-3.5 py-1.5 text-xs font-semibold transition disabled:opacity-40 ${
            next === "cancelled"
              ? "border border-clay/40 text-clay-deep hover:bg-clay/10"
              : "border border-line bg-white text-ink hover:border-ink"
          }`}
        >
          {pending === next ? "…" : `→ ${statusLabel(next)}`}
        </button>
      ))}
      {allowed.length === 0 && <span className="text-xs text-mute">терминальный статус</span>}
      {error && <span className="w-full text-xs text-clay-deep">{error}</span>}
    </div>
  );
}
