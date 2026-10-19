import type { NextRequest } from "next/server";
import { and, eq } from "drizzle-orm";
import { db, withDbRetry } from "@/db";
import { orders, paymentEvents, tgUsers } from "@/db/schema";
import { json, errorResponse } from "@/lib/http";
import { answerPreCheckoutQuery, sendMessage, webAppKeyboard } from "@/lib/telegram-bot";
import { expectedInvoiceAmount } from "@/lib/payments";

export const dynamic = "force-dynamic";

interface TgUpdate {
  message?: {
    text?: string;
    chat: { id: number };
    successful_payment?: {
      invoice_payload?: string;
      currency?: string;
      total_amount?: number;
      telegram_payment_charge_id?: string;
      provider_payment_charge_id?: string;
    };
  };
  pre_checkout_query?: {
    id: string;
    invoice_payload?: string;
    currency?: string;
    total_amount?: number;
  };
}

const ORDER_PAYLOAD_RE = /^order_([0-9a-f-]{36})$/i;

/**
 * Вебхук Telegram Bot (НЕ long polling — только webhook на Vercel).
 * Защита: секретный заголовок X-Telegram-Bot-Api-Secret-Token (задаётся при
 * setWebhook). Платёжные события обрабатываются идемпотентно:
 * уникальный индекс payment_events(provider, external_event_id).
 */
export async function POST(req: NextRequest) {
  try {
    const expectedSecret = process.env.TELEGRAM_WEBHOOK_SECRET ?? "";
    const gotSecret = req.headers.get("x-telegram-bot-api-secret-token") ?? "";
    if (!expectedSecret || gotSecret !== expectedSecret) {
      return json({ ok: false, error: "forbidden" }, 401);
    }

    const update = (await req.json()) as TgUpdate;

    // /start — приветствие и кнопка открытия Mini App.
    const message = update.message;
    if (message?.text?.startsWith("/start")) {
      const appUrl = (process.env.APP_URL ?? "").replace(/\/+$/, "");
      await sendMessage(
        message.chat.id,
        "Добро пожаловать в «ГОРН» — магазин керамики ручной работы.\nКаталог, корзина и оплата — внутри мини-приложения.",
        appUrl ? { reply_markup: webAppKeyboard(`${appUrl}/app`) } : undefined,
      );
    }

    // pre_checkout_query — обязаны ответить в течение ~10 секунд.
    const pcq = update.pre_checkout_query;
    if (pcq) {
      const m = ORDER_PAYLOAD_RE.exec(pcq.invoice_payload ?? "");
      if (!m) {
        await answerPreCheckoutQuery(pcq.id, false, "Неизвестный заказ");
      } else {
        const [order] = await db.select().from(orders).where(eq(orders.id, m[1])).limit(1);
        if (!order) {
          await answerPreCheckoutQuery(pcq.id, false, "Заказ не найден");
        } else if (order.status !== "pending_payment") {
          await answerPreCheckoutQuery(pcq.id, false, "Заказ уже оплачен или отменён");
        } else {
          const expected = expectedInvoiceAmount(order);
          if (pcq.currency !== expected.currency || Number(pcq.total_amount) !== expected.amount) {
            await answerPreCheckoutQuery(pcq.id, false, "Сумма платежа не совпадает с заказом");
          } else {
            await answerPreCheckoutQuery(pcq.id, true);
          }
        }
      }
    }

    // successful_payment — фиксируем оплату идемпотентно.
    const sp = message?.successful_payment;
    if (sp) {
      const m = ORDER_PAYLOAD_RE.exec(sp.invoice_payload ?? "");
      const chargeId = sp.telegram_payment_charge_id ? String(sp.telegram_payment_charge_id) : "";
      if (m && chargeId) {
        const orderId = m[1];

        const processed = await withDbRetry(() =>
          db.transaction(async (tx) => {
            // Идемпотентность: одно платёжное событие обрабатывается ровно один раз.
            const inserted = await tx
              .insert(paymentEvents)
              .values({ provider: "telegram", externalEventId: chargeId, orderId, payload: update })
              .onConflictDoNothing()
              .returning({ id: paymentEvents.id });
            if (inserted.length === 0) return false;

            // Смена статуса — в той же транзакции и только из ожидаемого состояния.
            const updated = await tx
              .update(orders)
              .set({
                status: "paid",
                paidAt: new Date(),
                paymentProvider: sp.currency === "XTR" ? "telegram_stars" : "telegram_fiat",
                paymentChargeId: chargeId,
                updatedAt: new Date(),
              })
              .where(and(eq(orders.id, orderId), eq(orders.status, "pending_payment")))
              .returning({ id: orders.id });
            return updated.length > 0;
          }),
        );

        if (processed) {
          const [order] = await db.select().from(orders).where(eq(orders.id, orderId)).limit(1);
          if (order) {
            const [u] = await db.select().from(tgUsers).where(eq(tgUsers.id, order.userId)).limit(1);
            if (u) {
              await sendMessage(
                u.telegramId,
                `Оплата по заказу #${order.orderNumber} прошла успешно.\nМы начали собирать заказ — статус виден в мини-приложении.`,
              );
            }
            const adminChat = process.env.ADMIN_NOTIFY_CHAT_ID;
            if (adminChat) {
              await sendMessage(adminChat, `Новый оплаченный заказ #${order.orderNumber} на ${(order.totalMinor / 100).toFixed(2)} ₽`);
            }
          }
        }
      }
    }

    return json({ ok: true });
  } catch (err) {
    // Идемпотентная обработка позволяет безопасно попросить Telegram о retry (не-200).
    return errorResponse(err);
  }
}
