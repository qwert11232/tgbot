# ГОРН — интернет-магазин в Telegram Mini App

Монолит на Next.js (App Router): покупательская часть — Telegram Mini App,
админка (`/admin`) — отдельный раздел того же приложения для обычного браузера.

## Стек

- Next.js 16 + TypeScript (фронтенд и API в одном приложении), хостинг — Vercel
- PostgreSQL на Neon, ORM — Drizzle (neon-serverless Pool + neon-http + retry)
- Крон — Vercel Cron (Hobby: раз в сутки) + GitHub Actions на 10 минут
- Хранилище изображений — Vercel Blob (локально/self-hosted — `public/uploads`,
  отдаётся route-обработчиком `/uploads/[...path]`)
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
   `PAYMENT_WEBHOOK_SECRET`, `ORDER_TTL_MINUTES` (по умолчанию 60), `CRON_SECRET`.
   НЕ выставлять `TG_AUTH_DEV_BYPASS`.
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
8. **Крон автоотмены заказов**. На тарифе **Hobby** Vercel разрешает крон-задачи
   не чаще **раза в сутки** и не более двух задач, поэтому `vercel.json` содержит
   суточный запуск `0 3 * * *` (03:00 UTC ≈ 06:00 МСК). Vercel сам присылает
   `Authorization: Bearer $CRON_SECRET` — достаточно задать `CRON_SECRET` в env.

   Частый ритм (10 минут), который нужен магазину, даёт бесплатный
   `.github/workflows/expire-orders.yml`:
   * Variables → `APP_URL` = адрес деплоя (без слэша на конце);
   * Secrets → `CRON_SECRET` = то же значение, что в env Vercel.
   Пока `APP_URL` не задан, workflow молчит (не падает по расписанию).
   На Pro-плане можно вместо этого вернуть `"schedule": "*/10 * * * *"`
   в `vercel.json` и удалить workflow.

   Дополнительная страховка: остатки освобождаются лениво при обращении к каталогу
   и списку заказов (не чаще раза в минуту на инстанс, до 50 заказов за проход),
   поэтому просроченный заказ не «съедает» товар надолго даже без крона.
   Ручной запуск:
   ```bash
   curl -H "Authorization: Bearer $CRON_SECRET" "$APP_URL/api/cron/expire-orders"
   ```

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

- Админка: http://localhost:3000/admin — вход по email+паролю сотрудника.
  После `npm run db:seed` создаётся owner:
  * `ADMIN_EMAIL` (по умолчанию `admin@gorn.local`);
  * `ADMIN_PASSWORD`, если задан при сиде; **если не задан — пароль по умолчанию
    `gorn-admin-2026`**, его нужно сменить сразу после первого входа.
  Забыли пароль / нужно сменить из консоли (сессии при этом сбрасываются):
  ```bash
  npm run db:passwd -- admin@gorn.local 'новый-пароль-от-10-символов'
  ```
  Новых сотрудников с ролями owner/manager создаёт owner в разделе «Сотрудники».
  Если панель открывается во встроенном окне/iframe на другом домене (превью,
  внутренний портал), задайте `ADMIN_COOKIE_SAMESITE=none`: иначе браузер не
  отправляет lax-cookie в стороннем контексте и вход «слетает» на каждом разделе.
  Работает только по https (Secure включается автоматически); по http
  приложение откатывается на `lax`, чтобы cookie вообще сохранялась.
- Магазин в браузере (dev-обход TG-авторизации): http://localhost:3000/app
  (работает, только если `TG_AUTH_DEV_BYPASS=1`, `NEXT_PUBLIC_TG_DEV_BYPASS=1` **и**
  `BOT_TOKEN` пуст. `NEXT_PUBLIC_*` встраивается в бандл при сборке — после смены нужен перезапуск dev-сервера)

## Тесты

```bash
npm run test:unit    # чистые функции, без БД и сети
npm run test:e2e     # API + админка + гонки + регрессии на исправленные дефекты
                     # (нужны запущенные БД, mock Bot API и `npm start`)
```

Подробности — `tests/README.md`; результаты последнего прогона и список дефектов — `../TEST-REPORT.md`.

## Как устроен заказ и оплата

1. `POST /api/orders` — заказ создаётся в `pending_payment`, остатки списываются
   атомарно, в ответ приходит `invoiceUrl` (Telegram `createInvoiceLink`).
2. Mini App открывает окно оплаты (`Telegram.WebApp.openInvoice`). Если окно
   закрыто или недоступно — заказ остаётся в «Мои заказы» с кнопкой «Оплатить»:
   `POST /api/orders/[id]/invoice` выдаёт ссылку повторно (владельцу, пока не истёк TTL).
3. `pre_checkout_query` → сверка суммы и валюты → `answerPreCheckoutQuery`.
4. `successful_payment` → идемпотентная запись в `payment_events` + **повторная
   сверка суммы**; при несовпадении, оплате отменённого заказа или двойной оплате
   заказ не помечается оплаченным, а админ получает алерт в `ADMIN_NOTIFY_CHAT_ID`.
5. Неоплаченный заказ старше `ORDER_TTL_MINUTES` автоотменяется кроном
   (`/api/cron/expire-orders`), остатки возвращаются на склад, покупатель получает
   уведомление от бота.

## Если на Vercel админка пишет «This page couldn't load»

Это падение server action входа, а не неверный пароль. Посмотреть причину можно
без логов, открыв в браузере:

```
https://<ваш-домен>/api/health?verbose=1
```

Ответ покажет, что именно не так (`ok: true` = всё в порядке, иначе `503`):

| check | Что значит | Что делать |
|---|---|---|
| `config:admin_session_secret_missing` / `_too_short` | не задан `ADMIN_SESSION_SECRET` или он короче 32 символов | `openssl rand -hex 32` → в Environment Variables → **Redeploy** |
| `config:database_url_missing` | нет `DATABASE_URL` | добавить строку подключения Neon → **Redeploy** |
| `db:connection` | база недоступна (пауза проекта, неверный хост/пароль) | проверить проект Neon и строку подключения |
| `db:schema` | миграции не применены | `DATABASE_URL=<url> npx drizzle-kit migrate`, затем `npx tsx src/db/seed.ts` |
| `db:owner_exists` | в базе нет владельца | `DATABASE_URL=<url> ADMIN_EMAIL=... ADMIN_PASSWORD='...' npx tsx src/db/seed.ts` |

Важно: **переменные окружения применяются только после Redeploy** — если вы
добавили их после первого деплоя, приложение продолжит работать со старым
окружением. Также `ADMIN_SESSION_SECRET` и `TG_SESSION_SECRET` должны быть
минимум 32 символа, иначе вход в админку невозможен по дизайну (исключение
бросается намеренно, чтобы слабый секрет не подделывал сессии).

Теперь такие ошибки не превращаются в «This page couldn't load»: форма входа
показывает текст проблемы и подсказку, а подробности пишутся в логи функции.

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
| Rate limiting (логин по IP и по email, initData, заказ, инвойсы, загрузки) | `src/lib/rate-limit.ts` (атомарно в БД) |
| Cookie сессии админки: Secure по фактическому протоколу, SameSite настраивается | `src/lib/admin-cookie-policy.ts` |
| Автоотмена брошенных заказов + возврат остатков | `src/lib/orders/expire.ts`, `/api/cron/expire-orders` |
| Безопасные сообщения об ошибках БД (без SQL/хешей) | `src/lib/db-errors.ts` |
| Заголовки безопасности (nosniff, CSP frame-ancestors, HSTS) | `next.config.ts` |
| Отдача загруженных изображений (в т.ч. в `next start`) | `src/app/uploads/[...path]/route.ts` |
| Neon: retry при обрыве WS, neon-http для чтений | `src/db/index.ts` (`withDbRetry`, `dbHttp`) |
