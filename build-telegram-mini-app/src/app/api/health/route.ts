import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db, queryRows } from "@/db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Диагностика развёртывания: конфигурация, подключение, схема, владелец.
 *
 *   GET /api/health           — сводка (200 если всё хорошо, иначе 503)
 *   GET /api/health?verbose=1 — с подсказками по каждой проблеме
 *
 * Секретов не раскрывает: только «задано/не задано» и длины.
 */

interface Check {
  name: string;
  ok: boolean;
  detail?: string;
  hint?: string;
}

const EXPECTED_TABLES = [
  "categories",
  "products",
  "product_images",
  "tg_users",
  "orders",
  "order_items",
  "payment_events",
  "idempotency_keys",
  "staff_users",
  "bot_states",
  "rate_limits",
];

const REQUIRED_ENV = ["DATABASE_URL", "BOT_TOKEN", "TELEGRAM_WEBHOOK_SECRET", "APP_URL", "ADMIN_TELEGRAM_ID"];

function describeDbError(err: unknown): string {
  const text = `${(err as { code?: string })?.code ?? ""} ${(err as Error)?.message ?? ""} ${String((err as { cause?: unknown })?.cause ?? "")}`;
  if (text.includes("ECONNREFUSED") || text.includes("ENOTFOUND") || text.includes("fetch failed")) return "db_unreachable";
  if (text.includes("28P01") || text.includes("password authentication failed")) return "db_auth_failed";
  if (text.includes("42P01") || text.includes("does not exist")) return "db_schema_missing";
  return "db_error";
}

async function checkDatabase(): Promise<Check[]> {
  const checks: Check[] = [];

  try {
    await db.execute(sql`select 1`);
    checks.push({ name: "db:connection", ok: true });
  } catch (err) {
    checks.push({
      name: "db:connection",
      ok: false,
      detail: describeDbError(err),
      hint: "Проверьте DATABASE_URL (строка подключения Neon) и что проект не приостановлен.",
    });
    return checks;
  }

  try {
    const res = await db.execute(sql`select table_name from information_schema.tables where table_schema = 'public'`);
    const present = new Set(queryRows<{ table_name: string }>(res).map((r) => String(r.table_name).toLowerCase()));
    const missing = EXPECTED_TABLES.filter((t) => !present.has(t));
    checks.push({
      name: "db:schema",
      ok: missing.length === 0,
      detail: missing.length === 0 ? `${present.size} таблиц` : `нет таблиц: ${missing.join(", ")}`,
      hint:
        missing.length === 0
          ? undefined
          : "Примените миграции: DATABASE_URL=<url> npx drizzle-kit migrate (или готовый SQL из README).",
    });
  } catch (err) {
    checks.push({ name: "db:schema", ok: false, detail: describeDbError(err) });
  }

  if (checks.every((c) => c.ok)) {
    try {
      const res = await db.execute(
        sql`select count(*)::int as staff, count(*) filter (where role = 'owner' and is_active)::int as owners from staff_users`,
      );
      const row = queryRows<{ staff: number | string; owners: number | string }>(res)[0];
      const staff = Number(row?.staff ?? 0);
      const owners = Number(row?.owners ?? 0);
      checks.push({
        name: "db:owner_exists",
        ok: owners > 0,
        detail: `сотрудников: ${staff}, владельцев: ${owners}`,
        hint:
          owners > 0
            ? undefined
            : "Задайте ADMIN_TELEGRAM_ID (ваш Telegram ID, узнать: /id в боте) и вызовите /admin в боте — владелец создастся сам. Либо: DATABASE_URL=<url> ADMIN_TELEGRAM_ID=<id> npx tsx src/db/seed.ts",
      });
    } catch (err) {
      checks.push({ name: "db:owner_exists", ok: false, detail: describeDbError(err) });
    }
  }

  return checks;
}

export async function GET(req: NextRequest) {
  const verbose = req.nextUrl.searchParams.get("verbose") === "1";

  const envChecks: Check[] = REQUIRED_ENV.map((name) => {
    const value = (process.env[name] ?? "").trim();
    return {
      name: `env:${name}`,
      ok: value.length > 0,
      detail: value.length > 0 ? `задано (${value.length} симв.)` : "не задано",
      hint: value.length > 0 ? undefined : `Добавьте ${name} в переменные окружения и сделайте Redeploy.`,
    };
  });

  const dbChecks = await checkDatabase();
  const checks = [...envChecks, ...dbChecks];
  const ok = checks.every((c) => c.ok);

  return NextResponse.json(
    {
      ok,
      runtime: process.env.VERCEL ? "vercel" : "self-hosted",
      nodeEnv: process.env.NODE_ENV,
      adminChannel: "telegram-bot",
      checks: verbose ? checks : checks.map((c) => ({ name: c.name, ok: c.ok })),
      ...(ok || verbose ? {} : { next: "Откройте /api/health?verbose=1 — там подсказки по каждой проблеме." }),
    },
    { status: ok ? 200 : 503, headers: { "cache-control": "no-store" } },
  );
}
