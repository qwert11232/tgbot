import type { NextRequest } from "next/server";
import crypto from "node:crypto";
import { z } from "zod";
import { and, eq, sql } from "drizzle-orm";
import { db, withDbRetry } from "@/db";
import { orderItems, orders, paymentEvents, products, tgUsers } from "@/db/schema";
import { json, errorResponse, HttpError } from "@/lib/http";
import { sendMessage } from "@/lib/telegram-bot";
import { formatRub, notifyAdmin } from "@/lib/notify";

export const dynamic = "force-dynamic";

/**
 * Webhook внешнего эквайринга (опционально; основной приём — Telegram Payments
 * через /api/webhooks/telegram).
 *
 * Аутентификация: HMAC-SHA256 сырого тела ключом PAYMENT_WEBHOOK_SECRET
 * в заголовке X-Payment-Signature (hex), сравнение в постоянном времени.
 * Идемпотентность: payment_events(provider="external", external_event_id).
 *
 * Исправления по TEST-REPORT.md:
 *  - P1-8: заказ проверяется ДО вставки события (раньше FK падал → 500);
 *  - P1-7: оплата по отменённому заказу больше не теряется — событие пишется,
 *    админ получает алерт, провайдеру отвечаем 200 (ретраи бессмысленны);
 *  - несовпадение суммы не вызывает бесконечные ретраи провайдера.
 */

const eventSchema = z.object({
  event_id: z.string().min(6).max(128),
  order_id: z.string().uuid(),
  status: z.enum(["paid", "cancelled"]),
  amount_minor: z.number().int().nonnegative().optional(),
  currency: z.string().max(8).optional(),
});

function signatureMatches(secret: string, raw: string, signature: string): boolean {
  const expected = crypto.createHmac("sha256", secret).update(raw).digest("hex");
  const a = Buffer.from(expected, "hex");
  let b: Buffer;
  try {
    b = Buffer.from(signature, "hex");
  } catch {
    return false;
  }
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export async function POST(req: NextRequest) {
  try {
    const secret = process.env.PAYMENT_WEBHOOK_SECRET ?? "";
    if (!secret) throw new HttpError(503, "Внешний эквайринг не настроен", "not_configured");

    const raw = await req.text();
    const signature = req.headers.get("x-payment-signature") ?? "";
    if (!signatureMatches(secret, raw, signature)) {
      throw new HttpError(401, "Неверная подпись вебхука", "bad_signature");
    }

    const event = eventSchema.parse(JSON.parse(raw) as unknown);

    // Заказ проверяем до вставки события: иначе FK payment_events.order_id
    // превращал «неизвестный заказ» в 500 и бесконечные ретраи провайдера.
    const [knownOrder] = await db.select().from(orders).where(eq(orders.id, event.order_id)).limit(1);
    if (!knownOrder) {
      console.error("[payment/external] событие по неизвестному заказу:", event);
      await notifyAdmin(
        `ВНИМАНИЕ: внешний платёж ${event.status} по неизвестному заказу ${event.order_id} (event ${event.event_id}). Событие не сохранено.`,
      );
      return json({ ok: false, error: "Заказ не найден", code: "order_not_found" }, 404);
    }

    const result = await withDbRetry(() =>
      db.transaction(async (tx) => {
        const [order] = await tx.select().from(orders).where(eq(orders.id, event.order_id)).for("update").limit(1);
        if (!order) return { kind: "not_found" as const };

        const inserted = await tx
          .insert(paymentEvents)
          .values({ provider: "external", externalEventId: event.event_id, orderId: order.id, payload: event })
          .onConflictDoNothing()
          .returning({ id: paymentEvents.id });
        if (inserted.length === 0) return { kind: "duplicate" as const };

        if (event.status === "paid") {
          // Сверка суммы — защита от подмены количества денег корректно подписанным событием.
          if (event.amount_minor !== undefined && event.amount_minor !== order.totalMinor) {
            return { kind: "amount_mismatch" as const, totalMinor: order.totalMinor, got: event.amount_minor, orderNumber: order.orderNumber };
          }
          if (order.status !== "pending_payment") {
            return {
              kind: "wrong_status" as const,
              status: order.status,
              orderNumber: order.orderNumber,
              userId: order.userId,
            };
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
          return { kind: "paid" as const, orderId: order.id, orderNumber: order.orderNumber, userId: order.userId };
        }

        // cancelled: отмена неоплаченного заказа + атомарный возврат остатков.
        const cancelled = await tx
          .update(orders)
          .set({ status: "cancelled", updatedAt: new Date() })
          .where(and(eq(orders.id, order.id), eq(orders.status, "pending_payment")))
          .returning({ id: orders.id });
        if (cancelled.length === 0) return { kind: "duplicate" as const };

        const items = await tx
          .select({ productId: orderItems.productId, qty: orderItems.qty })
          .from(orderItems)
          .where(eq(orderItems.orderId, order.id));
        for (const item of items) {
          if (!item.productId) continue;
          await tx
            .update(products)
            .set({ stock: sql`${products.stock} + ${item.qty}`, updatedAt: new Date() })
            .where(eq(products.id, item.productId));
        }
        return { kind: "cancelled" as const, orderNumber: order.orderNumber };
      }),
    );

    // Уведомления — после коммита, best-effort.
    switch (result.kind) {
      case "paid": {
        const [u] = await db.select().from(tgUsers).where(eq(tgUsers.id, result.userId)).limit(1);
        if (u) await sendMessage(u.telegramId, `Оплата по заказу #${result.orderNumber} подтверждена.`);
        await notifyAdmin(`Оплачен заказ #${result.orderNumber} (внешний эквайринг)`);
        break;
      }
      case "amount_mismatch":
        console.error("[payment/external] сумма не совпадает:", result);
        await notifyAdmin(
          `ВНИМАНИЕ: внешний платёж ${formatRub(result.got)} по заказу #${result.orderNumber} ` +
            `не совпадает с суммой заказа ${formatRub(result.totalMinor)}. Заказ не помечен оплаченным.`,
        );
        break;
      case "wrong_status":
        console.error("[payment/external] платёж по заказу в статусе", result.status, result.orderNumber);
        await notifyAdmin(
          `ВНИМАНИЕ: внешний платёж по заказу #${result.orderNumber} в статусе «${result.status}» — ` +
            `деньги списаны, заказ не изменён. Нужен возврат или ручная сверка.`,
        );
        break;
      default:
        break;
    }

    return json({ ok: true, duplicate: result.kind === "duplicate", accepted: result.kind === "paid" || result.kind === "cancelled" });
  } catch (err) {
    return errorResponse(err);
  }
}
