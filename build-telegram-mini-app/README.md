# ГОРН — интернет-магазин в Telegram Mini App

Монолит на Next.js (App Router): покупательская часть — Telegram Mini App,
админка (`/admin`) — отдельный раздел того же приложения для обычного браузера.

## Стек

- Next.js 16 + TypeScript (фронтенд и API в одном приложении), хостинг — Vercel
- PostgreSQL на Neon, ORM — Drizzle (neon-serverless Pool + neon-http + retry)
- Хранилище изображений — Vercel Blob (локально — `public/uploads`)
- Покупатели — авторизация через WebApp.initData (HMAC + auth_date)
- Админка — email+password, собственные сессии (JWT в httpOnly cookie + таблица сессий)
- Уведомления и оплата — Telegram Bot (webhook) + Telegram Payments (Stars / fiat)

## Чек-лист деплоя на Vercel

1. **Neon**: создать проект → взять pooled connection string.
   Выполнить один раз в SQL-консоли Neon:
   ```sql
   CREATE EXTENSION IF NOT EXISTS citext;
   ```
2. **Схема БД**: локально с env `DATABASE_URL=<neon-url>` выполнить
   `npx drizzle-kit push` (или `npx drizzle-kit generate` + `npx drizzle-kit migrate`).
   Сид первого owner и демо-каталога: `npx tsx src/db/seed.ts`.
3. **Vercel Blob**: создать Blob Store, подключить к проекту — env `BLOB_READ_WRITE_TOKEN` подтянется автоматически.
4. **Переменные окружения Vercel** (см. `.env.example`): `DATABASE_URL`,
   `BOT_TOKEN`, `NEXT_PUBLIC_BOT_USERNAME`, `TELEGRAM_WEBHOOK_SECRET`,
   `APP_URL`, `ADMIN_SESSION_SECRET` (≥32), `TG_SESSION_SECRET` (≥32),
   `PAYMENT_MODE` (`stars` | `fiat`), при fiat — `PAYMENT_PROVIDER_TOKEN`,
   `PAYMENT_CURRENCY`; опционально `XTR_PRICE_MINOR`, `ADMIN_NOTIFY_CHAT_ID`,
   `PAYMENT_WEBHOOK_SECRET`. НЕ выставлять `TG_AUTH_DEV_BYPASS`.
5. **Telegram Bot** (@BotFather): создать бота, включить вебхук с секретом:
   ```
   curl -X POST "https://api.telegram.org/bot$BOT_TOKEN/setWebhook" \
     -d url="$APP_URL/api/webhooks/telegram" \
     -d secret_token="$TELEGRAM_WEBHOOK_SECRET" \
     -d allowed_updates='["message","pre_checkout_query"]'
   ```
   Кнопка меню: `/setmenubutton` → web_app `<APP_URL>/app`.
6. **Платежи**:
   - Stars (по умолчанию): ничего настраивать не нужно, валюта XTR.
   - Fiat: /mybots → Payments → выбрать провайдера (напр. ЮKassa) →
     `PAYMENT_PROVIDER_TOKEN` в env.
7. **Внешний эквайринг** (опционально): направить вебхуки провайдера на
   `<APP_URL>/api/webhooks/payment` с заголовком `X-Payment-Signature`
   (HMAC-SHA256 тела ключом `PAYMENT_WEBHOOK_SECRET`).

## Локальный запуск

```bash
npm ci
cp .env.example .env          # заполнить DATABASE_URL и секреты
createdb app_db || true
psql "$DATABASE_URL" -c "CREATE EXTENSION IF NOT EXISTS citext;"
npm run db:push
ADMIN_PASSWORD='придумайте-свой-пароль' npm run db:seed   # owner из ADMIN_EMAIL
npm run dev
```

- Админка: http://localhost:3000/admin
- Магазин в браузере (dev-обход TG-авторизации): http://localhost:3000/app
  (работает, только если `TG_AUTH_DEV_BYPASS=1`, `NEXT_PUBLIC_TG_DEV_BYPASS=1` **и**
  `BOT_TOKEN` пуст. `NEXT_PUBLIC_*` встраивается в бандл при сборке — после смены нужен перезапуск dev-сервера)

## Тесты

```bash
npm run test:unit    # чистые функции, без БД и сети
npm run test:e2e     # API + админка + гонки (нужны запущенные БД и `npm start`)
npm run test:bugs    # воспроизведение найденных дефектов
```

Подробности — `tests/README.md`; результаты последнего прогона и список дефектов — `../TEST-REPORT.md`.

## Безопасность и деньги — где что лежит

| Требование | Файл |
|---|---|
| Верификация initData (HMAC + auth_date) | `src/lib/telegram-auth.ts` |
| 3 уровня защиты админки | `src/proxy.ts` → `src/lib/admin-session.ts` → `requireAdmin()/assertRole()` на каждой странице и action |
| Защита последнего owner | `src/lib/admin/staff-actions.ts` (`FOR UPDATE` в транзакции) |
| Атомарное списание остатков | `src/app/api/orders/route.ts` (`UPDATE … WHERE stock >= N`) |
| Идемпотентность заказа + сверка хэша | там же (таблица `idempotency_keys`) |
| Идемпотентность платёжных вебхуков | `payment_events`, уникальный индекс `(provider, external_event_id)` |
| Magic bytes + лимит размера изображений | `src/lib/image-validation.ts`, `src/app/api/admin/upload/route.ts` |
| citext email | `staff_users.email` + `CREATE EXTENSION citext` |
| Rate limiting (логин, initData, заказ, загрузки) | `src/lib/rate-limit.ts` (атомарно в БД) |
| Neon: retry при обрыве WS, neon-http для чтений | `src/db/index.ts` (`withDbRetry`, `dbHttp`) |
