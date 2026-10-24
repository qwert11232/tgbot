import type { NextRequest } from "next/server";
import { asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { orderItems, orders } from "@/db/schema";
import { getTgUserFromRequest } from "@/lib/telegram-auth";
import { json, errorResponse, HttpError } from "@/lib/http";
import { rateLimit, RATE_LIMITS } from "@/lib/rate-limit";
import { createOrderInvoiceLink, paymentsEnabled } from "@/lib/payments";
import { orderExpiresAt } from "@/lib/orders/expire";

export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f-]{36}$/i;

/**
 * Ссылка на оплату уже созданного заказа (повторный вход в платёжное окно).
 *
 * Раньше ссылка на инвойс существовала только в ответе POST /api/orders: если
 * покупатель закрыл окно оплаты или ушёл со страницы, оплатить заказ было
 * невозможно (дефект P0-3). Теперь Mini App запрашивает ссылку по требованию.
 *
 * Правила: только владелец заказа, только pending_payment, только пока не истёк TTL.
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await getTgUserFromRequest(req);
    if (!user) throw new HttpError(401, "Требуется авторизация Telegram", "unauthorized");

    const { id } = await ctx.params;
    if (!UUID_RE.test(id)) throw new HttpError(400, "Некорректный id заказа", "bad_id");

    const rl = await rateLimit(`invoice:${user.id}`, RATE_LIMITS.invoice.limit, RATE_LIMITS.invoice.windowSec);
    if (!rl.ok) {
      throw new HttpError(429, `Слишком много запросов на оплату. Повторите через ${rl.retryAfterSec} с.`, "rate_limited");
    }

    if (!paymentsEnabled()) {
      throw new HttpError(503, "Оплата временно недоступна. Напишите нам в бот.", "payments_disabled");
    }

    const [order] = await db.select().from(orders).where(eq(orders.id, id)).limit(1);
    if (!order || order.userId !== user.id) throw new HttpError(404, "Заказ не найден", "not_found");
    if (order.status !== "pending_payment") {
      throw new HttpError(409, "Заказ уже оплачен или отменён", "not_payable");
    }
    if (orderExpiresAt(order.createdAt).getTime() <= Date.now()) {
      throw new HttpError(409, "Время оплаты заказа истекло. Соберите корзину заново.", "expired");
    }

    const items = await db
      .select()
      .from(orderItems)
      .where(eq(orderItems.orderId, order.id))
      .orderBy(asc(orderItems.productName));

    const invoiceUrl = await createOrderInvoiceLink(order, items);
    if (!invoiceUrl) {
      throw new HttpError(502, "Не удалось создать ссылку на оплату. Попробуйте позже.", "invoice_failed");
    }

    return json({
      invoiceUrl,
      order: { id: order.id, orderNumber: order.orderNumber, totalMinor: order.totalMinor },
      expiresAt: orderExpiresAt(order.createdAt).toISOString(),
    });
  } catch (err) {
    return errorResponse(err);
  }
}
