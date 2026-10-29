import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { db, withDbRetry } from "@/db";
import { orderItems, orders, products, tgUsers } from "@/db/schema";
import { sendMessage } from "@/lib/telegram-bot";

/**
 * Автоотмена неоплаченных заказов.
 *
 * Заказ в статусе pending_payment резервирует остатки на складе. Без таймаута
 * брошенная корзина «съедает» товар навсегда (дефект P0-1 в TEST-REPORT.md).
 * Заказы старше ORDER_TTL_MINUTES переводятся в cancelled с возвратом остатков —
 * атомарно, с блокировкой строк: параллельные воркеры (крон + ленивая очистка
 * + несколько инстансов) не обрабатывают один заказ дважды.
 */

export const DEFAULT_ORDER_TTL_MINUTES = 60;

export function orderTtlMinutes(): number {
  const raw = Number(process.env.ORDER_TTL_MINUTES ?? DEFAULT_ORDER_TTL_MINUTES);
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_ORDER_TTL_MINUTES;
  return Math.min(60 * 24 * 7, Math.max(1, Math.floor(raw)));
}

export interface ExpireResult {
  cancelled: number;
  orderNumbers: number[];
}

interface StaleOrder {
  id: string;
  orderNumber: number;
  userId: string;
}

/** Отменяет до `limit` просроченных заказов и возвращает остатки на склад. */
export async function expireStaleOrders(limit = 50): Promise<ExpireResult> {
  const ttl = orderTtlMinutes();
  const safeLimit = Math.min(500, Math.max(1, Math.floor(limit)));

  const cancelled = await withDbRetry(() =>
    db.transaction(async (tx) => {
      // 1) Блокируем просроченные заказы; SKIP LOCKED — соседние воркеры берут другие.
      const stale: StaleOrder[] = await tx
        .select({ id: orders.id, orderNumber: orders.orderNumber, userId: orders.userId })
        .from(orders)
        .where(
          and(
            eq(orders.status, "pending_payment"),
            sql`${orders.createdAt} < now() - make_interval(mins => ${ttl})`,
          ),
        )
        .orderBy(asc(orders.createdAt))
        .limit(safeLimit)
        .for("update", { skipLocked: true });

      if (stale.length === 0) return [];
      const ids = stale.map((o) => o.id);

      // 2) Возврат остатков (товар мог быть удалён — product_id = null, такие пропускаем).
      const items = await tx
        .select({ productId: orderItems.productId, qty: sql<number>`sum(${orderItems.qty})::int` })
        .from(orderItems)
        .where(inArray(orderItems.orderId, ids))
        .groupBy(orderItems.productId);

      for (const item of items) {
        if (!item.productId) continue;
        await tx
          .update(products)
          .set({ stock: sql`${products.stock} + ${Number(item.qty)}`, updatedAt: new Date() })
          .where(eq(products.id, item.productId));
      }

      // 3) Отмена — только тех, кто всё ещё ждёт оплату (оплата могла прийти параллельно).
      const updated = await tx
        .update(orders)
        .set({ status: "cancelled", updatedAt: new Date() })
        .where(and(inArray(orders.id, ids), eq(orders.status, "pending_payment")))
        .returning({ id: orders.id });

      const cancelledIds = new Set(updated.map((o) => o.id));
      return stale.filter((o) => cancelledIds.has(o.id));
    }),
  );

  if (cancelled.length === 0) return { cancelled: 0, orderNumbers: [] };

  // 4) Уведомляем покупателей — best-effort, уже после коммита.
  void notifyBuyers(cancelled);

  return { cancelled: cancelled.length, orderNumbers: cancelled.map((o) => o.orderNumber) };
}

async function notifyBuyers(list: StaleOrder[]): Promise<void> {
  try {
    const userIds = [...new Set(list.map((o) => o.userId))];
    const users = await db
      .select({ id: tgUsers.id, telegramId: tgUsers.telegramId })
      .from(tgUsers)
      .where(inArray(tgUsers.id, userIds));
    const telegramIdByUser = new Map(users.map((u) => [u.id, u.telegramId]));

    for (const order of list.slice(0, 20)) {
      const telegramId = telegramIdByUser.get(order.userId);
      if (!telegramId) continue;
      await sendMessage(
        telegramId,
        `Заказ #${order.orderNumber} отменён: оплата не поступила за ${orderTtlMinutes()} мин.\nТовар снова доступен — можно оформить заказ заново.`,
      );
    }
  } catch (err) {
    console.error("[orders] expire notification failed:", err);
  }
}

/**
 * Ленивая автоочистка для публичных ручек (каталог, мои заказы): остатки
 * освобождаются даже без настроенного крона, но не чаще раза в минуту на инстанс.
 */
let lastLazyRun = 0;
export async function maybeExpireStaleOrders(minIntervalMs = 60_000): Promise<void> {
  const now = Date.now();
  if (now - lastLazyRun < minIntervalMs) return;
  lastLazyRun = now;
  try {
    const res = await expireStaleOrders(50);
    if (res.cancelled > 0) {
      console.log(`[orders] автоотмена: ${res.cancelled} заказ(ов) — ${res.orderNumbers.join(", ")}`);
    }
  } catch (err) {
    console.error("[orders] ленивая автоотмена не удалась:", err);
  }
}

/** Момент автоотмены заказа (для UI и админки). */
export function orderExpiresAt(createdAt: Date): Date {
  return new Date(createdAt.getTime() + orderTtlMinutes() * 60_000);
}
