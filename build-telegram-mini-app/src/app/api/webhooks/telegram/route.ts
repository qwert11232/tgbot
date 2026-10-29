import type { NextRequest } from "next/server";
import crypto from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db, withDbRetry } from "@/db";
import { orders, paymentEvents, tgUsers } from "@/db/schema";
import { json, errorResponse } from "@/lib/http";
import { answerPreCheckoutQuery, sendMessage, webAppKeyboard } from "@/lib/telegram-bot";
import { expectedInvoiceAmount } from "@/lib/payments";
import { escapeHtml, formatRub, notifyAdmin } from "@/lib/notify";

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

/** Сравнение секрета вебхука в постоянном времени. */
function secretMatches(expected: string, actual: string): boolean {
  const a = Buffer.from(expected);
  const b = Buffer.from(actual);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

type PaymentOutcome =
  | { kind: "duplicate" }
  | { kind: "processed"; orderNumber: number; telegramId: number | null }
  | { kind: "amount_mismatch"; orderNumber: number; expected: { currency: string; amount: number }; got: { currency: string; amount: number } }
  | { kind: "already_paid"; orderNumber: number; status: string }
  | { kind: "cancelled_payment"; orderNumber: number }
  | { kind: "order_not_found" };

/**
 * Вебхук Telegram Bot (webhook, не long polling).
 * Защита: X-Telegram-Bot-Api-Secret-Token (задаётся в setWebhook).
 * Платёжные события идемпотентны: payment_events(provider, external_event_id).
 *
 * key-инварианты (см. TEST-REPORT.md):
 *  - successful_payment сверяется по сумме и валюте с ожидаемым инвойсом (P0-2);
 *  - оплата по отменённому заказу не «пропадает»: пишем событие и алертим админа (P1-7).
 */
export async function POST(req: NextRequest) {
  try {
    const expectedSecret = process.env.TELEGRAM_WEBHOOK_SECRET ?? "";
    const gotSecret = req.headers.get("x-telegram-bot-api-secret-token") ?? "";
    if (!expectedSecret || !secretMatches(expectedSecret, gotSecret)) {
      return json({ ok: false, error: "forbidden" }, 401);
    }

    const update = (await req.json().catch(() => ({}))) as TgUpdate;

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

    // successful_payment — фиксируем оплату идемпотентно и со сверкой суммы.
    const sp = message?.successful_payment;
    if (sp) {
      const m = ORDER_PAYLOAD_RE.exec(sp.invoice_payload ?? "");
      const chargeId = sp.telegram_payment_charge_id ? String(sp.telegram_payment_charge_id) : "";
      if (!m || !chargeId) {
        console.error("[payment] successful_payment без order payload или charge_id:", sp);
        return json({ ok: true });
      }

      const orderId = m[1];
      const [existing] = await db.select({ id: orders.id }).from(orders).where(eq(orders.id, orderId)).limit(1);

      const outcome = await withDbRetry<PaymentOutcome>(() =>
        db.transaction(async (tx): Promise<PaymentOutcome> => {
          // Блокировка заказа сериализует повторные доставки одного платежа.
          const [order] = await tx.select().from(orders).where(eq(orders.id, orderId)).for("update").limit(1);

          // Идемпотентность: одно платёжное событие обрабатывается ровно один раз.
          // Заказ мог быть удалён — тогда сохраняем событие с order_id = null (аудит).
          const inserted = await tx
            .insert(paymentEvents)
            .values({ provider: "telegram", externalEventId: chargeId, orderId: order?.id ?? null, payload: update })
            .onConflictDoNothing()
            .returning({ id: paymentEvents.id });
          if (inserted.length === 0) return { kind: "duplicate" };

          if (!order) return { kind: "order_not_found" };

          // Сверка денег: доверять total_amount из вебхука без проверки нельзя (P0-2).
          const expected = expectedInvoiceAmount(order);
          const got = { currency: String(sp.currency ?? ""), amount: Number(sp.total_amount ?? 0) };
          if (got.currency !== expected.currency || got.amount !== expected.amount) {
            return { kind: "amount_mismatch", orderNumber: order.orderNumber, expected, got };
          }

          if (order.status === "cancelled") {
            return { kind: "cancelled_payment", orderNumber: order.orderNumber };
          }
          if (order.status !== "pending_payment") {
            return { kind: "already_paid", orderNumber: order.orderNumber, status: order.status };
          }

          await tx
            .update(orders)
            .set({
              status: "paid",
              paidAt: new Date(),
              paymentProvider: got.currency === "XTR" ? "telegram_stars" : "telegram_fiat",
              paymentChargeId: chargeId,
              updatedAt: new Date(),
            })
            .where(and(eq(orders.id, order.id), eq(orders.status, "pending_payment")));

          const [buyer] = await tx
            .select({ telegramId: tgUsers.telegramId })
            .from(tgUsers)
            .where(eq(tgUsers.id, order.userId))
            .limit(1);

          return { kind: "processed", orderNumber: order.orderNumber, telegramId: buyer?.telegramId ?? null };
        }),
      );

      await handlePaymentOutcome(outcome, sp, orderId, Boolean(existing));
    }

    return json({ ok: true });
  } catch (err) {
    // Идемпотентная обработка позволяет безопасно попросить Telegram о retry (не-200).
    return errorResponse(err);
  }
}

async function handlePaymentOutcome(
  outcome: PaymentOutcome,
  sp: NonNullable<NonNullable<TgUpdate["message"]>["successful_payment"]>,
  orderId: string,
  orderExisted: boolean,
): Promise<void> {
  const amount = formatRub(Number(sp.total_amount ?? 0));

  switch (outcome.kind) {
    case "duplicate":
      return;

    case "processed": {
      if (outcome.telegramId) {
        await sendMessage(
          outcome.telegramId,
          `Оплата по заказу #${outcome.orderNumber} прошла успешно.\nМы начали собирать заказ — статус виден в мини-приложении.`,
        );
      }
      await notifyAdmin(`Новый оплаченный заказ #${outcome.orderNumber} на ${amount}`);
      return;
    }

    case "amount_mismatch":
      // Деньги пришли, но сумма/валюта не совпадают с заказом: не помечаем оплаченным.
      console.error("[payment] сумма не совпадает с заказом:", outcome);
      await notifyAdmin(
        `ВНИМАНИЕ: платёж ${amount} ${escapeHtml(outcome.got.currency)} по заказу #${outcome.orderNumber} ` +
          `не совпадает с ожидаемым ${formatRub(outcome.expected.amount)} ${escapeHtml(outcome.expected.currency)}. ` +
          `Заказ НЕ помечен оплаченным — проверьте платёж и свяжитесь с покупателем.`,
      );
      return;

    case "cancelled_payment":
      // Заказ отменён (истёк TTL или отменён вручную), а оплата всё же пришла.
      console.error("[payment] оплата по отменённому заказу:", outcome);
      await notifyAdmin(
        `ВНИМАНИЕ: оплата ${amount} по ОТМЕНЁННОМУ заказу #${outcome.orderNumber}. ` +
          `Деньги списаны, заказ остаётся отменённым — нужен возврат/связь с покупателем.`,
      );
      await notifyBuyerForOrder(orderId, (orderNumber) =>
        `По заказу #${orderNumber} пришла оплата, но заказ уже отменён (истекло время ожидания). ` +
          `Мы свяжемся с вами, чтобы вернуть платёж или переоформить заказ.`,
      );
      return;

    case "already_paid":
      // Повторная оплата того же заказа другим charge_id — возможен двойной платёж.
      await notifyAdmin(
        `ВНИМАНИЕ: повторная оплата ${amount} по заказу #${outcome.orderNumber} ` +
          `(текущий статус: ${escapeHtml(outcome.status)}). Возможен двойной платёж — проверьте.`,
      );
      return;

    case "order_not_found":
      console.error("[payment] платёж по неизвестному заказу:", { orderId, existed: orderExisted, sp });
      await notifyAdmin(
        `ВНИМАНИЕ: получен платёж ${amount} по неизвестному заказу ${escapeHtml(orderId)}. ` +
          `Событие сохранено в payment_events для разбора.`,
      );
      return;
  }
}

async function notifyBuyerForOrder(orderId: string, text: (orderNumber: number) => string): Promise<void> {
  try {
    const [row] = await db
      .select({ orderNumber: orders.orderNumber, telegramId: tgUsers.telegramId })
      .from(orders)
      .leftJoin(tgUsers, eq(orders.userId, tgUsers.id))
      .where(eq(orders.id, orderId))
      .limit(1);
    if (row?.telegramId) await sendMessage(row.telegramId, text(row.orderNumber));
  } catch (err) {
    console.error("[payment] notify buyer failed:", err);
  }
}
