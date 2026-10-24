# Отчёт о тестировании Telegram Mini App «ГОРН»

Дата: 24.10.2026. Проверялся код из `build-telegram-mini-app` (Next.js 16.2.6, React 19, Drizzle 0.45, PostgreSQL).

## 1. Как тестировалось

Тестирование не ограничивалось чтением кода — приложение **поднималось целиком**:

* PostgreSQL 16.2 (локальный кластер), схема применена `drizzle-kit push`, данные — `npx tsx src/db/seed.ts`;
* `next build` + `next start` (production-режим, как на Vercel) с реальными env: `BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, `PAYMENT_WEBHOOK_SECRET`, `ADMIN_SESSION_SECRET`, `TG_SESSION_SECRET`;
* авторизация Mini App проверялась **настоящими** `initData` с корректным HMAC-SHA256 (и с подделкой/просрочкой/подменой пользователя);
* админка — реальные сессии в `staff_sessions` + JWT, server actions вызывались по HTTP с `Next-Action` и wire-форматом `encodeReply` (как из браузера);
* гонки: параллельные заказы, параллельные повторы idempotency-ключа, параллельные дубли платёжных вебхуков;
* 30+ юнит-проверок чистых функций (HMAC initData, курсы Stars, slug, magic bytes, формат, граф статусов).

Итог прогона (`node tests/run-all.mjs`): **146 проверок**, из них 143 проходят; 3 «падающих» теста — это намеренно зафиксированные баги (помечены `BUG:`), плюс отдельный скрипт `tests/known-bugs.mjs`, который подтвердил **11 дефектов**.

## 2. Что сделано хорошо (ломать не надо)

* Верификация `initData`: HMAC по `WebAppData`, timing-safe сравнение, окно `auth_date`, отсечение future-дат, битый JSON не роняет обработчик.
* Админка: 3 уровня защиты реально работают. Проверено: без cookie — 307 на логин; отозванная сессия, просроченная сессия, устаревший `sessionVersion`, валидный JWT без строки в `staff_sessions` — все отсекаются; server actions недоступны анониму и менеджеру (staff-actions), CSRF-защита Next режет чужой `Origin`.
* Деньги и склад: остатки списываются атомарно (`UPDATE … WHERE stock >= N`). 8 параллельных заказов на 1 шт → ровно один успешный, 7 `out_of_stock`, остаток не ушёл в минус. Параллельные повторы одного `idempotencyKey` → один заказ, остаток списан один раз. Повторный платёжный вебхук идемпотентен (событие пишется один раз).
* Платёжный протокол в целом: `pre_checkout_query` сверяет сумму и валюту, `answerPreCheckoutQuery` вызывается до истечения окна, вебхук без `secret_token` → 401, HMAC-подпись внешнего эквайринга проверяется, при отмене остатки возвращаются.
* Валидация загрузок: magic bytes (HTML/SVG под видом PNG → 415), лимит 5 МБ → 413, имя файла генерирует сервер, rate limit на загрузки.
* Rate limiting в БД (переживает serverless), fail-open документирован; bcrypt 12; выравнивание тайминга логина; citext для email; «последний owner» защищён транзакцией с `FOR UPDATE`.

## 3. Дефекты

### P0 — ломают деньги/данные

| # | Дефект | Где | Как проявляется |
|---|---|---|---|
| 1 | **Неоплаченный заказ навсегда списывает остаток.** Нет ни TTL, ни крона, ни отмены по таймауту | `src/app/api/orders/route.ts:151`, вся кодовая база (нет фоновой задачи) | Покупатель открыл инвойс и закрыл. Товар «продан», пока админ вручную не отменит заказ. Проверено: остаток 20 → 18 и не возвращается; в БД копятся десятки `pending_payment` |
| 2 | **`successful_payment` не сверяет сумму и валюту** | `src/app/api/webhooks/telegram/route.ts:107` (см. проверку только в `pre_checkout_query`, строка 74) | Заказ на 2 490 ₽ помечается оплаченным вебхуком с `total_amount = 1` (1 звезда). Подтверждено: статус `paid` |
| 3 | **Покупатель не может оплатить созданный заказ.** Корзина очищается до оплаты, ссылки на инвойс нигде не сохраняется и не отдаётся | `src/app/app/checkout/page.tsx:89`, `src/app/app/orders/page.tsx` (нет кнопки), `GET /api/orders` не содержит `invoiceUrl` | Платёжное окно закрылось/не открылось → заказ висит, корзина пуста, «оформить заново» резервирует остаток ещё раз. Текст «Ссылку на оплату можно получить повторно, оформив заказ ещё раз» вводит в заблуждение |
| 4 | **Загруженные изображения не отдаются в production-сборке** | `src/lib/storage.ts:25,28` | Без `BLOB_READ_WRITE_TOKEN` файл пишется в `public/uploads`, но `next start` отдаёт только файлы, существовавшие на момент `next build` → `GET /uploads/products/…png` = **404** (проверено). На Vercel ФС read-only — запись упадёт с 500. Нужен `BLOB_READ_WRITE_TOKEN` или route-handler для отдачи файлов |
| 5 | **Демо-картинки из сида отсутствуют** | `src/db/seed.ts:29,38,47…` → `/seed/*.jpg` | В репозитории вообще нет каталога `public/`, все 6 демо-товаров показываются с битыми картинками |
| 6 | **Утечка SQL и хеша пароля в браузер админа.** `fail()` возвращает `err.message`, а drizzle 0.45 прячет деталь в `err.cause`, оставляя в `message` весь запрос с параметрами | `src/lib/admin/staff-actions.ts:14`, `product-actions.ts:19`, `order-actions.ts:15` | Дубликат email → в UI прилетает `Failed query: insert into "staff_users" … params: admin@gorn.local,Дубль,$2b$12$…`. Понятное «Такой email уже занят» не срабатывает никогда. То же при несуществующей категории (`23503`) |

### P1 — некорректное поведение

| # | Дефект | Где | Проявление |
|---|---|---|---|
| 7 | Оплата по уже отменённому заказу: вебхук отвечает 200, деньги списаны, статус остаётся `cancelled`, ни алерта, ни возврата | `webhooks/telegram/route.ts:91-115` | Проверено: `status=cancelled`, `paid_at=null` |
| 8 | Внешний вебхук с неизвестным `order_id` → **500**, а не 404/200 (FK `payment_events.order_id` срабатывает раньше поиска заказа, ветка `HttpError(404)` недостижима) | `webhooks/payment/route.ts:44-58` | Провайдер будет ретраить бесконечно. Подтверждено: HTTP 500, в логах `violates foreign key constraint` |
| 9 | Rate limit логина обходится подменой `X-Forwarded-For` — берётся первый элемент заголовка | `src/lib/http.ts:45-49` | 12 попыток с разными XFF → 0 блокировок. На Vercel заголовок перезаписывается, за другим прокси — дыра в брутфорс-защите |
| 10 | Тихий «успех» при операциях с несуществующим сотрудником | `staff-actions.ts:139` (`if (!target) return;`), `:155` (`resetStaffPasswordAction` без проверки) | `resetStaffPasswordAction(<random uuid>)` → `{"ok":true}`. Подтверждено |
| 11 | Нет `.env.example` (README на него ссылается), нет `.gitignore`, не было lock-файла, нет тестов/CI | корень проекта | В репозитории 65 файлов: `public/` нет вовсе, `.env.example` и `.gitignore` отсутствуют. Риск закоммитить `.env`, `.next`, `node_modules`, `public/uploads` |
| 12 | Нет security-заголовков (`X-Content-Type-Options`, `Referrer-Policy`, CSP, HSTS) | `next.config.ts` пустой | Проверено по заголовкам ответа |
| 13 | `proxy.ts` сохраняет `?next=`, но `loginAction` всегда редиректит на `/admin` | `src/proxy.ts:26`, `auth-actions.ts:57` | Открыл `/admin/orders` → после логина попал на дашборд, а не на заказы |
| 14 | `/admin/login` не редиректит уже авторизованного сотрудника (200, форма логина) | `src/app/admin/login/page.tsx` | Мелочь, но сбивает |

### P2 — UX и устойчивость

| # | Дефект | Где |
|---|---|---|
| 15 | После `openInvoice` нет опроса статуса: вебхук обычно приходит через 1–3 с, страница показывает «Ожидает оплаты» до перезагрузки. Статусы `cancelled/failed` не обрабатываются | `app/orders/page.tsx`, `checkout/page.tsx:92-99` |
| 16 | Каталог полностью клиентский: в HTML `/app` нет ни одного товара (проверено — 0 совпадений), первый экран пустой до ответа API | `app/app/page.tsx` |
| 17 | Гонка поиска: нет `AbortController`, ответ на старый запрос может перетереть новый | `app/app/page.tsx:53-55` |
| 18 | Удалённый товар остаётся в `localStorage` корзины: строка невидима, но уходит в заказ → 409 | `cart-store.ts`, `cart/page.tsx` |
| 19 | `addToCart(id, qty, 0)` кладёт 1 шт. при нулевом остатке (`Math.max(1, maxStock)`) | `cart-store.ts:31-32` |
| 20 | `XTR_PRICE_MINOR=abc` → `NaN` в цене инвойса (Telegram отклонит платёж); нет валидации env | `payments.ts:36-39` |
| 21 | `PAYMENT_MODE` c опечаткой молча превращается в `stars` | `payments.ts:29` |
| 22 | Сравнение `TELEGRAM_WEBHOOK_SECRET` не constant-time | `webhooks/telegram/route.ts:46` |
| 23 | Ошибки Bot API только логируются; инвойс/уведомление молча теряются, заказ остаётся неоплаченным | `telegram-bot.ts` |
| 24 | Миграция `drizzle/0000_init.sql` не создаёт `citext`, `drizzle-kit migrate` на чистой БД падает (push тоже требует домен/расширение вручную) | `drizzle/0000_init.sql:96` |
| 25 | `rate_limits` никогда не чистится; таблица растёт | `rate-limit.ts` |
| 26 | Список заказов ограничен 150 без пагинации; `GET /api/orders` — 50 без пагинации | `admin/orders/page.tsx`, `api/orders/route.ts` |
| 27 | `priceToMinor` принимает `"1,234.56"` → NaN (ошибка), `"0"` → бесплатный товар | `product-actions.ts:47` |
| 28 | Сид задаёт дефолтный пароль `gorn-admin-2026`, README его публикует; нет требования сменить | `db/seed.ts`, README |
| 29 | Дефолтные демо-картинки/данные сида перевёрнуты по дате (последний товар первым) | `api/catalog` сортирует по `createdAt desc` |
| 30 | `useCartDetails` импортируется из `page.tsx` другой страницы (`@/app/app/cart/page`) — нарушение границ модулей, тянет страницу в бандл | `checkout/page.tsx:7` |

## 4. Что нельзя было проверить в песочнице

* Реальные вызовы `api.telegram.org` (сеть закрыта): проверены только логика и обработка ошибок; сами `createInvoiceLink`/`sendMessage` возвращают `null`. Поэтому `invoiceUrl` в тестах = `null` — это ожидаемо, а не баг.
* Клиент Telegram (WebApp SDK), мобильную вёрстку и `openInvoice` — нужен реальный клиент/эмулятор.
* Vercel Blob и Neon-драйверы (`neon-http`, `neon-serverless`) — тестировалось на обычном PostgreSQL через `node-postgres`. Риск: `dbHttp` для чтений на Neon не проверялся вживую.

## 5. Как повторить

```bash
cd build-telegram-mini-app
npm ci

# тестовая БД (пример для локального Postgres)
createdb app_db
psql "$DATABASE_URL" -c 'CREATE EXTENSION IF NOT EXISTS citext;'
npx drizzle-kit push && npx tsx src/db/seed.ts

npm run build && npm start          # сервер на :3000
node tests/run-all.mjs              # unit + API + админка + гонки
node tests/known-bugs.mjs           # воспроизведение найденных дефектов
```

Переменные для тестов: `DATABASE_URL`, `BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`,
`PAYMENT_WEBHOOK_SECRET`, `ADMIN_SESSION_SECRET`, `TG_SESSION_SECRET`, `BASE` (по умолчанию `http://127.0.0.1:3000`).
Тесты админки читают id server actions из `.next/server/server-reference-manifest.json`, поэтому запускаются после `npm run build`.
Скрипты меняют остатки демо-товаров и чистят `rate_limits` — только для локальной/тестовой БД.
