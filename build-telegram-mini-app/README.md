# ГОРН — интернет-магазин в Telegram Mini App

Монолит на Next.js (App Router): покупательская часть — Telegram Mini App,
**админка — в самом Telegram-боте** (никакого веба, паролей и cookie): команда
`/admin` открывает панель с заказами, товарами, сотрудниками и отчётами.

## Стек

- Next.js 16 + TypeScript (фронтенд и API в одном приложении), хостинг — Vercel
- PostgreSQL на Neon, ORM — Drizzle (neon-serverless Pool + neon-http + retry)
- Крон — Vercel Cron (Hobby: раз в сутки) + GitHub Actions на 10 минут
- Хранилище изображений — Vercel Blob (локально/self-hosted — `public/uploads`,
  отдаётся route-обработчиком `/uploads/[...path]`)
- Покупатели — авторизация через WebApp.initData (HMAC + auth_date)
- Админка — Telegram-бот: доступ по `telegram_id` из таблицы `staff_users`,
  роли owner/manager, состояние диалога в БД (`bot_states`)
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
   `APP_URL`, `ADMIN_TELEGRAM_ID` (ваш Telegram ID), `TG_SESSION_SECRET` (≥32),
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

   Частый ритм (10 минут), который нужен магазину, даёт бесплатный workflow
   `.github/workflows/expire-orders.yml` (лежит **в корне репозитория**, не в
   `build-telegram-mini-app/` — GitHub читает только `<repo>/.github/workflows`):
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
ADMIN_TELEGRAM_ID=123456789 npm run db:seed   # owner = ваш Telegram ID (узнать: /id в боте)
npm run dev
```

- **Админка — в Telegram-боте.** Откройте бота, отправьте `/id` (узнаете свой ID),
  положите его в `ADMIN_TELEGRAM_ID` и нажмите `/admin`. Владелец создастся сам
  при первом обращении — пароль не нужен, доступ проверяется по `telegram_id`.
  Команды: `/admin`, `/orders`, `/products`, `/report`, `/staff`, `/help`.
  Новых сотрудников добавляет владелец: «Сотрудники» → «Добавить» (нужен их
  Telegram ID, они узнают его командой `/id`). Роли: owner — всё, manager — заказы,
  товары и отчёты.
- Магазин в браузере (dev-обход TG-авторизации): http://localhost:3000/app
  (работает, только если `TG_AUTH_DEV_BYPASS=1`, `NEXT_PUBLIC_TG_DEV_BYPASS=1` **и**
  `BOT_TOKEN` пуст. `NEXT_PUBLIC_*` встраивается в бандл при сборке — после смены нужен перезапуск dev-сервера)

## Тесты

```bash
npm run test:unit    # чистые функции, без БД и сети
npm run test:e2e     # API + админ-бот + гонки + регрессии на исправленные дефекты
                     # (нужны запущенные БД, mock Bot API и `npm start`)
```

Подробности — `tests/README.md`; результаты последнего прогона и список дефектов — `../TEST-REPORT.md`.

## Интерфейс Mini App: что учтено

Сделано по гайдлайнам Telegram Mini Apps и требованиям доступности (WCAG AA):

- **Безопасные зоны.** `telegram-provider` суммирует `safeAreaInset` + `contentSafeAreaInset`
  и пересчитывает их на `viewportChanged` / `safeAreaChanged` / `contentSafeAreaChanged`;
  значения уходят в CSS-переменные `--safe-top` / `--safe-bottom`, шапка и подвал экранов
  на них опираются (на iPhone с «вырезом» ничего не уезжает под статус-бар).
- **Нативная навигация.** Внутри разделов показывается `Telegram.WebApp.BackButton`
  (`useTelegramBack`), хендлер снимается через `offClick` — нет самодельных «← Назад»,
  системный свайп работает как в остальных экранах Telegram.
- **Тактильный отклик.** `HapticFeedback` на «в корзину» (`light`/`medium`) и на результат
  оформления заказа (`success` / `error`).
- **Контраст.** Все текстовые цвета проверяются расчётом в `tests/unit.ts` (≥ 4.5:1 и на
  `paper`, и на `cream`); отдельная проверка — белый текст на `clay` (кнопки).
- **Клавиатура и моушн.** Видимый `:focus-visible`, `prefers-reduced-motion: reduce`
  отключает анимации; переходы ≤ 200 ms и только по `transform`/`opacity`.
- **iOS-зум.** Все поля ввода — не меньше 16 px (`text-base`), иначе Safari зумит страницу
  при фокусе и обратно не отдаляет.

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

## Диагностика на Vercel

```
https://<ваш-домен>/api/health?verbose=1
```

`ok: true` — всё в порядке, иначе `503` и таблица проблем:

| check | Что значит | Что делать |
|---|---|---|
| `env:ADMIN_TELEGRAM_ID` | не задан ID владельца | узнать свой ID командой `/id` в боте → добавить переменную → **Redeploy** |
| `env:BOT_TOKEN` | нет токена бота | получить у @BotFather → переменная → Redeploy |
| `env:TELEGRAM_WEBHOOK_SECRET` | не задан секрет вебхука | придумать строку → переменная + `setWebhook` с `secret_token` |
| `db:connection` | база недоступна (пауза проекта, неверный хост/пароль) | проверить проект Neon и строку подключения |
| `db:schema` | миграции не применены | `DATABASE_URL=<url> npx drizzle-kit migrate` (или готовый SQL, см. ниже) |
| `db:owner_exists` | в базе нет владельца | открыть `/admin` в боте (создастся из `ADMIN_TELEGRAM_ID`) либо `npm run db:seed` |

Переменные окружения применяются **только после Redeploy**.

Если миграции не запускаются (нет Node, проблема с CLI), схему можно поднять
одним SQL-файлом в Neon → SQL Editor. Готового файла в репозитории больше нет —
он генерируется под текущую схему:

```bash
# из живой БД (нужен pg_dump)
pg_dump "$DATABASE_URL" --schema-only --no-owner --no-privileges > db-setup.sql
```

Дальше добавить в конец файла `INSERT` владельца (`staff_users`,
`telegram_id` из `/id`) и, если схема создаётся вручную, запись в
`drizzle.__drizzle_migrations`. Шаблон и правила — `.ai/DEPLOY/db-bootstrap/`

## Безопасность и деньги — где что лежит

| Требование | Файл |
|---|---|
| Верификация initData (HMAC + auth_date) | `src/lib/telegram-auth.ts` |
| Доступ к админке | `src/lib/admin-bot/service.ts` (`findStaff` по `telegram_id`, активность) + проверка роли в `src/lib/admin-bot/index.ts` |
| Защита последнего owner | `src/lib/admin-bot/service.ts` (`setStaffActive` не даёт отключить последнего владельца) |
| Атомарное списание остатков | `src/app/api/orders/route.ts` (`UPDATE … WHERE stock >= N`) |
| Идемпотентность заказа + сверка хэша | там же (таблица `idempotency_keys`) |
| Идемпотентность платёжных вебхуков | `payment_events`, уникальный индекс `(provider, external_event_id)` |
| Magic bytes + лимит размера изображений (загрузка фото в боте) | `src/lib/image-validation.ts`, `src/lib/admin-bot/service.ts` |
| citext email | `staff_users.email` + `CREATE EXTENSION citext` |
| Rate limiting (логин по IP и по email, initData, заказ, инвойсы, загрузки) | `src/lib/rate-limit.ts` (атомарно в БД) |
| Автоотмена брошенных заказов + возврат остатков | `src/lib/orders/expire.ts`, `/api/cron/expire-orders` |
| Безопасные сообщения об ошибках БД (без SQL/хешей) | `src/lib/db-errors.ts` |
| Заголовки безопасности (nosniff, CSP frame-ancestors, HSTS) | `next.config.ts` |
| Отдача загруженных изображений (в т.ч. в `next start`) | `src/app/uploads/[...path]/route.ts` |
| Neon: retry при обрыве WS, neon-http для чтений | `src/db/index.ts` (`withDbRetry`, `dbHttp`) |
