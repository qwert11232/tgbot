import type { NextRequest } from "next/server";
import { z } from "zod";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import { db, queryRows, withDbRetry } from "@/db";
import { idempotencyKeys, orderItems, orders, products } from "@/db/schema";
import { getTgUserFromRequest } from "@/lib/telegram-auth";
import { json, errorResponse, HttpError } from "@/lib/http";
import { rateLimit, RATE_LIMITS } from "@/lib/rate-limit";
import { createOrderInvoiceLink, paymentsEnabled } from "@/lib/payments";
import { maybeExpireStaleOrders, orderExpiresAt } from "@/lib/orders/expire";
import { escapeHtml, formatRub, notifyAdmin } from "@/lib/notify";
import type { Order, OrderItem } from "@/db/schema";

export const dynamic = "force-dynamic";

const createOrderSchema = z.object({
  idempotencyKey: z.string().min(8).max(80),
  items: z
    .array(z.object({ productId: z.uuid(), qty: z.number().int().min(1).max(99) }))
    .min(1)
    .max(30),
  customerName: z.string().trim().min(2).max(200),
  phone: z.string().trim().min(5).max(40),
  address: z.string().trim().max(500).optional().default(""),
  comment: z.string().trim().max(500).optional().default(""),
});

function serializeOrder(order: Order, items: OrderItem[]) {
  return {
    payable: order.status === "pending_payment" && paymentsEnabled(),
    expiresAt: order.status === "pending_payment" ? orderExpiresAt(order.createdAt).toISOString() : null,
    id: order.id,
    orderNumber: order.orderNumber,
    status: order.status,
    totalMinor: order.totalMinor,
    customerName: order.customerName,
    phone: order.phone,
    address: order.address,
    comment: order.comment,
    paymentProvider: order.paymentProvider,
    paidAt: order.paidAt,
    createdAt: order.createdAt,
    items: items.map((i) => ({
      id: i.id,
      productId: i.productId,
      productName: i.productName,
      priceMinor: i.priceMinor,
      qty: i.qty,
    })),
  };
}

/** Мои заказы (Mini App). */
export async function GET(req: NextRequest) {
  try {
    const user = await getTgUserFromRequest(req);
    if (!user) throw new HttpError(401, "Требуется авторизация Telegram", "unauthorized");

    // Освобождаем остатки брошенных заказов, чтобы покупатель не видел
    // «Ожидает оплаты» по заказу, который уже отменён по таймауту.
    await maybeExpireStaleOrders();

    const myOrders = await db
      .select()
      .from(orders)
      .where(eq(orders.userId, user.id))
      .orderBy(desc(orders.createdAt))
      .limit(50);

    const ids = myOrders.map((o) => o.id);
    const items = ids.length
      ? await db.select().from(orderItems).where(inArray(orderItems.orderId, ids))
      : [];
    const byOrder = new Map<string, OrderItem[]>();
    for (const item of items) {
      const list = byOrder.get(item.orderId) ?? [];
      list.push(item);
      byOrder.set(item.orderId, list);
    }
    return json({ orders: myOrders.map((o) => serializeOrder(o, byOrder.get(o.id) ?? [])) });
  } catch (err) {
    return errorResponse(err);
  }
}

/**
 * Создание заказа.
 * - Идемпотентность по idempotencyKey: повтор с тем же содержимым вернёт тот же
 *   заказ; повтор с другим содержимым — 409 idempotency_conflict.
 * - Остатки списываются атомарно: UPDATE ... SET stock = stock - N WHERE stock >= N.
 * - Цены берутся из БД в момент транзакции (клиенту не доверяем).
 */
export async function POST(req: NextRequest) {
  try {
    const user = await getTgUserFromRequest(req);
    if (!user) throw new HttpError(401, "Требуется авторизация Telegram", "unauthorized");

    const rl = await rateLimit(`order-create:${user.id}`, RATE_LIMITS.orderCreate.limit, RATE_LIMITS.orderCreate.windowSec);
    if (!rl.ok) {
      throw new HttpError(429, `Слишком много заказов подряд. Повторите через ${rl.retryAfterSec} с.`, "rate_limited");
    }

    const body = createOrderSchema.parse(await req.json().catch(() => ({})));

    // Схлопываем дубликаты productId заранее (защита от double-spend одной позиции).
    const merged = new Map<string, number>();
    for (const it of body.items) {
      merged.set(it.productId, Math.min(99, (merged.get(it.productId) ?? 0) + it.qty));
    }

    const payloadHash = createHash("sha256")
      .update(
        JSON.stringify({
          items: [...merged.entries()].sort(([a], [b]) => (a < b ? -1 : 1)),
          customerName: body.customerName,
          phone: body.phone,
          address: body.address,
          comment: body.comment,
        }),
      )
      .digest("hex");

    const key = body.idempotencyKey;

    const result = await withDbRetry(() =>
      db.transaction(async (tx) => {
        // 1) Ключ идемпотентности — первой записью в транзакции (PK-блокировка сериализует гонки).
        const insertedKey = await tx
          .insert(idempotencyKeys)
          .values({ userId: user.id, key, payloadHash })
          .onConflictDoNothing()
          .returning();

        if (insertedKey.length === 0) {
          const [existing] = await tx
            .select()
            .from(idempotencyKeys)
            .where(and(eq(idempotencyKeys.userId, user.id), eq(idempotencyKeys.key, key)))
            .limit(1);
          if (!existing) throw new HttpError(409, "Запрос обрабатывается, повторите позже", "in_flight");
          if (existing.payloadHash !== payloadHash) {
            throw new HttpError(
              409,
              "Ключ идемпотентности уже использован с другим содержимым заказа",
              "idempotency_conflict",
            );
          }
          if (!existing.orderId) throw new HttpError(409, "Запрос обрабатывается, повторите позже", "in_flight");
          const [order] = await tx.select().from(orders).where(eq(orders.id, existing.orderId)).limit(1);
          const items = await tx.select().from(orderItems).where(eq(orderItems.orderId, order.id));
          return { order, items, reused: true as const };
        }

        // 2) Атомарное списание остатков каждой позиции.
        const lines: { productId: string; qty: number; name: string; priceMinor: number }[] = [];
        for (const [productId, qty] of merged) {
          const res = await tx.execute(sql`
            UPDATE products
            SET stock = stock - ${qty}, updated_at = now()
            WHERE id = ${productId} AND is_active = true AND stock >= ${qty}
            RETURNING id, name, price_minor
          `);
          const row = queryRows<{ id: string; name: string; price_minor: number }>(res)[0];
          if (!row) {
            const [p] = await tx
              .select({ name: products.name })
              .from(products)
              .where(eq(products.id, productId))
              .limit(1);
            throw new HttpError(
              409,
              p ? `Недостаточно товара на складе: «${p.name}»` : "Товар не найден или снят с продажи",
              "out_of_stock",
            );
          }
          lines.push({ productId, qty, name: row.name, priceMinor: Number(row.price_minor) });
        }

        // 3) Заказ + позиции + привязка ключа — в той же транзакции.
        const totalMinor = lines.reduce((sum, l) => sum + l.priceMinor * l.qty, 0);
        const [order] = await tx
          .insert(orders)
          .values({
            userId: user.id,
            status: "pending_payment",
            totalMinor,
            customerName: body.customerName,
            phone: body.phone,
            address: body.address,
            comment: body.comment,
          })
          .returning();
        await tx.insert(orderItems).values(
          lines.map((l) => ({
            orderId: order.id,
            productId: l.productId,
            productName: l.name,
            priceMinor: l.priceMinor,
            qty: l.qty,
          })),
        );
        await tx
          .update(idempotencyKeys)
          .set({ orderId: order.id })
          .where(and(eq(idempotencyKeys.userId, user.id), eq(idempotencyKeys.key, key)));

        return { order, items: [] as OrderItem[], reused: false as const };
      }),
    );

    // Повторный запрос — читаем позиции только для ответа (деньги не двигаются).
    let items = result.items;
    if (items.length === 0) {
      items = await db.select().from(orderItems).where(eq(orderItems.orderId, result.order.id));
    }

    // Новый заказ — уведомляем сотрудников в боте (best-effort, после коммита).
    if (!result.reused) {
      void notifyAdmin(
        `🆕 Новый заказ #${result.order.orderNumber} на ${formatRub(result.order.totalMinor)}\n` +
          `${escapeHtml(result.order.customerName)} · ${escapeHtml(result.order.phone)}`,
      );
    }

    // Инвойс Telegram Payments создаём вне транзакции (внешний вызов).
    let invoiceUrl: string | null = null;
    if (result.order.status === "pending_payment") {
      invoiceUrl = await createOrderInvoiceLink(result.order, items);
    }

    return json(
      { order: serializeOrder(result.order, items), invoiceUrl, reused: result.reused },
      result.reused ? 200 : 201,
    );
  } catch (err) {
    return errorResponse(err);
  }
}
