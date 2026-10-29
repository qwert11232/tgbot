-- ============================================================================
--  ГОРН — схема базы Neon + владелец админки (админка живёт в Telegram-боте)
--
--  Когда нужен этот файл: приложение пишет «База данных подключена, но схема
--  не создана» (или health показывает db:schema = false). Запускать в Neon →
--  SQL Editor нужной ветки (той, на которую смотрит деплой Vercel), затем Run.
--
--  ПЕРЕД ЗАПУСКОМ: замените Telegram ID в блоке «ВЛАДЕЛЕЦ» (поиск по слову).
--  Узнать свой ID: открыть бота и отправить /id.
--
--  Рассчитан на чистую базу. Если таблицы уже есть — ничего не запускайте
--  повторно, используйте npx drizzle-kit migrate.
-- ============================================================================

BEGIN;

CREATE TYPE "public"."order_status" AS ENUM('pending_payment', 'paid', 'processing', 'shipped', 'delivered', 'cancelled');
CREATE TYPE "public"."staff_role" AS ENUM('owner', 'manager');
CREATE TABLE "bot_states" (
	"chat_id" bigint PRIMARY KEY NOT NULL,
	"staff_id" uuid,
	"state" varchar(40) NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "categories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(160) NOT NULL,
	"slug" varchar(180) NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "idempotency_keys" (
	"user_id" uuid NOT NULL,
	"key" varchar(80) NOT NULL,
	"payload_hash" varchar(64) NOT NULL,
	"order_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "idempotency_keys_pk" PRIMARY KEY("user_id","key")
);

CREATE TABLE "order_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"product_id" uuid,
	"product_name" varchar(220) NOT NULL,
	"price_minor" integer NOT NULL,
	"qty" integer NOT NULL
);

CREATE TABLE "orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_number" bigserial NOT NULL,
	"user_id" uuid NOT NULL,
	"status" "order_status" DEFAULT 'pending_payment' NOT NULL,
	"total_minor" integer NOT NULL,
	"customer_name" varchar(200) NOT NULL,
	"phone" varchar(40) NOT NULL,
	"address" text DEFAULT '' NOT NULL,
	"comment" text DEFAULT '' NOT NULL,
	"payment_provider" varchar(24),
	"payment_charge_id" text,
	"paid_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "payment_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" varchar(24) NOT NULL,
	"external_event_id" text NOT NULL,
	"order_id" uuid,
	"payload" jsonb,
	"processed_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "product_images" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"product_id" uuid NOT NULL,
	"url" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_primary" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "products" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"category_id" uuid,
	"name" varchar(220) NOT NULL,
	"slug" varchar(240) NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"price_minor" integer NOT NULL,
	"stock" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "rate_limits" (
	"key" varchar(191) PRIMARY KEY NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	"window_start" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "staff_users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"telegram_id" bigint NOT NULL,
	"name" varchar(120) DEFAULT '' NOT NULL,
	"role" "staff_role" DEFAULT 'manager' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"notifications" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "tg_users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"telegram_id" bigint NOT NULL,
	"username" varchar(64),
	"first_name" varchar(128),
	"last_name" varchar(128),
	"language_code" varchar(16),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE "bot_states" ADD CONSTRAINT "bot_states_staff_id_staff_users_id_fk" FOREIGN KEY ("staff_id") REFERENCES "public"."staff_users"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "idempotency_keys" ADD CONSTRAINT "idempotency_keys_user_id_tg_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."tg_users"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "idempotency_keys" ADD CONSTRAINT "idempotency_keys_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE set null ON UPDATE no action;
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE set null ON UPDATE no action;
ALTER TABLE "orders" ADD CONSTRAINT "orders_user_id_tg_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."tg_users"("id") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "payment_events" ADD CONSTRAINT "payment_events_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE set null ON UPDATE no action;
ALTER TABLE "product_images" ADD CONSTRAINT "product_images_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "products" ADD CONSTRAINT "products_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE set null ON UPDATE no action;
CREATE UNIQUE INDEX "categories_slug_uq" ON "categories" USING btree ("slug");
CREATE INDEX "order_items_order_idx" ON "order_items" USING btree ("order_id");
CREATE UNIQUE INDEX "orders_number_uq" ON "orders" USING btree ("order_number");
CREATE INDEX "orders_user_idx" ON "orders" USING btree ("user_id","created_at");
CREATE INDEX "orders_status_idx" ON "orders" USING btree ("status");
CREATE UNIQUE INDEX "payment_events_provider_event_uq" ON "payment_events" USING btree ("provider","external_event_id");
CREATE INDEX "product_images_product_idx" ON "product_images" USING btree ("product_id","sort_order");
CREATE UNIQUE INDEX "products_slug_uq" ON "products" USING btree ("slug");
CREATE INDEX "products_active_category_idx" ON "products" USING btree ("is_active","category_id");
CREATE INDEX "products_name_idx" ON "products" USING btree ("name");
CREATE UNIQUE INDEX "staff_users_telegram_id_uq" ON "staff_users" USING btree ("telegram_id");
CREATE UNIQUE INDEX "tg_users_telegram_id_uq" ON "tg_users" USING btree ("telegram_id");

-- ============================================================================
--  ВЛАДЕЛЕЦ  (замените 123456789 на свой Telegram ID)
-- ============================================================================
INSERT INTO "staff_users" ("telegram_id", "name", "role")
VALUES (123456789, 'Владелец', 'owner')
ON CONFLICT ("telegram_id") DO UPDATE
  SET "role" = 'owner', "is_active" = true, "updated_at" = now();

-- ============================================================================
--  Учёт миграций: чтобы npx drizzle-kit migrate не накатывал 0000_init повторно
-- ============================================================================
CREATE SCHEMA IF NOT EXISTS "drizzle";

CREATE TABLE IF NOT EXISTS "drizzle"."__drizzle_migrations" (
  id SERIAL PRIMARY KEY,
  hash text NOT NULL,
  created_at bigint
);

INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at")
SELECT '2273c873c6eb5890e1702bacbd3136df44d9c7b77a0740a611b7eea6856bd4b1', 1793286589315
WHERE NOT EXISTS (SELECT 1 FROM "drizzle"."__drizzle_migrations" WHERE "hash" = '2273c873c6eb5890e1702bacbd3136df44d9c7b77a0740a611b7eea6856bd4b1');

COMMIT;

-- ============================================================================
--  ПРОВЕРКА (отдельным запросом после COMMIT):
--  ожидается tables = 11, владельцев = 1
-- ============================================================================
-- SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public';
-- SELECT telegram_id, role, is_active FROM staff_users;
