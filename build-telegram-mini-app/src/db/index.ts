import { drizzle as drizzleNodePg, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { drizzle as drizzleNeonServerless } from "drizzle-orm/neon-serverless";
import { drizzle as drizzleNeonHttp } from "drizzle-orm/neon-http";
import { Pool as NeonPool, neon, neonConfig } from "@neondatabase/serverless";
import { Pool as PgPool } from "pg";
import ws from "ws";
import * as schema from "./schema";

/**
 * Production (Vercel) — Neon: URL вида *.neon.tech.
 *   - neon-serverless Pool (WebSocket) для интерактивных транзакций;
 *   - neon-http для простых чтений без транзакций;
 *   - withDbRetry() переживает обрыв WebSocket после «заморозки» serverless-контейнера.
 * Локально — обычный PostgreSQL через node-postgres (тот же интерфейс Drizzle).
 *
 * Подключение ленивое: `next build` (сборка страниц/роутов) не требует
 * DATABASE_URL — соединение создаётся при первом обращении, а не при импорте.
 */

function databaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required");
  return url;
}

export function isNeon(): boolean {
  const url = process.env.DATABASE_URL ?? "";
  return /neon\.tech|neon\.dev/i.test(url) || process.env.DB_DRIVER === "neon";
}

export type Db = NodePgDatabase<typeof schema>;

type GlobalWithPools = typeof globalThis & {
  __pgPool?: PgPool;
  __neonPool?: NeonPool;
  __db?: Db;
  __dbHttp?: Db;
};
const g = globalThis as GlobalWithPools;

function createDb(): Db {
  const url = databaseUrl();
  if (isNeon()) {
    neonConfig.webSocketConstructor = ws as unknown as typeof WebSocket;
    const pool = (g.__neonPool ??= new NeonPool({ connectionString: url }));
    return drizzleNeonServerless(pool, { schema }) as unknown as Db;
  }
  const pool = (g.__pgPool ??= new PgPool({ connectionString: url, max: 10 }));
  return drizzleNodePg(pool, { schema });
}

function createHttpDb(): Db {
  // neon-http: один запрос = один HTTP-вызов, без WebSocket — дёшево для простых чтений.
  if (!isNeon()) return createDb();
  return drizzleNeonHttp(neon(databaseUrl()), { schema }) as unknown as Db;
}

/** Ленивый прокси: настоящий клиент создаётся при первом обращении к методу. */
function lazyDb(getInstance: () => Db): Db {
  let instance: Db | null = null;
  return new Proxy({} as Db, {
    get(_target, prop, receiver) {
      instance ??= getInstance();
      const value = Reflect.get(instance as object, prop, receiver);
      return typeof value === "function" ? value.bind(instance) : value;
    },
    has(_target, prop) {
      instance ??= getInstance();
      return prop in (instance as object);
    },
  });
}

/** Основной клиент: транзакции, запись, всё, что требует одного соединения. */
export const db: Db = lazyDb(() => (g.__db ??= createDb()));
/** Простые чтения без интерактивных транзакций (каталог, карточки). ВНИМАНИЕ: без .transaction(). */
export const dbHttp: Db = lazyDb(() => (g.__dbHttp ??= createHttpDb()));

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
