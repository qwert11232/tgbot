import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db, queryRows } from "@/db";
import { checkAdminLoginConfig, describeLoginFailure } from "@/lib/admin-login-errors";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Диагностика развёртывания: конфигурация + доступность БД + схема + владелец.
 *
 *   GET /api/health          — сводка (200, если всё в порядке; 503, если нет)
 *   GET /api/health?verbose=1 — с человеческими подсказками по каждой проблеме
 *
 * Никаких секретов не отдаёт: только «задано/не задано», длины и коды ошибок.
 * Нужен, чтобы на Vercel видеть причину «This page couldn't load» без логов.
 */

interface Check {
  name: string;
  ok: boolean;
  detail?: string;
  hint?: string;
}

const REQUIRED_ENV = ["DATABASE_URL", "ADMIN_SESSION_SECRET", "TG_SESSION_SECRET", "BOT_TOKEN", "APP_URL"];

const EXPECTED_TABLES = [
  "categories",
  "products",
  "product_images",
  "tg_users",
  "orders",
  "order_items",
  "payment_events",
  "staff_users",
  "staff_sessions",
  "rate_limits",
];

async function checkDatabase(): Promise<Check[]> {
  const checks: Check[] = [];

  try {
    await db.execute(sql`select 1`);
    checks.push({ name: "db:connection", ok: true });
  } catch (err) {
    const failure = describeLoginFailure(err);
    console.error("[health] db connection:", err);
    checks.push({ name: "db:connection", ok: false, detail: failure.code, hint: failure.message + " " + failure.hint });
    return checks;
  }

  try {
    const res = await db.execute(sql`
      select table_name from information_schema.tables where table_schema = 'public'
    `);
    const present = new Set(
      queryRows<{ table_name: string }>(res).map((r) => String(r.table_name).toLowerCase()),
    );
    const missing = EXPECTED_TABLES.filter((t) => !present.has(t));
    checks.push({
      name: "db:schema",
      ok: missing.length === 0,
      detail: missing.length === 0 ? `${present.size} таблиц` : `нет таблиц: ${missing.join(", ")}`,
      hint:
        missing.length === 0
          ? undefined
          : "Примените миграции: DATABASE_URL=<url> npx drizzle-kit migrate (или npm run db:push).",
    });
  } catch (err) {
    checks.push({ name: "db:schema", ok: false, detail: describeLoginFailure(err).code });
  }

  if (checks.every((c) => c.ok)) {
    try {
      const res = await db.execute(sql`select count(*)::int as staff, count(*) filter (where role = 'owner')::int as owners from staff_users`);
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
            : "Создайте владельца: DATABASE_URL=<url> ADMIN_EMAIL=... ADMIN_PASSWORD='...' npx tsx src/db/seed.ts",
      });
    } catch (err) {
      checks.push({ name: "db:owner_exists", ok: false, detail: describeLoginFailure(err).code });
    }
  }

  return checks;
}

export async function GET(req: NextRequest) {
  const verbose = req.nextUrl.searchParams.get("verbose") === "1";

  const configIssues = checkAdminLoginConfig(process.env, process.env.NODE_ENV);
  const configChecks: Check[] = configIssues.map((issue) => ({
    name: `config:${issue.code}`,
    ok: false,
    detail: issue.message,
    hint: issue.hint,
  }));

  const envChecks: Check[] = REQUIRED_ENV.map((name) => {
    const value = (process.env[name] ?? "").trim();
    return {
      name: `env:${name}`,
      ok: value.length > 0,
      detail: value.length > 0 ? `задано (${value.length} симв.)` : "не задано",
      hint: value.length > 0 ? undefined : `Добавьте ${name} в Environment Variables и сделайте Redeploy.`,
    };
  });

  const dbChecks = await checkDatabase();
  const checks = [...configChecks, ...envChecks, ...dbChecks];
  const ok = checks.every((c) => c.ok);

  return NextResponse.json(
    {
      ok,
      runtime: process.env.VERCEL ? "vercel" : "self-hosted",
      nodeEnv: process.env.NODE_ENV,
      checks: verbose ? checks : checks.map((c) => ({ name: c.name, ok: c.ok })),
      ...(ok || verbose ? {} : { next: "Откройте /api/health?verbose=1 — там подсказки по каждой проблеме." }),
    },
    { status: ok ? 200 : 503, headers: { "cache-control": "no-store" } },
  );
}
