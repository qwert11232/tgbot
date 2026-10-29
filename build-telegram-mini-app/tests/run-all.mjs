// Запуск всех наборов подряд с очисткой rate_limits между ними.
// Требует: собранное приложение (npm run build), запущенный сервер (npm start) и PostgreSQL.
// Запуск: node tests/run-all.mjs
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { Pool } = require("pg");
const pool = new Pool({ connectionString: process.env.DATABASE_URL ?? "postgresql://postgres@127.0.0.1:5432/app_db" });

const suites = [
  ["unit", "npx", ["tsx", "tests/unit.ts"]],
  ["smoke (API)", "node", ["tests/smoke.mjs"]],
  ["admin-bot (панель в Telegram)", "node", ["tests/admin-bot.mjs"]],
  ["concurrency (гонки)", "node", ["tests/concurrency.mjs"]],
  ["regressions (исправленные дефекты)", "node", ["tests/regressions.mjs"]],
];

let failed = 0;
for (const [name, cmd, args] of suites) {
  await pool.query("truncate rate_limits");
  console.log(`\n================ ${name} ================`);
  try {
    const out = execFileSync(cmd, args, { encoding: "utf8", stdio: "pipe" });
    process.stdout.write(out);
  } catch (err) {
    process.stdout.write(err.stdout ?? "");
    process.stderr.write(err.stderr ?? "");
    failed++;
  }
}
await pool.end();
console.log(failed === 0 ? "\nВсе наборы прошли." : `\nНаборов с провалами: ${failed}`);
process.exitCode = failed === 0 ? 0 : 1;
