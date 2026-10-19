import type { NextRequest } from "next/server";
import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { and, eq, sql } from "drizzle-orm";
import { db, withDbRetry } from "@/db";
import { orderItems, orders, paymentEvents, tgUsers } from "@/db/schema";
import { json, errorResponse, HttpError } from "@/lib/http";
import { sendMessage } from "@/lib/telegram-bot";

export const dynamic = "force-dynamic";

/**
 * ОПЦИОНАЛЬНЫЙ webhook внешнего эквайринга (основной приём оплаты — Telegram
 * Payments через /api/webhooks/telegram; этот маршрут — для редирект-эквайринга,
 * если он будет подключён). Аутентификация: HMAC-SHA256 сырого тела ключом
 * PAYMENT_WEBHOOK_SECRET в заголовке X-Payment-Signature (hex).
 * Идемпотентность: уникальный индекс payment_events(provider="external", external_event_id).
 */

const eventSchema = z.object({
  event_id: z.string().min(6).max(128),
  order_id: z.string().uuid(),
  status: z.enum(["paid", "cancelled"]),
  amount_minor: z.number().int().nonnegative().optional(),
  currency: z.string().max(8).optional(),
});

export async function POST(req: NextRequest) {
  try {
    const secret = process.env.PAYMENT_WEBHOOK_SECRET ?? "";
    if (!secret) throw new HttpError(503, "Внешний эквайринг не настроен", "not_configured");

    const raw = await req.text();
    const signature = req.headers.get("x-payment-signature") ?? "";
    const expected = createHmac("sha256", secret).update(raw).digest("hex");
    const a = Buffer.from(expected, "hex");
    const b = Buffer.from(signature, "hex");
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new HttpError(401, "Неверная подпись вебхука", "bad_signature");
    }

    const event = eventSchema.parse(JSON.parse(raw));

    const processed = await withDbRetry(() =>
      db.transaction(async (tx) => {
        const inserted = await tx
          .insert(paymentEvents)
          .values({ provider: "external", externalEventId: event.event_id, orderId: event.order_id, payload: event })
          .onConflictDoNothing()
          .returning({ id: paymentEvents.id });
        if (inserted.length === 0) return false; // дубликат события — молча подтверждаем

        const [order] = await tx.select().from(orders).where(eq(orders.id, event.order_id)).limit(1);
        if (!order) throw new HttpError(404, "Заказ не найден", "order_not_found");

        if (event.status === "paid") {
          // Сверка суммы — защита от подмены количества денег корректно подписанным событием.
          if (event.amount_minor !== undefined && event.amount_minor !== order.totalMinor) {
            throw new HttpError(409, "Сумма платежа не совпадает с суммой заказа", "amount_mismatch");
          }
          await tx
            .update(orders)
            .set({
              status: "paid",
              paidAt: new Date(),
              paymentProvider: "external",
              paymentChargeId: event.event_id,
              updatedAt: new Date(),
            })
            .where(and(eq(orders.id, order.id), eq(orders.status, "pending_payment")));
        } else if (event.status === "cancelled") {
          // Отмена неоплаченного заказа + атомарный возврат остатков по позициям.
          const cancelled = await tx
            .update(orders)
            .set({ status: "cancelled", updatedAt: new Date() })
            .where(and(eq(orders.id, order.id), eq(orders.status, "pending_payment")))
            .returning({ id: orders.id });
          if (cancelled.length > 0) {
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
        }
        return true;
      }),
    );

    if (processed && event.status === "paid") {
      const [order] = await db.select().from(orders).where(eq(orders.id, event.order_id)).limit(1);
      if (order?.userId) {
        const [u] = await db.select().from(tgUsers).where(eq(tgUsers.id, order.userId)).limit(1);
        if (u) await sendMessage(u.telegramId, `Оплата по заказу #${order.orderNumber} подтверждена.`);
      }
    }

    return json({ ok: true, duplicate: !processed });
  } catch (err) {
    return errorResponse(err);
  }
}
