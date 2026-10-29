import { and, desc, eq, gte, inArray, isNotNull, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  orderItems,
  orders,
  productImages,
  products,
  staffUsers,
  tgUsers,
  type OrderStatus,
  type StaffRole,
} from "@/db/schema";
import { ORDER_TRANSITIONS, RESTOCK_ON_CANCEL_FROM } from "@/lib/order-transitions";
import { statusLabel } from "@/lib/format";
import { sendMessage } from "@/lib/telegram-bot";
import { uniqueSlug } from "@/lib/slug";
import { saveImage, StorageNotConfiguredError } from "@/lib/storage";
import { detectImageByMagicBytes, MAX_IMAGE_BYTES } from "@/lib/image-validation";

/**
 * Операции админки. Никакой привязки к Telegram UI — только БД и бизнес-правила,
 * поэтому их можно покрыть тестами напрямую. Ошибки бросаются с человеческим
 * текстом (AdminError), бот показывает его сотруднику как есть.
 */

export class AdminError extends Error {
  constructor(
    message: string,
    readonly status: number = 400,
  ) {
    super(message);
    this.name = "AdminError";
  }
}

/* --------------------------------- сотрудники -------------------------------- */

export interface Staff {
  id: string;
  telegramId: number;
  name: string;
  role: StaffRole;
  isActive: boolean;
  notifications: boolean;
}

export async function findStaff(telegramId: number): Promise<Staff | null> {
  const [row] = await db
    .select()
    .from(staffUsers)
    .where(and(eq(staffUsers.telegramId, telegramId), eq(staffUsers.isActive, true)))
    .limit(1);
  return row ? toStaff(row) : null;
}

export async function listStaff(): Promise<Staff[]> {
  const rows = await db.select().from(staffUsers).orderBy(desc(staffUsers.createdAt));
  return rows.map(toStaff);
}

function toStaff(row: typeof staffUsers.$inferSelect): Staff {
  return {
    id: row.id,
    telegramId: Number(row.telegramId),
    name: row.name,
    role: row.role,
    isActive: row.isActive,
    notifications: row.notifications,
  };
}

/** Первичный владелец из env — создаётся/чинится при каждом /admin. */
export async function ensureOwnerFromEnv(): Promise<Staff | null> {
  const raw = (process.env.ADMIN_TELEGRAM_ID ?? "").trim();
  if (!raw) return null;
  const telegramId = Number(raw);
  if (!Number.isFinite(telegramId) || telegramId <= 0) return null;

  const [existing] = await db.select().from(staffUsers).where(eq(staffUsers.telegramId, telegramId)).limit(1);
  if (existing) {
    if (existing.role !== "owner" || !existing.isActive) {
      const [fixed] = await db
        .update(staffUsers)
        .set({ role: "owner", isActive: true, updatedAt: new Date() })
        .where(eq(staffUsers.id, existing.id))
        .returning();
      return toStaff(fixed);
    }
    return toStaff(existing);
  }

  const [created] = await db
    .insert(staffUsers)
    .values({ telegramId, name: "Владелец", role: "owner" })
    .returning();
  return toStaff(created);
}

export async function addStaff(input: {
  telegramId: number;
  name?: string;
  role?: StaffRole;
}): Promise<Staff> {
  if (!Number.isFinite(input.telegramId) || input.telegramId <= 0) {
    throw new AdminError("Некорректный Telegram ID");
  }
  const [existing] = await db
    .select()
    .from(staffUsers)
    .where(eq(staffUsers.telegramId, input.telegramId))
    .limit(1);
  if (existing) {
    const [updated] = await db
      .update(staffUsers)
      .set({
        role: input.role ?? existing.role,
        name: input.name || existing.name,
        isActive: true,
        updatedAt: new Date(),
      })
      .where(eq(staffUsers.id, existing.id))
      .returning();
    return toStaff(updated);
  }
  const [created] = await db
    .insert(staffUsers)
    .values({
      telegramId: input.telegramId,
      name: (input.name ?? "").trim(),
      role: input.role ?? "manager",
    })
    .returning();
  return toStaff(created);
}

export async function setStaffActive(staffId: string, active: boolean): Promise<Staff> {
  if (!active) {
    const [target] = await db.select().from(staffUsers).where(eq(staffUsers.id, staffId)).limit(1);
    if (!target) throw new AdminError("Сотрудник не найден", 404);
    if (target.role === "owner") {
      const owners = await db
        .select({ id: staffUsers.id })
        .from(staffUsers)
        .where(and(eq(staffUsers.role, "owner"), eq(staffUsers.isActive, true)));
      if (owners.length <= 1) throw new AdminError("Нельзя отключить последнего владельца");
    }
  }
  const [updated] = await db
    .update(staffUsers)
    .set({ isActive: active, updatedAt: new Date() })
    .where(eq(staffUsers.id, staffId))
    .returning();
  if (!updated) throw new AdminError("Сотрудник не найден", 404);
  return toStaff(updated);
}

export async function toggleNotifications(telegramId: number): Promise<boolean> {
  const [row] = await db.select().from(staffUsers).where(eq(staffUsers.telegramId, telegramId)).limit(1);
  if (!row) throw new AdminError("Сотрудник не найден", 404);
  const [updated] = await db
    .update(staffUsers)
    .set({ notifications: !row.notifications, updatedAt: new Date() })
    .where(eq(staffUsers.id, row.id))
    .returning();
  return updated.notifications;
}

/* ----------------------------------- заказы ---------------------------------- */

export interface OrderRow {
  id: string;
  orderNumber: number;
  status: OrderStatus;
  totalMinor: number;
  customerName: string;
  phone: string;
  address: string;
  comment: string;
  createdAt: Date;
  paidAt: Date | null;
}

const ORDER_PAGE_SIZE = 8;

export async function listOrders(options: { status?: OrderStatus; page?: number } = {}): Promise<{
  rows: OrderRow[];
  total: number;
  page: number;
  pageSize: number;
}> {
  const page = Math.max(1, Math.floor(options.page ?? 1));
  const where = options.status ? eq(orders.status, options.status) : undefined;

  const rows = await db
    .select({
      id: orders.id,
      orderNumber: orders.orderNumber,
      status: orders.status,
      totalMinor: orders.totalMinor,
      customerName: orders.customerName,
      phone: orders.phone,
      address: orders.address,
      comment: orders.comment,
      createdAt: orders.createdAt,
      paidAt: orders.paidAt,
    })
    .from(orders)
    .where(where)
    .orderBy(desc(orders.createdAt))
    .limit(ORDER_PAGE_SIZE)
    .offset((page - 1) * ORDER_PAGE_SIZE);

  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(orders)
    .where(where);

  return { rows, total: Number(count), page, pageSize: ORDER_PAGE_SIZE };
}

export interface OrderDetails extends OrderRow {
  items: { name: string; qty: number; priceMinor: number }[];
  buyerTelegramId: number | null;
}

export async function getOrder(orderId: string): Promise<OrderDetails | null> {
  const [order] = await db
    .select()
    .from(orders)
    .where(eq(orders.id, orderId))
    .limit(1);
  if (!order) return null;

  const items = await db
    .select({ name: orderItems.productName, qty: orderItems.qty, priceMinor: orderItems.priceMinor })
    .from(orderItems)
    .where(eq(orderItems.orderId, order.id));

  const [buyer] = await db
    .select({ telegramId: tgUsers.telegramId })
    .from(tgUsers)
    .where(eq(tgUsers.id, order.userId))
    .limit(1);

  return {
    id: order.id,
    orderNumber: order.orderNumber,
    status: order.status,
    totalMinor: order.totalMinor,
    customerName: order.customerName,
    phone: order.phone,
    address: order.address,
    comment: order.comment,
    createdAt: order.createdAt,
    paidAt: order.paidAt,
    items,
    buyerTelegramId: buyer ? Number(buyer.telegramId) : null,
  };
}

export async function findOrderByNumber(orderNumber: number): Promise<OrderDetails | null> {
  const [row] = await db.select({ id: orders.id }).from(orders).where(eq(orders.orderNumber, orderNumber)).limit(1);
  return row ? getOrder(row.id) : null;
}

/**
 * Смена статуса с соблюдением графа переходов и возвратом остатков при отмене.
 * Строка заказа блокируется — параллельные нажатия в боте не разъедутся.
 */
export async function updateOrderStatus(orderId: string, next: OrderStatus): Promise<{ orderNumber: number; status: OrderStatus }> {
  if (!Object.keys(ORDER_TRANSITIONS).includes(next)) throw new AdminError("Неизвестный статус");
  if (!/^[0-9a-f-]{36}$/i.test(orderId)) throw new AdminError("Некорректный id заказа");

  const result = await db.transaction(async (tx) => {
    const [order] = await tx.select().from(orders).where(eq(orders.id, orderId)).for("update").limit(1);
    if (!order) throw new AdminError("Заказ не найден", 404);
    if (order.status === next) throw new AdminError(`Заказ уже в статусе «${statusLabel(next)}»`);
    if (!ORDER_TRANSITIONS[order.status].includes(next)) {
      throw new AdminError(`Переход «${statusLabel(order.status)}» → «${statusLabel(next)}» недопустим`, 409);
    }

    if (next === "cancelled" && RESTOCK_ON_CANCEL_FROM.includes(order.status)) {
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
        status: next,
        updatedAt: new Date(),
        ...(next === "paid" && order.status === "pending_payment"
          ? { paidAt: new Date(), paymentProvider: order.paymentProvider ?? "external" }
          : {}),
      })
      .where(eq(orders.id, order.id));

    return { orderNumber: order.orderNumber, status: next, userId: order.userId };
  });

  // Покупателю — best-effort уведомление, уже после коммита.
  const [buyer] = await db.select().from(tgUsers).where(eq(tgUsers.id, result.userId)).limit(1);
  if (buyer) {
    void sendMessage(
      Number(buyer.telegramId),
      `Заказ #${result.orderNumber}: новый статус — «${statusLabel(result.status)}».`,
    ).catch(() => undefined);
  }

  return { orderNumber: result.orderNumber, status: result.status };
}

export function allowedNextStatuses(status: OrderStatus): OrderStatus[] {
  return ORDER_TRANSITIONS[status] ?? [];
}

/* ----------------------------------- товары ---------------------------------- */

export interface ProductRow {
  id: string;
  name: string;
  slug: string;
  priceMinor: number;
  stock: number;
  isActive: boolean;
  imageUrl: string | null;
}

const PRODUCT_PAGE_SIZE = 8;

export async function listProducts(page = 1): Promise<{
  rows: ProductRow[];
  total: number;
  page: number;
  pageSize: number;
}> {
  const safePage = Math.max(1, Math.floor(page));
  const rows = await db
    .select({
      id: products.id,
      name: products.name,
      slug: products.slug,
      priceMinor: products.priceMinor,
      stock: products.stock,
      isActive: products.isActive,
      imageUrl: sql<string | null>`(
        select url from product_images
        where product_id = ${products.id}
        order by is_primary desc, sort_order asc
        limit 1
      )`,
    })
    .from(products)
    .orderBy(desc(products.createdAt))
    .limit(PRODUCT_PAGE_SIZE)
    .offset((safePage - 1) * PRODUCT_PAGE_SIZE);

  const [{ count }] = await db.select({ count: sql<number>`count(*)::int` }).from(products);
  return { rows, total: Number(count), page: safePage, pageSize: PRODUCT_PAGE_SIZE };
}

export async function getProduct(productId: string): Promise<ProductRow | null> {
  const [row] = await db
    .select({
      id: products.id,
      name: products.name,
      slug: products.slug,
      priceMinor: products.priceMinor,
      stock: products.stock,
      isActive: products.isActive,
      imageUrl: sql<string | null>`(
        select url from product_images
        where product_id = ${products.id}
        order by is_primary desc, sort_order asc
        limit 1
      )`,
    })
    .from(products)
    .where(eq(products.id, productId))
    .limit(1);
  return row ?? null;
}

export async function setProductPrice(productId: string, priceMinor: number): Promise<ProductRow> {
  if (!Number.isInteger(priceMinor) || priceMinor < 0 || priceMinor > 100_000_000) {
    throw new AdminError("Цена должна быть неотрицательным числом (в рублях, например 1890)");
  }
  const [row] = await db
    .update(products)
    .set({ priceMinor, updatedAt: new Date() })
    .where(eq(products.id, productId))
    .returning({ id: products.id });
  if (!row) throw new AdminError("Товар не найден", 404);
  return (await getProduct(productId))!;
}

export async function setProductStock(productId: string, stock: number): Promise<ProductRow> {
  if (!Number.isInteger(stock) || stock < 0 || stock > 1_000_000) {
    throw new AdminError("Остаток должен быть целым неотрицательным числом");
  }
  const [row] = await db
    .update(products)
    .set({ stock, updatedAt: new Date() })
    .where(eq(products.id, productId))
    .returning({ id: products.id });
  if (!row) throw new AdminError("Товар не найден", 404);
  return (await getProduct(productId))!;
}

export async function toggleProductActive(productId: string): Promise<ProductRow> {
  const current = await getProduct(productId);
  if (!current) throw new AdminError("Товар не найден", 404);
  await db
    .update(products)
    .set({ isActive: !current.isActive, updatedAt: new Date() })
    .where(eq(products.id, productId));
  return (await getProduct(productId))!;
}

export async function createProduct(input: {
  name: string;
  priceMinor: number;
  stock?: number;
}): Promise<ProductRow> {
  const name = input.name.trim();
  if (name.length < 2 || name.length > 220) throw new AdminError("Название — от 2 до 220 символов");
  if (!Number.isInteger(input.priceMinor) || input.priceMinor < 0) throw new AdminError("Некорректная цена");
  const stock = input.stock ?? 0;
  if (!Number.isInteger(stock) || stock < 0) throw new AdminError("Некорректный остаток");

  // Уникальность обеспечивается случайным суффиксом; повтор имени не блокирует создание.
  const slug = uniqueSlug(name);

  const [created] = await db
    .insert(products)
    .values({ name, slug, priceMinor: input.priceMinor, stock, isActive: true, description: "" })
    .returning({ id: products.id });

  return (await getProduct(created.id))!;
}

export async function setProductImage(productId: string, buf: Buffer): Promise<ProductRow> {
  const product = await getProduct(productId);
  if (!product) throw new AdminError("Товар не найден", 404);
  if (buf.length > MAX_IMAGE_BYTES) throw new AdminError("Файл больше 5 МБ");

  const detected = detectImageByMagicBytes(buf);
  if (!detected) throw new AdminError("Это не изображение (поддерживаются JPEG, PNG, WebP, GIF)");

  let url: string;
  try {
    ({ url } = await saveImage(buf, detected.ext, detected.mime));
  } catch (err) {
    if (err instanceof StorageNotConfiguredError) {
      throw new AdminError("Хранилище не настроено: задайте BLOB_READ_WRITE_TOKEN в переменных окружения", 503);
    }
    throw err;
  }

  // Новое фото становится главным, но старые не удаляем — их можно вернуть вручную.
  await db.update(productImages).set({ isPrimary: false }).where(eq(productImages.productId, productId));
  await db.insert(productImages).values({ productId, url, sortOrder: 0, isPrimary: true });
  return (await getProduct(productId))!;
}

/* ------------------------------- уведомления ------------------------------- */

/** Рассылка уведомления всем активным сотрудникам с включёнными оповещениями. */
export async function notifyStaff(text: string): Promise<void> {
  const rows = await listStaff();
  const targets = rows.filter((s) => s.isActive && s.notifications).map((s) => s.telegramId);
  await Promise.all(targets.map((id) => sendMessage(id, text).catch(() => undefined)));
}

/* ---------------------------------- отчёты ---------------------------------- */

export interface RevenueReport {
  todayMinor: number;
  todayOrders: number;
  weekMinor: number;
  weekOrders: number;
  averageMinor: number;
  topProducts: { name: string; qty: number; revenueMinor: number }[];
}

const PAID_STATUSES: OrderStatus[] = ["paid", "processing", "shipped", "delivered"];

export async function revenueReport(now = new Date()): Promise<RevenueReport> {
  const startOfDay = new Date(now);
  startOfDay.setHours(0, 0, 0, 0);
  const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

  const [today] = await db
    .select({
      total: sql<number>`coalesce(sum(${orders.totalMinor}), 0)::int`,
      count: sql<number>`count(*)::int`,
    })
    .from(orders)
    .where(and(inArray(orders.status, PAID_STATUSES), gte(orders.createdAt, startOfDay)));

  const [week] = await db
    .select({
      total: sql<number>`coalesce(sum(${orders.totalMinor}), 0)::int`,
      count: sql<number>`count(*)::int`,
    })
    .from(orders)
    .where(and(inArray(orders.status, PAID_STATUSES), gte(orders.createdAt, weekAgo)));

  const top = await db
    .select({
      name: orderItems.productName,
      qty: sql<number>`sum(${orderItems.qty})::int`,
      revenue: sql<number>`sum(${orderItems.qty} * ${orderItems.priceMinor})::int`,
    })
    .from(orderItems)
    .innerJoin(orders, eq(orderItems.orderId, orders.id))
    .where(and(inArray(orders.status, PAID_STATUSES), gte(orders.createdAt, weekAgo), isNotNull(orderItems.productName)))
    .groupBy(orderItems.productName)
    .orderBy(sql`sum(${orderItems.qty}) desc`)
    .limit(5);

  const weekOrders = Number(week?.count ?? 0);
  return {
    todayMinor: Number(today?.total ?? 0),
    todayOrders: Number(today?.count ?? 0),
    weekMinor: Number(week?.total ?? 0),
    weekOrders,
    averageMinor: weekOrders > 0 ? Math.round(Number(week?.total ?? 0) / weekOrders) : 0,
    topProducts: top.map((t) => ({ name: t.name, qty: Number(t.qty), revenueMinor: Number(t.revenue) })),
  };
}
