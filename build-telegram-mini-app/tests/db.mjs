// Общие утилиты тестов: подключение к тестовой БД и подготовка демо-данных.
// ВАЖНО: prepareDemoData() перезаписывает остатки демо-товаров — запускайте тесты
// только против локальной/тестовой БД (защита: не-localhost требует FORCE_DB_RESET=1).
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { Pool } = require("pg");

export const DATABASE_URL = process.env.DATABASE_URL ?? "postgresql://postgres@127.0.0.1:5432/app_db";
export const pool = new Pool({ connectionString: DATABASE_URL });

const DEMO_SLUGS = ["kruzhka-duna-320", "chashka-espresso-ugol", "vaza-terra-24", "podsvechniki-para", "tarelka-kamen-26", "piala-lazur"];

export async function prepareDemoData() {
  const host = new URL(DATABASE_URL).hostname;
  const isLocal = host === "127.0.0.1" || host === "localhost" || host === "::1";
  if (!isLocal && process.env.FORCE_DB_RESET !== "1") {
    throw new Error(`prepareDemoData: ${host} не локальный хост, отказываюсь менять данные (FORCE_DB_RESET=1 чтобы переопределить)`);
  }
  await pool.query("truncate rate_limits");
  await pool.query("update products set stock = 20 where slug = any($1)", [DEMO_SLUGS]);
  await pool.query("update products set stock = 0 where slug = 'piala-lazur'");
}
