import { drizzle as drizzleNodePg, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { drizzle as drizzleNeonServerless } from "drizzle-orm/neon-serverless";
import { drizzle as drizzleNeonHttp } from "drizzle-orm/neon-http";
import { Pool as NeonPool, neon, neonConfig } from "@neondatabase/serverless";
import { Pool as PgPool } from "pg";
import ws from "ws";
import * as schema from "./schema";

const databaseUrl: string = (() => {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required");
  return url;
})();

/**
 * Production (Vercel) — Neon: URL вида *.neon.tech.
 *   - neon-serverless Pool (WebSocket) для интерактивных транзакций;
 *   - neon-http для простых чтений без транзакций;
 *   - withDbRetry() переживает обрыв WebSocket после «заморозки» serverless-контейнера.
 * Локально — обычный PostgreSQL через node-postgres (тот же интерфейс Drizzle).
 */
export const isNeon =
  /neon\.tech|neon\.dev/i.test(databaseUrl) || process.env.DB_DRIVER === "neon";

export type Db = NodePgDatabase<typeof schema>;

type GlobalWithPools = typeof globalThis & {
  __pgPool?: PgPool;
  __neonPool?: NeonPool;
  __db?: Db;
  __dbHttp?: Db;
};
const g = globalThis as GlobalWithPools;

function createDb(): Db {
  if (isNeon) {
    neonConfig.webSocketConstructor = ws as unknown as typeof WebSocket;
    const pool = (g.__neonPool ??= new NeonPool({ connectionString: databaseUrl }));
    return drizzleNeonServerless(pool, { schema }) as unknown as Db;
  }
  const pool = (g.__pgPool ??= new PgPool({ connectionString: databaseUrl, max: 10 }));
  return drizzleNodePg(pool, { schema });
}

function createHttpDb(fallback: Db): Db {
  if (!isNeon) return fallback;
  // neon-http: один запрос = один HTTP-вызов, без WebSocket — дёшево для простых чтений.
  return drizzleNeonHttp(neon(databaseUrl), { schema }) as unknown as Db;
}

export const db: Db = (g.__db ??= createDb());
/** Простые чтения без интерактивных транзакций (каталог, карточки). ВНИМАНИЕ: без .transaction(). */
export const dbHttp: Db = (g.__dbHttp ??= createHttpDb(db));

const TRANSIENT_RE =
  /connection terminated|econnreset|epipe|etimedout|econnrefused|websocket|fetch failed|socket hang up|terminating connection|connection closed|53300|57P01/i;

export function isTransientDbError(err: unknown): boolean {
  const e = err as { message?: string; code?: string } | null;
  return TRANSIENT_RE.test(`${e?.message ?? ""} ${e?.code ?? ""}`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Retry для транзиентных обрывов соединения с Neon после холодного старта/заморозки.
 * По умолчанию 3 попытки с backoff 150/300 мс.
 */
export async function withDbRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isTransientDbError(err) || i === attempts - 1) throw err;
      await sleep(150 * 2 ** i);
    }
  }
  throw lastErr;
}

/** Унифицированное извлечение строк из db.execute(sql`...`) для pg/neon драйверов. */
export function queryRows<T = Record<string, unknown>>(res: unknown): T[] {
  const r = res as { rows?: T[] } | T[];
  return Array.isArray(r) ? r : (r.rows ?? []);
}
