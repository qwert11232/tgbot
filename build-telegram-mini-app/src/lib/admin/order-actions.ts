"use server";

import { revalidatePath } from "next/cache";
import { z, ZodError } from "zod";
import { eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { orderItems, orders, tgUsers, type OrderStatus } from "@/db/schema";
import { getAdminActor } from "@/lib/admin-session";
import { ForbiddenError, HttpError } from "@/lib/http";
import { sendMessage } from "@/lib/telegram-bot";
import { statusLabel } from "@/lib/format";

type ActionResult = { ok: true } | { ok: false; error: string };

function fail(err: unknown): { ok: false; error: string } {
  if (err instanceof ZodError) return { ok: false, error: err.issues[0]?.message ?? "Ошибка валидации" };
  if (err instanceof ForbiddenError || err instanceof HttpError) return { ok: false, error: err.message };
  if (err instanceof Error) return { ok: false, error: err.message };
  return { ok: false, error: "Неизвестная ошибка" };
}

import { ORDER_TRANSITIONS, RESTOCK_ON_CANCEL_FROM } from "@/lib/order-transitions";

const TRANSITIONS = ORDER_TRANSITIONS;

async function requireStaff() {
  const actor = await getAdminActor();
  if (!actor) throw new ForbiddenError("Требуется авторизация администратора");
  return actor;
}

export async function updateOrderStatusAction(orderId: string, nextStatus: OrderStatus): Promise<ActionResult> {
  try {
    await requireStaff();
    if (!z.uuid().safeParse(orderId).success) throw new HttpError(400, "Некорректный id заказа");
    if (!Object.keys(TRANSITIONS).includes(nextStatus)) throw new HttpError(400, "Неизвестный статус");

    const notify = await db.transaction(async (tx) => {
      // Блокируем строку заказа: параллельные смены статуса сериализуются.
      const [order] = await tx.select().from(orders).where(eq(orders.id, orderId)).for("update").limit(1);
      if (!order) throw new HttpError(404, "Заказ не найден");
      if (order.status === nextStatus) return null;
      if (!TRANSITIONS[order.status].includes(nextStatus)) {
        throw new HttpError(409, `Переход «${statusLabel(order.status)}» → «${statusLabel(nextStatus)}» недопустим`);
      }

      if (nextStatus === "cancelled" && RESTOCK_ON_CANCEL_FROM.includes(order.status)) {
        // Атомарный возврат остатков по позициям заказа.
        const items = await tx
          .select({ productId: orderItems.productId, qty: orderItems.qty })
          .from(orderItems)
          .where(eq(orderItems.orderId, order.id));
        for (const item of items) {
          if (!item.productId) continue;
          await tx.execute(
            sql`UPDATE products SET stock = stock + ${item.qty}, updated_at = now() WHERE id = ${item.productId}`,
          );
        }
      }

      await tx
        .update(orders)
        .set({
          status: nextStatus,
          updatedAt: new Date(),
          ...(nextStatus === "paid" && order.status === "pending_payment"
            ? { paidAt: new Date(), paymentProvider: order.paymentProvider ?? "external" }
            : {}),
        })
        .where(eq(orders.id, order.id));

      return { orderNumber: order.orderNumber, userId: order.userId, next: nextStatus };
    });

    // Уведомление покупателя через бота — best-effort, после коммита.
    if (notify) {
      const [u] = await db.select().from(tgUsers).where(eq(tgUsers.id, notify.userId)).limit(1);
      if (u) {
        void sendMessage(
          u.telegramId,
          `Заказ #${notify.orderNumber}: новый статус — «${statusLabel(notify.next)}».`,
        );
      }
    }

    revalidatePath("/admin/orders");
    revalidatePath(`/admin/orders/${orderId}`);
    return { ok: true };
  } catch (err) {
    return fail(err);
  }
}
