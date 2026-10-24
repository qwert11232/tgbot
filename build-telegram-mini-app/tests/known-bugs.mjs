// Воспроизведение найденных дефектов. Скрипт ничего не «проверяет» — он печатает
// факт: подтверждён баг или поведение корректно. Запускается вручную:
//   node tests/known-bugs.mjs
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { prepareDemoData, pool, DATABASE_URL } from "./db.mjs";

const require = createRequire(import.meta.url);
const flight = require("next/dist/compiled/react-server-dom-webpack/client.node.js");
const { SignJWT } = require("jose");

const BASE = process.env.BASE ?? "http://127.0.0.1:3000";
const BOT_TOKEN = process.env.BOT_TOKEN ?? "123456:TEST-TOKEN";
const WH = process.env.TELEGRAM_WEBHOOK_SECRET ?? "test-webhook-secret";
const PAY_SECRET = process.env.PAYMENT_WEBHOOK_SECRET ?? "pay-webhook-secret";
const ADMIN_SECRET = process.env.ADMIN_SESSION_SECRET ?? "0123456789abcdef0123456789abcdef";

await prepareDemoData();

function verdict(name, isBug, detail) {
  console.log(`${isBug ? "БАГ ПОДТВЕРЖДЁН" : "ОК            "}  ${name}`);
  if (detail !== undefined) console.log(`                 ${typeof detail === "string" ? detail : JSON.stringify(detail)}`);
}

function initData(id) {
  const p = new URLSearchParams({ auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify({ id, first_name: "Баг" }) });
  const dcs = [...p.entries()].map(([k, v]) => `${k}=${v}`).sort().join("\n");
  const s = crypto.createHmac("sha256", "WebAppData").update(BOT_TOKEN).digest();
  p.set("hash", crypto.createHmac("sha256", s).update(dcs).digest("hex"));
  return p.toString();
}

let seq = 950000000;
async function buyer() {
  seq++;
  const r = await fetch(`${BASE}/api/auth/telegram`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ initData: initData(seq) }),
  });
  const d = await r.json();
  return { "content-type": "application/json", authorization: `Bearer ${d.token}` };
}

async function newOrder(headers, productId, qty = 1) {
  const r = await fetch(`${BASE}/api/orders`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      idempotencyKey: crypto.randomUUID(),
      items: [{ productId, qty }],
      customerName: "Тест Багов",
      phone: "+7 900 000-00-00",
      address: "",
      comment: "",
    }),
  });
  return { status: r.status, body: await r.json() };
}

async function stock(productId) {
  return (await (await fetch(`${BASE}/api/products/${productId}`)).json()).product.stock;
}

const catalog = await (await fetch(`${BASE}/api/catalog`)).json();
const product = catalog.products.find((p) => p.stock > 5);
const buyerH = await buyer();

// 1. Заброшенный заказ держит остаток навсегда (нет TTL/крона)
{
  const before = await stock(product.id);
  const created = await newOrder(buyerH, product.id, 2);
  await new Promise((r) => setTimeout(r, 1500));
  const after = await stock(product.id);
  const { rows } = await pool.query("select count(*)::int c from orders where status = 'pending_payment'");
  verdict(
    "Неоплаченный заказ навсегда списывает остаток (нет отмены по таймауту)",
    after === before - 2,
    `остаток ${before} → ${after}, заказов в pending_payment: ${rows[0].c}; механизма релиза остатков в коде нет`,
  );
  // и заказ нельзя оплатить повторно: в GET /api/orders нет ссылки на инвойс
  const list = await (await fetch(`${BASE}/api/orders`, { headers: buyerH })).json();
  verdict(
    "Повторно получить ссылку на оплату заказа нельзя (нет invoiceUrl в GET /api/orders)",
    !("invoiceUrl" in list.orders[0]),
    `ключи ответа: ${Object.keys(list.orders[0]).join(", ")}`,
  );
}

// 2. successful_payment не сверяет сумму с заказом
{
  const o = (await newOrder(buyerH, product.id, 1)).body.order;
  const r = await fetch(`${BASE}/api/webhooks/telegram`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": WH },
    body: JSON.stringify({
      update_id: 500,
      message: {
        chat: { id: 1 },
        successful_payment: {
          invoice_payload: `order_${o.id}`,
          currency: "XTR",
          total_amount: 1,
          telegram_payment_charge_id: `c-${crypto.randomUUID()}`,
        },
      },
    }),
  });
  const { rows } = await pool.query("select status from orders where id = $1", [o.id]);
  verdict(
    "successful_payment не сверяет сумму/валюту (заказ на 3490 ₽ «оплачен» 1 звездой)",
    rows[0].status === "paid" && o.totalMinor > 100,
    `заказ totalMinor=${o.totalMinor}, оплата 1 XTR, статус: ${rows[0].status}, HTTP: ${r.status}`,
  );
}

// 3. Оплата по отменённому заказу: деньги списаны, заказ остаётся отменённым
{
  const o = (await newOrder(buyerH, product.id, 1)).body.order;
  const cb = JSON.stringify({ event_id: `evt-${crypto.randomUUID().slice(0, 8)}`, order_id: o.id, status: "cancelled" });
  const sig = crypto.createHmac("sha256", PAY_SECRET).update(cb).digest("hex");
  await fetch(`${BASE}/api/webhooks/payment`, { method: "POST", headers: { "content-type": "application/json", "x-payment-signature": sig }, body: cb });
  await fetch(`${BASE}/api/webhooks/telegram`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": WH },
    body: JSON.stringify({
      update_id: 501,
      message: {
        chat: { id: 1 },
        successful_payment: { invoice_payload: `order_${o.id}`, currency: "XTR", total_amount: 1, telegram_payment_charge_id: `c-${crypto.randomUUID()}` },
      },
    }),
  });
  const { rows } = await pool.query("select status, paid_at from orders where id = $1", [o.id]);
  verdict(
    "Оплата по уже отменённому заказу: вебхук отвечает 200, деньги не возвращаются, алерта нет",
    rows[0].status === "cancelled",
    `статус: ${rows[0].status}, paid_at: ${rows[0].paid_at}; обработчик просто не меняет статус`,
  );
}

// 4. Внешний вебхук с неизвестным order_id → 500 (ветка 404 недостижима: FK срабатывает раньше)
{
  const body = JSON.stringify({ event_id: `evt-${crypto.randomUUID().slice(0, 8)}`, order_id: crypto.randomUUID(), status: "paid" });
  const sig = crypto.createHmac("sha256", PAY_SECRET).update(body).digest("hex");
  const r = await fetch(`${BASE}/api/webhooks/payment`, { method: "POST", headers: { "content-type": "application/json", "x-payment-signature": sig }, body });
  verdict("Внешний вебхук с несуществующим заказом отдаёт 500 вместо 404/200", r.status === 500, `HTTP ${r.status}: ${await r.text()}`);
}

// 5. Демо-картинки из сида отсутствуют в репозитории
for (const url of ["/seed/mug-dune.jpg", "/seed/plate.jpg"]) {
  const r = await fetch(BASE + url);
  verdict(`Демо-изображение ${url} из сида`, r.status === 404, `HTTP ${r.status} — в репозитории нет каталога public/seed`);
}

// 6. XFF подменяется клиентом → лимит логина на IP обходится
{
  const manifest = JSON.parse(
    require("node:fs").readFileSync(process.env.ACTION_MANIFEST ?? ".next/server/server-reference-manifest.json", "utf8"),
  );
  const loginId = Object.entries(manifest.node).find(([, v]) => v.exportedName === "loginAction")[0];
  let blocked = 0;
  for (let i = 0; i < 12; i++) {
    const fd = new FormData();
    fd.set("email", "admin@gorn.local");
    fd.set("password", "definitely-wrong");
    const res = await fetch(`${BASE}/admin/login`, {
      method: "POST",
      headers: { "next-action": loginId, origin: BASE, "x-forwarded-for": `10.1.0.${i}` },
      body: await flight.encodeReply([{}, fd]),
    });
    if ((await res.text()).includes("Слишком много попыток")) blocked++;
  }
  verdict("Лимит попыток логина обходится подменой X-Forwarded-For", blocked === 0, `из 12 попыток заблокировано ${blocked}`);
}

// 7. Ошибки БД уходят в браузер админа вместе с SQL и хешем пароля
{
  const { rows } = await pool.query("select * from staff_users where role = 'owner' limit 1");
  const owner = rows[0];
  const sid = crypto.randomUUID();
  await pool.query("insert into staff_sessions (id, user_id, expires_at) values ($1, $2, $3)", [sid, owner.id, new Date(Date.now() + 3600e3)]);
  const jwt = await new SignJWT({ sid, sub: owner.id, sv: owner.session_version })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(new TextEncoder().encode(ADMIN_SECRET));
  const manifest = JSON.parse(
    require("node:fs").readFileSync(process.env.ACTION_MANIFEST ?? ".next/server/server-reference-manifest.json", "utf8"),
  );
  const createStaffId = Object.entries(manifest.node).find(([, v]) => v.exportedName === "createStaffAction")[0];
  const res = await fetch(`${BASE}/admin/staff`, {
    method: "POST",
    headers: { "next-action": createStaffId, "content-type": "text/plain;charset=UTF-8", origin: BASE, cookie: `admin_session=${jwt}` },
    body: JSON.stringify([{ email: owner.email, name: "Дубль", password: "password-123", role: "manager" }]),
  });
  const text = await res.text();
  verdict(
    "Дубликат email в админке: в ответ уходит сырой SQL с параметрами ($2b$12$… — хеш пароля)",
    text.includes("Failed query") && /params:.*\$2[aby]\$/.test(text),
    text.split("\n").find((l) => l.includes('"ok"'))?.slice(0, 220),
  );
}

// 8. Тихая «успешность» при сбросе пароля несуществующему сотруднику
{
  const manifest = JSON.parse(
    require("node:fs").readFileSync(process.env.ACTION_MANIFEST ?? ".next/server/server-reference-manifest.json", "utf8"),
  );
  const resetId = Object.entries(manifest.node).find(([, v]) => v.exportedName === "resetStaffPasswordAction")[0];
  const { rows } = await pool.query("select * from staff_users where role = 'owner' limit 1");
  const owner = rows[0];
  const sid = crypto.randomUUID();
  await pool.query("insert into staff_sessions (id, user_id, expires_at) values ($1, $2, $3)", [sid, owner.id, new Date(Date.now() + 3600e3)]);
  const jwt = await new SignJWT({ sid, sub: owner.id, sv: owner.session_version })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(new TextEncoder().encode(ADMIN_SECRET));
  const res = await fetch(`${BASE}/admin/staff`, {
    method: "POST",
    headers: { "next-action": resetId, "content-type": "text/plain;charset=UTF-8", origin: BASE, cookie: `admin_session=${jwt}` },
    body: JSON.stringify([crypto.randomUUID(), "password-123"]),
  });
  const text = await res.text();
  verdict("Сброс пароля несуществующему сотруднику возвращает ok:true", text.includes('"ok":true'), text.split("\n").find((l) => l.includes('"ok"')));
}

// 9. Личный кабинет: нет способа оплатить уже созданный заказ из UI
{
  const html = await (await fetch(`${BASE}/app/orders`)).text();
  verdict(
    "На странице «Мои заказы» нет кнопки оплаты созданного заказа",
    !/openInvoice|Оплатить/i.test(html),
    "корзина очищается сразу после создания заказа (checkout/page.tsx:89), а ссылку на инвойс отдают только при создании",
  );
}

console.log(`\nБД: ${DATABASE_URL}`);
await pool.end();
