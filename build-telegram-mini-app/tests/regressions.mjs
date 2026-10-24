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
const flight = require("next/dist/compiled/react-server-dom-webpack/client.node.js");
const { SignJWT } = require("jose");

const BASE = process.env.BASE ?? "http://127.0.0.1:3000";
const BOT_TOKEN = process.env.BOT_TOKEN ?? "123456:TEST-TOKEN";
const WH = process.env.TELEGRAM_WEBHOOK_SECRET ?? "test-webhook-secret";
const PAY_SECRET = process.env.PAYMENT_WEBHOOK_SECRET ?? "pay-webhook-secret";
const ADMIN_SECRET = process.env.ADMIN_SESSION_SECRET ?? "0123456789abcdef0123456789abcdef";
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

/* ─────────── P1-9: лимит логина не обходится X-Forwarded-For ─────────── */
{
  const manifest = JSON.parse(readFileSync(process.env.ACTION_MANIFEST ?? ".next/server/server-reference-manifest.json", "utf8"));
  const loginId = Object.entries(manifest.node).find(([, v]) => v.exportedName === "loginAction")[0];
  await pool.query("delete from rate_limits where key like 'admin-login:%'");

  let blocked = 0;
  for (let i = 0; i < 12; i++) {
    const fd = new FormData();
    fd.set("email", "admin@gorn.local");
    fd.set("password", "definitely-wrong");
    const res = await fetch(`${BASE}/admin/login`, {
      method: "POST",
      headers: { "next-action": loginId, origin: BASE, "x-forwarded-for": `10.2.0.${i}` },
      body: await flight.encodeReply([{}, fd]),
    });
    if ((await res.text()).includes("Слишком много попыток")) blocked++;
  }
  check("P1-9: 12 попыток с разных IP блокируются лимитом на email", blocked >= 4, `заблокировано ${blocked}`);

  // другой email с того же IP тоже лимитируется по IP
  await pool.query("delete from rate_limits where key like 'admin-login:%'");
  let blocked2 = 0;
  for (let i = 0; i < 12; i++) {
    const fd = new FormData();
    fd.set("email", `nobody${i}@gorn.local`);
    fd.set("password", "definitely-wrong");
    const res = await fetch(`${BASE}/admin/login`, {
      method: "POST",
      headers: { "next-action": loginId, origin: BASE, "x-real-ip": "10.3.0.9" },
      body: await flight.encodeReply([{}, fd]),
    });
    if ((await res.text()).includes("Слишком много попыток")) blocked2++;
  }
  check("P1-9: лимит по IP (x-real-ip) тоже работает", blocked2 >= 4, `заблокировано ${blocked2}`);
  await pool.query("delete from rate_limits where key like 'admin-login:%'");
}

/* ─────────── P1-10 / P0-6: админские actions ─────────── */
{
  const { rows } = await pool.query("select * from staff_users where role = 'owner' limit 1");
  const owner = rows[0];
  const sid = crypto.randomUUID();
  await pool.query("insert into staff_sessions (id, user_id, expires_at) values ($1, $2, $3)", [
    sid,
    owner.id,
    new Date(Date.now() + 3600e3),
  ]);
  const jwt = await new SignJWT({ sid, sub: owner.id, sv: owner.session_version })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(new TextEncoder().encode(ADMIN_SECRET));

  const manifest = JSON.parse(readFileSync(process.env.ACTION_MANIFEST ?? ".next/server/server-reference-manifest.json", "utf8"));
  const idOf = (name) => Object.entries(manifest.node).find(([, v]) => v.exportedName === name)[0];
  const call = async (name, args, path = "/admin/staff", cookie = jwt) => {
    const res = await fetch(BASE + path, {
      method: "POST",
      redirect: "manual",
      headers: { "next-action": idOf(name), "content-type": "text/plain;charset=UTF-8", origin: BASE, cookie: `admin_session=${cookie}` },
      body: JSON.stringify(args),
    });
    return { status: res.status, body: await res.text() };
  };

  const dup = await call("createStaffAction", [{ email: owner.email, name: "Дубль", password: "password-123", role: "manager" }]);
  check(
    "P0-6: дубликат email → безопасный текст без SQL и хеша",
    dup.body.includes('"ok":false') && /уже существует/.test(dup.body) && !/Failed query|params:|\$2[aby]\$/.test(dup.body),
    dup.body.slice(0, 200),
  );

  const ghost = await call("resetStaffPasswordAction", [crypto.randomUUID(), "password-123"]);
  check("P1-10: сброс пароля несуществующему → ok:false", ghost.body.includes('"ok":false') && ghost.body.includes("не найден"), ghost.body.slice(0, 200));

  const ghostDelete = await call("deleteStaffAction", [crypto.randomUUID()]);
  check("P1-10: удаление несуществующего → ok:false", ghostDelete.body.includes('"ok":false'), ghostDelete.body.slice(0, 200));

  const ghostCategory = await call(
    "createProductAction",
    [{ name: "Товар с битой категорией", description: "", categoryId: crypto.randomUUID(), priceRub: "100", stock: 1, isActive: true }],
    "/admin/products/new",
  );
  check(
    "P0-6: несуществующая категория → понятная ошибка, в БД не падает",
    ghostCategory.body.includes('"ok":false') && ghostCategory.body.includes("категория") && !/Failed query/.test(ghostCategory.body),
    ghostCategory.body.slice(0, 200),
  );

  /* P1-13: возврат на исходную страницу после логина */
  const fd = new FormData();
  fd.set("email", owner.email);
  fd.set("password", "gorn-admin-2026");
  fd.set("next", "/admin/orders");
  const login = await fetch(`${BASE}/admin/login`, {
    method: "POST",
    redirect: "manual",
    headers: { "next-action": idOf("loginAction"), origin: BASE, "x-real-ip": "10.9.9.9" },
    body: await flight.encodeReply([{}, fd]),
  });
  const redirectTarget = login.headers.get("location") ?? login.headers.get("x-action-redirect") ?? "";
  check(
    "P1-13: после логина редирект на ?next=/admin/orders",
    [303, 307].includes(login.status) && redirectTarget.includes("/admin/orders"),
    [login.status, redirectTarget],
  );

  // open redirect: next= с внешним адресом не должен уводить с сайта после логина
  const fd2 = new FormData();
  fd2.set("email", owner.email);
  fd2.set("password", "gorn-admin-2026");
  fd2.set("next", "https://evil.example/phish");
  const evilNext = await fetch(`${BASE}/admin/login`, {
    method: "POST",
    redirect: "manual",
    headers: { "next-action": idOf("loginAction"), origin: BASE, "x-real-ip": "10.9.9.10" },
    body: await flight.encodeReply([{}, fd2]),
  });
  const evilTarget = evilNext.headers.get("location") ?? evilNext.headers.get("x-action-redirect") ?? "";
  check(
    "P1-13: внешний next= не даёт open redirect (уходим на /admin)",
    !evilTarget.includes("evil.example") && evilTarget.includes("/admin"),
    [evilNext.status, evilTarget],
  );

  /* P1-14: авторизованный не видит форму логина */
  const sid2 = crypto.randomUUID();
  await pool.query("insert into staff_sessions (id, user_id, expires_at) values ($1, $2, $3)", [sid2, owner.id, new Date(Date.now() + 3600e3)]);
  const jwt2 = await new SignJWT({ sid: sid2, sub: owner.id, sv: owner.session_version })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(new TextEncoder().encode(ADMIN_SECRET));
  const loginPage = await fetch(`${BASE}/admin/login`, { headers: { cookie: `admin_session=${jwt2}` }, redirect: "manual" });
  check("P1-14: /admin/login с активной сессией → редирект на /admin", loginPage.status === 307 || loginPage.status === 308, loginPage.status);
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
