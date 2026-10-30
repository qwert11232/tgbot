// Регрессионные тесты на дефекты из TEST-REPORT.md.
// Требуют: собранное приложение (npm run build), запущенный сервер с
//   TELEGRAM_API_BASE=http://127.0.0.1:3333, CRON_SECRET=cron-secret,
//   ADMIN_NOTIFY_CHAT_ID=999001,
// плюс mock Telegram API (node tests/mock-telegram.mjs).
// Запуск: node tests/regressions.mjs
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { prepareDemoData, pool } from "./db.mjs";

const require = createRequire(import.meta.url);

const BASE = process.env.BASE ?? "http://127.0.0.1:3000";
const BOT_TOKEN = process.env.BOT_TOKEN ?? "123456:TEST-TOKEN";
const WH = process.env.TELEGRAM_WEBHOOK_SECRET ?? "test-webhook-secret";
const PAY_SECRET = process.env.PAYMENT_WEBHOOK_SECRET ?? "pay-webhook-secret";
const CRON_SECRET = process.env.CRON_SECRET ?? "cron-secret";
const MOCK_API = process.env.MOCK_TG ?? "http://127.0.0.1:3333";
const ADMIN_CHAT = process.env.ADMIN_NOTIFY_CHAT_ID ?? "999001";

let pass = 0;
const fails = [];
function check(name, cond, extra) {
  if (cond) {
    pass++;
    console.log(`PASS  ${name}`);
  } else {
    fails.push({ name, extra });
    console.log(`FAIL  ${name}${extra !== undefined ? `  << ${JSON.stringify(extra)}` : ""}`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function mockCalls() {
  return (await fetch(`${MOCK_API}/__calls`)).json();
}
async function resetMock() {
  await fetch(`${MOCK_API}/__reset`, { method: "POST" });
}
async function waitForCall(method, predicate = () => true, timeoutMs = 4000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const calls = await mockCalls();
    const found = calls.find((c) => c.method === method && predicate(c.body));
    if (found) return found;
    await sleep(120);
  }
  return null;
}

async function tgUpdate(update) {
  return fetch(`${BASE}/api/webhooks/telegram`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": WH },
    body: JSON.stringify(update),
  });
}

await prepareDemoData();
await resetMock();

function initData(id) {
  const p = new URLSearchParams({
    auth_date: String(Math.floor(Date.now() / 1000)),
    user: JSON.stringify({ id, first_name: "Регресс" }),
  });
  const dcs = [...p.entries()].map(([k, v]) => `${k}=${v}`).sort().join("\n");
  const s = crypto.createHmac("sha256", "WebAppData").update(BOT_TOKEN).digest();
  p.set("hash", crypto.createHmac("sha256", s).update(dcs).digest("hex"));
  return p.toString();
}

let seq = 960000000;
async function buyer() {
  seq++;
  const r = await fetch(`${BASE}/api/auth/telegram`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ initData: initData(seq) }),
  });
  const d = await r.json();
  return { headers: { "content-type": "application/json", authorization: `Bearer ${d.token}` }, user: d.user };
}

async function newOrder(headers, productId, qty = 1) {
  const r = await fetch(`${BASE}/api/orders`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      idempotencyKey: crypto.randomUUID(),
      items: [{ productId, qty }],
      customerName: "Регресс Тестов",
      phone: "+7 900 000-00-00",
      address: "",
      comment: "",
    }),
  });
  return { status: r.status, body: await r.json() };
}

async function stockOf(id) {
  return (await (await fetch(`${BASE}/api/products/${id}`)).json()).product.stock;
}

const catalog = await (await fetch(`${BASE}/api/catalog`)).json();
const product = catalog.products.find((p) => p.stock > 5);
const b1 = await buyer();

/* ─────────── P0-3: повторная оплата созданного заказа ─────────── */
{
  const order = (await newOrder(b1.headers, product.id, 1)).body.order;
  const res = await fetch(`${BASE}/api/orders/${order.id}/invoice`, { method: "POST", headers: b1.headers });
  const data = await res.json();
  check("P0-3: POST /api/orders/[id]/invoice отдаёт ссылку на оплату", res.status === 200 && typeof data.invoiceUrl === "string", data);
  check("P0-3: в списке заказов есть expiresAt и payable", Boolean(order.expiresAt) && order.payable === true, {
    expiresAt: order.expiresAt,
    payable: order.payable,
  });

  const otherBuyer = await buyer();
  const foreign = await fetch(`${BASE}/api/orders/${order.id}/invoice`, { method: "POST", headers: otherBuyer.headers });
  check("P0-3: чужой заказ оплатить нельзя (404)", foreign.status === 404, foreign.status);

  const anon = await fetch(`${BASE}/api/orders/${order.id}/invoice`, { method: "POST" });
  check("P0-3: без авторизации 401", anon.status === 401, anon.status);

  const bad = await fetch(`${BASE}/api/orders/not-a-uuid/invoice`, { method: "POST", headers: b1.headers });
  check("P0-3: мусорный id → 400", bad.status === 400, bad.status);

  // оплаченный заказ повторно не оплачивается
  const cb = JSON.stringify({ event_id: `evt-${crypto.randomUUID().slice(0, 8)}`, order_id: order.id, status: "paid", amount_minor: order.totalMinor });
  const sig = crypto.createHmac("sha256", PAY_SECRET).update(cb).digest("hex");
  await fetch(`${BASE}/api/webhooks/payment`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-payment-signature": sig },
    body: cb,
  });
  const afterPaid = await fetch(`${BASE}/api/orders/${order.id}/invoice`, { method: "POST", headers: b1.headers });
  check("P0-3: для оплаченного заказа инвойс не создаётся (409)", afterPaid.status === 409, afterPaid.status);
}

/* ─────────── P0-1: автоотмена брошенного заказа + возврат остатка ─────────── */
{
  const b = await buyer();
  const before = await stockOf(product.id);
  const order = (await newOrder(b.headers, product.id, 2)).body.order;
  check("P0-1: остаток зарезервирован при создании", (await stockOf(product.id)) === before - 2);

  // «состариваем» заказ на 3 часа
  await pool.query("update orders set created_at = now() - interval '3 hours' where id = $1", [order.id]);
  await resetMock();

  const cron = await fetch(`${BASE}/api/cron/expire-orders`, { headers: { authorization: `Bearer ${CRON_SECRET}` } });
  const cronBody = await cron.json();
  check("P0-1: крон автоотмены отрабатывает", cron.status === 200 && cronBody.cancelled >= 1, cronBody);

  const { rows } = await pool.query("select status from orders where id = $1", [order.id]);
  check("P0-1: просроченный заказ отменён", rows[0].status === "cancelled", rows[0].status);
  check("P0-1: остаток вернулся на склад", (await stockOf(product.id)) === before, {
    before,
    after: await stockOf(product.id),
  });
  const note = await waitForCall("sendMessage", (b) => String(b.text ?? "").includes("отменён"));
  check("P0-1: покупателю пришло уведомление об отмене", Boolean(note), note?.body?.text);

  const cronAnon = await fetch(`${BASE}/api/cron/expire-orders`);
  check("крон защищён секретом (401 без CRON_SECRET)", cronAnon.status === 401, cronAnon.status);

  // повторный запуск ничего не ломает
  const cronAgain = await (await fetch(`${BASE}/api/cron/expire-orders`, { headers: { authorization: `Bearer ${CRON_SECRET}` } })).json();
  check("крон идемпотентен: второй прогон не отменяет тот же заказ", cronAgain.orderNumbers?.includes(order.orderNumber) !== true, cronAgain);
}

/* ─────────── P0-2: successful_payment со сверкой суммы ─────────── */
{
  const b = await buyer();
  const order = (await newOrder(b.headers, product.id, 1)).body.order;
  await resetMock();

  const wrong = await fetch(`${BASE}/api/webhooks/telegram`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": WH },
    body: JSON.stringify({
      update_id: 700,
      message: {
        chat: { id: 1 },
        successful_payment: {
          invoice_payload: `order_${order.id}`,
          currency: "XTR",
          total_amount: 1,
          telegram_payment_charge_id: `c-${crypto.randomUUID()}`,
        },
      },
    }),
  });
  const { rows: afterWrong } = await pool.query("select status from orders where id = $1", [order.id]);
  check("P0-2: платёж с неверной суммой не помечает заказ оплаченным", afterWrong[0].status === "pending_payment", afterWrong[0].status);
  check("P0-2: вебхук всё равно отвечает 200 (Telegram не ретраит)", wrong.status === 200, wrong.status);
  const alert = await waitForCall("sendMessage", (b) => String(b.chat_id) === ADMIN_CHAT && String(b.text ?? "").includes("не совпадает"));
  check("P0-2: админ получил алерт о несовпадении суммы", Boolean(alert), alert?.body?.text);

  // правильная сумма проходит
  const expected = (await (await fetch(`${BASE}/api/orders/${order.id}/invoice`, { method: "POST", headers: b.headers })).json()).invoiceUrl;
  check("P0-3: инвойс создаётся через mock Bot API", expected === "https://t.me/$mock-invoice-link", expected);

  const stars = Math.max(1, Math.ceil(order.totalMinor / 130));
  await resetMock();
  const ok = await fetch(`${BASE}/api/webhooks/telegram`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": WH },
    body: JSON.stringify({
      update_id: 701,
      message: {
        chat: { id: 1 },
        successful_payment: {
          invoice_payload: `order_${order.id}`,
          currency: "XTR",
          total_amount: stars,
          telegram_payment_charge_id: `c-${crypto.randomUUID()}`,
        },
      },
    }),
  });
  const { rows: afterOk } = await pool.query("select status, payment_provider from orders where id = $1", [order.id]);
  check("P0-2: платёж с верной суммой помечает заказ оплаченным", ok.status === 200 && afterOk[0].status === "paid", afterOk[0]);
  check("P0-2: провайдер платежа зафиксирован", afterOk[0].payment_provider === "telegram_stars", afterOk[0].payment_provider);
  const buyerNote = await waitForCall("sendMessage", (b) => String(b.text ?? "").includes("Оплата по заказу"));
  check("P0-2: покупателю ушло подтверждение оплаты", Boolean(buyerNote), buyerNote?.body?.text);
  const adminNote = await waitForCall("sendMessage", (b) => String(b.chat_id) === ADMIN_CHAT && String(b.text ?? "").includes("Новый оплаченный заказ"));
  check("P0-2: админу ушло уведомление о новом заказе", Boolean(adminNote), adminNote?.body?.text);
}

/* ─────────── P1-7: оплата по отменённому заказу ─────────── */
{
  const b = await buyer();
  const order = (await newOrder(b.headers, product.id, 1)).body.order;
  await pool.query("update orders set status = 'cancelled' where id = $1", [order.id]);
  await resetMock();

  const res = await fetch(`${BASE}/api/webhooks/telegram`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": WH },
    body: JSON.stringify({
      update_id: 702,
      message: {
        chat: { id: 1 },
        successful_payment: {
          invoice_payload: `order_${order.id}`,
          currency: "XTR",
          total_amount: Math.max(1, Math.ceil(order.totalMinor / 130)),
          telegram_payment_charge_id: `c-${crypto.randomUUID()}`,
        },
      },
    }),
  });
  const alert = await waitForCall("sendMessage", (b) => String(b.chat_id) === ADMIN_CHAT && String(b.text ?? "").includes("ОТМЕНЁННОМУ"));
  check("P1-7: оплата по отменённому заказу → алерт админу", res.status === 200 && Boolean(alert), alert?.body?.text);
  const { rows } = await pool.query("select status from orders where id = $1", [order.id]);
  check("P1-7: статус отменённого заказа не перезаписывается", rows[0].status === "cancelled", rows[0].status);
  const { rows: events } = await pool.query(
    "select count(*)::int c from payment_events where order_id = $1 and provider = 'telegram'",
    [order.id],
  );
  check("P1-7: событие сохранено для разбора", events[0].c === 1, events[0].c);
}

/* ─────────── P1-8: внешний вебхук с неизвестным заказом ─────────── */
{
  const body = JSON.stringify({ event_id: `evt-${crypto.randomUUID().slice(0, 8)}`, order_id: crypto.randomUUID(), status: "paid" });
  const sig = crypto.createHmac("sha256", PAY_SECRET).update(body).digest("hex");
  const res = await fetch(`${BASE}/api/webhooks/payment`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-payment-signature": sig },
    body,
  });
  check("P1-8: неизвестный order_id → 404 (а не 500)", res.status === 404, res.status);

  const badSigRes = await fetch(`${BASE}/api/webhooks/payment`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-payment-signature": "00" },
    body,
  });
  check("P1-8: неверная подпись → 401", badSigRes.status === 401, badSigRes.status);
}

/* ─────────── P0-33/P0-34: админка переехала в бота ─────────── */
{
  const adminPage = await fetch(`${BASE}/admin`, { redirect: "manual" });
  check("P0-33: веб-панель /admin удалена (404)", adminPage.status === 404, adminPage.status);

  const adminApi = await fetch(`${BASE}/api/admin/upload`, { method: "POST" });
  check("P0-33: /api/admin/* удалён (404)", adminApi.status === 404, adminApi.status);

  const health = await fetch(`${BASE}/api/health`);
  const healthBody = await health.json();
  check(
    "P0-33: /api/health сообщает канал админки bot и проверяет владельца",
    health.status === 200 &&
      healthBody.ok === true &&
      healthBody.adminChannel === "telegram-bot" &&
      (healthBody.checks ?? []).some((c) => c.name === "db:owner_exists"),
    healthBody,
  );
  const raw = JSON.stringify(healthBody);
  check(
    "P0-33: health не раскрывает секреты",
    !raw.includes(process.env.BOT_TOKEN ?? "@@none@@") && !raw.includes(process.env.DATABASE_URL ?? "@@none@@"),
  );

  // Сотрудник из ADMIN_TELEGRAM_ID видит меню, посторонний — нет.
  await resetMock();
  const ownerId = Number(process.env.ADMIN_TELEGRAM_ID ?? 0);
  await tgUpdate({ update_id: 8100, message: { message_id: 1, chat: { id: ownerId }, from: { id: ownerId }, text: "/admin" } });
  const menu = await waitForCall("sendMessage", (b) => String(b.chat_id) === String(ownerId) && String(b.text ?? "").includes("панель управления"));
  check("P0-34: владелец по ADMIN_TELEGRAM_ID получает меню панели", Boolean(menu), menu?.body?.text?.slice(0, 120));

  await resetMock();
  const stranger = 771234;
  await tgUpdate({ update_id: 8101, message: { message_id: 2, chat: { id: stranger }, from: { id: stranger }, text: "/orders" } });
  const denied = await waitForCall("sendMessage", (b) => String(b.chat_id) === String(stranger));
  check(
    "P0-34: посторонний получает отказ со своим ID",
    Boolean(denied) && String(denied.body.text).includes("Нет доступа") && String(denied.body.text).includes(String(stranger)),
    denied?.body?.text,
  );
}

/* ─────────── P0-4 / P0-5: картинки ─────────── */
{
  const seed = await fetch(`${BASE}/seed/mug-dune.png`);
  check("P0-5: демо-картинка сида отдаётся (200, image/png)", seed.status === 200 && seed.headers.get("content-type") === "image/png", [seed.status, seed.headers.get("content-type")]);

  const catalogImages = await (await fetch(`${BASE}/api/catalog`)).json();
  const withImages = catalogImages.products.filter((p) => p.imageUrl);
  check("P0-5: у демо-товаров есть изображения", withImages.length >= 5, withImages.length);
  const firstImg = await fetch(`${BASE}${withImages[0].imageUrl}`);
  check("P0-5: imageUrl из каталога реально открывается", firstImg.status === 200, [withImages[0].imageUrl, firstImg.status]);

  const traversal = await fetch(`${BASE}/uploads/..%2F..%2F.env`);
  check("P0-4: /uploads защищён от path traversal (404)", traversal.status === 404, traversal.status);
  const traversal2 = await fetch(`${BASE}/uploads/%2e%2e/%2e%2e/.env`);
  check("P0-4: /uploads с %2e%2e тоже 404", [404, 400].includes(traversal2.status), traversal2.status);
}

/* ─────────── P1-12: заголовки безопасности ─────────── */
{
  const res = await fetch(`${BASE}/`);
  check("P1-12: X-Content-Type-Options: nosniff", res.headers.get("x-content-type-options") === "nosniff", res.headers.get("x-content-type-options"));
  check("P1-12: Referrer-Policy задан", Boolean(res.headers.get("referrer-policy")), res.headers.get("referrer-policy"));
  check("P1-12: CSP разрешает iframe Telegram и запрещает object", /frame-ancestors[^;]*web\.telegram\.org/.test(res.headers.get("content-security-policy") ?? "") && /object-src 'none'/.test(res.headers.get("content-security-policy") ?? ""), res.headers.get("content-security-policy"));
  check("P1-12: HSTS задан", Boolean(res.headers.get("strict-transport-security")), res.headers.get("strict-transport-security"));
  check("P1-12: X-Powered-By скрыт", res.headers.get("x-powered-by") === null, res.headers.get("x-powered-by"));
}

/* ─────────── P2: устойчивость ─────────── */
{
  // P2-25: чистка rate_limits
  await pool.query("insert into rate_limits (key, count, window_start) values ('stale:test', 1, now() - interval '3 days') on conflict (key) do nothing");
  // снимаем «замок» чистки, иначе она ещё 10 минут не запустится
  await pool.query(
    "insert into rate_limits (key, count, window_start) values ('__cleanup__', 1, now() - interval '30 minutes') on conflict (key) do update set window_start = now() - interval '30 minutes'",
  );
  // Чистка ленивая и запускается из rateLimit(): дергаем любую ручку с лимитом.
  await fetch(`${BASE}/api/auth/telegram`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-real-ip": `10.7.7.${Date.now() % 250}` },
    body: JSON.stringify({ initData: "x" }),
  });
  await sleep(1200);
  const { rows } = await pool.query("select count(*)::int c from rate_limits where key = 'stale:test'");
  check("P2-25: устаревшие записи rate_limits вычищаются", rows[0].c === 0, rows[0].c);

  // /start отдаёт кнопку с web_app
  await resetMock();
  await fetch(`${BASE}/api/webhooks/telegram`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": WH },
    body: JSON.stringify({ update_id: 705, message: { chat: { id: 42 }, text: "/start" } }),
  });
  const start = await waitForCall("sendMessage", (b) => String(b.text ?? "").includes("ГОРН"));
  check("бот отвечает на /start кнопкой мини-приложения", Boolean(start) && Boolean(start.body?.reply_markup?.inline_keyboard?.[0]?.[0]?.web_app?.url), start?.body?.reply_markup);
}

console.log(`\nИТОГО: PASS=${pass}, FAIL=${fails.length}`);
if (fails.length) {
  for (const f of fails) console.log(" -", f.name, String(JSON.stringify(f.extra)).slice(0, 300));
  process.exitCode = 1;
}
await pool.end();
