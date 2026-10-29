import { sql } from "drizzle-orm";
import { db, queryRows } from "@/db";

export interface RateLimitResult {
  ok: boolean;
  retryAfterSec: number;
}

/**
 * Rate limiting на уровне БД (fixed window): атомарный INSERT ... ON CONFLICT.
 * Работает корректно при любом количестве serverless-инстансов Vercel,
 * в отличие от in-memory счётчиков. При недоступности БД — fail-open
 * (доступность важнее; ошибка логируется).
 */
export async function rateLimit(key: string, limit: number, windowSec: number): Promise<RateLimitResult> {
  void maybeCleanup();
  try {
    const res = await db.execute(sql`
      INSERT INTO rate_limits (key, count, window_start)
      VALUES (${key}, 1, now())
      ON CONFLICT (key) DO UPDATE SET
        count = CASE
          WHEN rate_limits.window_start < now() - make_interval(secs => ${windowSec})
          THEN 1 ELSE rate_limits.count + 1
        END,
        window_start = CASE
          WHEN rate_limits.window_start < now() - make_interval(secs => ${windowSec})
          THEN now() ELSE rate_limits.window_start
        END
      RETURNING count,
        extract(epoch from (rate_limits.window_start + make_interval(secs => ${windowSec}) - now()))::int AS retry_after
    `);
    const row = queryRows<{ count: number | string; retry_after: number | string }>(res)[0];
    if (!row) return { ok: true, retryAfterSec: 0 };
    const count = Number(row.count);
    if (count <= limit) return { ok: true, retryAfterSec: 0 };
    return { ok: false, retryAfterSec: Math.max(1, Number(row.retry_after)) };
  } catch (err) {
    console.error("[rate-limit] db error, fail-open:", err);
    return { ok: true, retryAfterSec: 0 };
  }
}

export const RATE_LIMITS = {
  adminLogin: { limit: 8, windowSec: 600 },
  tgAuth: { limit: 20, windowSec: 300 },
  orderCreate: { limit: 10, windowSec: 600 },
  invoice: { limit: 20, windowSec: 600 },
  adminUpload: { limit: 30, windowSec: 600 },
} as const;

/**
 * Чистка устаревших счётчиков: без неё таблица rate_limits растёт бесконечно
 * (дефект P2-25). «Замок» — строка __cleanup__ в той же таблице: атомарно и
 * одинаково для всех инстансов (in-memory флаг на serverless не работает).
 * Чистка идёт не чаще раза в 10 минут и не мешает основной операции.
 */
const CLEANUP_KEY = "__cleanup__";
async function maybeCleanup(): Promise<void> {
  try {
    const res = await db.execute(sql`
      INSERT INTO rate_limits (key, count, window_start)
      VALUES (${CLEANUP_KEY}, 1, now())
      ON CONFLICT (key) DO UPDATE SET count = 1, window_start = now()
      WHERE rate_limits.window_start < now() - interval '10 minutes'
      RETURNING key
    `);
    if (queryRows(res).length === 0) return; // замок занят другим инстансом
    await db.execute(sql`DELETE FROM rate_limits WHERE window_start < now() - interval '1 day' AND key <> ${CLEANUP_KEY}`);
    await db.execute(sql`DELETE FROM rate_limits WHERE key = ${CLEANUP_KEY} AND window_start < now() - interval '1 day'`);
  } catch (err) {
    console.error("[rate-limit] cleanup failed:", err);
  }
}
