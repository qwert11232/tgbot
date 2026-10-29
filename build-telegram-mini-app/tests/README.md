# Тесты «ГОРН»

Наборы проверок, которыми тестировался проект (см. `../TEST-REPORT.md`).

| Файл | Что проверяет | Нужен сервер |
|---|---|---|
| `unit.ts` | чистые функции: HMAC `initData`, курсы Stars, `PAYMENT_MODE`, slug, magic bytes, формат, граф статусов | нет |
| `smoke.mjs` | API: каталог, товар, авторизация Mini App, заказы, идемпотентность, остатки, вебхуки Telegram и внешнего эквайринга | да |
| `admin.mjs` | админка: proxy, 3 уровня сессий, RBAC, server actions (товары/сотрудники/статусы), загрузка файлов, логин и rate limit | да |
| `concurrency.mjs` | гонки: оверселл, параллельные повторы idempotency-ключа, дубли платёжных вебхуков, лимиты | да |
| `regressions.mjs` | регрессии на все исправленные дефекты из `TEST-REPORT.md` (P0-1…P2-25) | да |
| `run-all.mjs` | последовательный прогон unit + smoke + admin + concurrency + regressions | да |
| `mock-telegram.mjs` | локальная заглушка Bot API (`TELEGRAM_API_BASE`), журнал вызовов на `/__calls` | нет |

## Подготовка

```bash
createdb app_db
psql "$DATABASE_URL" -c 'CREATE EXTENSION IF NOT EXISTS citext;'
npx drizzle-kit push && npx tsx src/db/seed.ts
npm run build && npm start
```

## Запуск

```bash
export DATABASE_URL=postgresql://postgres@127.0.0.1:5432/app_db
export BOT_TOKEN=123456:TEST-TOKEN
export TELEGRAM_WEBHOOK_SECRET=test-webhook-secret
export PAYMENT_WEBHOOK_SECRET=pay-webhook-secret
export ADMIN_SESSION_SECRET=0123456789abcdef0123456789abcdef
export TG_SESSION_SECRET=abcdef0123456789abcdef0123456789
export CRON_SECRET=cron-secret
export ADMIN_NOTIFY_CHAT_ID=999001

# mock Bot API (нужен для regressions: инвойсы, уведомления, /start)
node tests/mock-telegram.mjs 3333 &

# сервер должен знать про mock и секрет крона:
TELEGRAM_API_BASE=http://127.0.0.1:3333 CRON_SECRET=cron-secret ADMIN_NOTIFY_CHAT_ID=999001 npm start

node tests/run-all.mjs
```

Дополнительно: `BASE` — адрес приложения (по умолчанию `http://127.0.0.1:3000`),
`ACTION_MANIFEST` — путь к `server-reference-manifest.json` (по умолчанию `.next/server/…`).

## Важно

* Тесты меняют демо-данные (остатки товаров, `rate_limits`) и создают сотрудников/заказы.
  `tests/db.mjs` отказывается работать с не-localhost БД без `FORCE_DB_RESET=1`.
* id server actions берутся из манифеста сборки, поэтому `npm run build` обязателен перед `admin.mjs`.
* Без mock (`TELEGRAM_API_BASE`) вызовы уходят на реальный `api.telegram.org`; в закрытой
  сети `invoiceUrl` будет `null` — скрипты `smoke`/`concurrency` это допускают, а `regressions` требуют mock.
