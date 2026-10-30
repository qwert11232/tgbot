import {
  pgTable,
  pgEnum,
  uuid,
  varchar,
  text,
  integer,
  bigint,
  bigserial,
  boolean,
  timestamp,
  jsonb,
  index,
  uniqueIndex,
  primaryKey,
} from "drizzle-orm/pg-core";

export const staffRoleEnum = pgEnum("staff_role", ["owner", "manager"]);

export const orderStatusEnum = pgEnum("order_status", [
  "pending_payment",
  "paid",
  "processing",
  "shipped",
  "delivered",
  "cancelled",
]);

export type OrderStatus = (typeof orderStatusEnum.enumValues)[number];
export type StaffRole = (typeof staffRoleEnum.enumValues)[number];

/* ---------------------------------- staff ---------------------------------- */

/**
 * Сотрудники. Админка живёт целиком в Telegram-боте, поэтому вход — по
 * telegram_id: бот узнаёт сотрудника по author.id апдейта. Ни email, ни паролей,
 * ни cookie больше нет. Роль owner/manager определяет доступные действия.
 */
export const staffUsers = pgTable(
  "staff_users",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    telegramId: bigint("telegram_id", { mode: "number" }).notNull(),
    name: varchar("name", { length: 120 }).notNull().default(""),
    role: staffRoleEnum("role").notNull().default("manager"),
    isActive: boolean("is_active").notNull().default(true),
    /** Присылать уведомления о новых заказах и оплатах. */
    notifications: boolean("notifications").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("staff_users_telegram_id_uq").on(t.telegramId)],
);

/**
 * Состояние диалога бота (ввод цены, остатка, добавление сотрудника и т.п.).
 * Хранится в БД, а не в памяти: serverless-инстансы не переносят состояние между
 * запросами, а рестарт не должен «терять» начатый ввод.
 */
export const botStates = pgTable("bot_states", {
  chatId: bigint("chat_id", { mode: "number" }).primaryKey(),
  staffId: uuid("staff_id").references(() => staffUsers.id, { onDelete: "cascade" }),
  state: varchar("state", { length: 40 }).notNull(),
  payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
});

/* ----------------------------- telegram users ----------------------------- */

export const tgUsers = pgTable(
  "tg_users",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    telegramId: bigint("telegram_id", { mode: "number" }).notNull(),
    username: varchar("username", { length: 64 }),
    firstName: varchar("first_name", { length: 128 }),
    lastName: varchar("last_name", { length: 128 }),
    languageCode: varchar("language_code", { length: 16 }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("tg_users_telegram_id_uq").on(t.telegramId)],
);

/* --------------------------------- catalog -------------------------------- */

export const categories = pgTable(
  "categories",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    name: varchar("name", { length: 160 }).notNull(),
    slug: varchar("slug", { length: 180 }).notNull(),
    sortOrder: integer("sort_order").notNull().default(0),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("categories_slug_uq").on(t.slug)],
);

export const products = pgTable(
  "products",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    categoryId: uuid("category_id").references(() => categories.id, { onDelete: "set null" }),
    name: varchar("name", { length: 220 }).notNull(),
    slug: varchar("slug", { length: 240 }).notNull(),
    description: text("description").notNull().default(""),
    /** Цена в минорных единицах (копейках). Одна валюта магазина — RUB. */
    priceMinor: integer("price_minor").notNull(),
    stock: integer("stock").notNull().default(0),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("products_slug_uq").on(t.slug),
    index("products_active_category_idx").on(t.isActive, t.categoryId),
    index("products_name_idx").on(t.name),
  ],
);

export const productImages = pgTable(
  "product_images",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    url: text("url").notNull(),
    sortOrder: integer("sort_order").notNull().default(0),
    isPrimary: boolean("is_primary").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (t) => [index("product_images_product_idx").on(t.productId, t.sortOrder)],
);

/* ---------------------------------- orders --------------------------------- */

export const orders = pgTable(
  "orders",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orderNumber: bigserial("order_number", { mode: "number" }).notNull(),
    userId: uuid("user_id")
      .notNull()
      .references(() => tgUsers.id, { onDelete: "restrict" }),
    status: orderStatusEnum("status").notNull().default("pending_payment"),
    totalMinor: integer("total_minor").notNull(),
    customerName: varchar("customer_name", { length: 200 }).notNull(),
    phone: varchar("phone", { length: 40 }).notNull(),
    address: text("address").notNull().default(""),
    comment: text("comment").notNull().default(""),
    /** telegram_stars | telegram_fiat | external | null */
    paymentProvider: varchar("payment_provider", { length: 24 }),
    paymentChargeId: text("payment_charge_id"),
    paidAt: timestamp("paid_at", { withTimezone: true, mode: "date" }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("orders_number_uq").on(t.orderNumber),
    index("orders_user_idx").on(t.userId, t.createdAt),
    index("orders_status_idx").on(t.status),
  ],
);

export const orderItems = pgTable(
  "order_items",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orderId: uuid("order_id")
      .notNull()
      .references(() => orders.id, { onDelete: "cascade" }),
    // productId может быть обнулён при удалении товара — снапшоты name/price сохраняют заказ.
    productId: uuid("product_id").references(() => products.id, { onDelete: "set null" }),
    productName: varchar("product_name", { length: 220 }).notNull(),
    priceMinor: integer("price_minor").notNull(),
    qty: integer("qty").notNull(),
  },
  (t) => [index("order_items_order_idx").on(t.orderId)],
);

/* ------------------------------ idempotency ------------------------------- */

export const idempotencyKeys = pgTable(
  "idempotency_keys",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => tgUsers.id, { onDelete: "cascade" }),
    key: varchar("key", { length: 80 }).notNull(),
    payloadHash: varchar("payload_hash", { length: 64 }).notNull(),
    orderId: uuid("order_id").references(() => orders.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.key], name: "idempotency_keys_pk" })],
);

/** Идемпотентность платёжных вебхуков: уникальный индекс (provider, external_event_id). */
export const paymentEvents = pgTable(
  "payment_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    provider: varchar("provider", { length: 24 }).notNull(),
    externalEventId: text("external_event_id").notNull(),
    orderId: uuid("order_id").references(() => orders.id, { onDelete: "set null" }),
    payload: jsonb("payload"),
    processedAt: timestamp("processed_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("payment_events_provider_event_uq").on(t.provider, t.externalEventId)],
);

/* ------------------------------- rate limit -------------------------------- */

export const rateLimits = pgTable("rate_limits", {
  key: varchar("key", { length: 191 }).primaryKey(),
  count: integer("count").notNull().default(0),
  windowStart: timestamp("window_start", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
});

/* ---------------------------------- types ---------------------------------- */

export type Product = typeof products.$inferSelect;
export type ProductImage = typeof productImages.$inferSelect;
export type Category = typeof categories.$inferSelect;
export type Order = typeof orders.$inferSelect;
export type OrderItem = typeof orderItems.$inferSelect;
export type StaffUser = typeof staffUsers.$inferSelect;
export type TgUser = typeof tgUsers.$inferSelect;
