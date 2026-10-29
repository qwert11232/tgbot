// Гонки и лимиты: атомарность остатков, идемпотентность под нагрузкой, rate limit.
// Запуск: node /home/user/tests/concurrency.mjs
import crypto from "node:crypto";

const BASE = process.env.BASE ?? "http://127.0.0.1:3000";
const BOT_TOKEN = process.env.BOT_TOKEN ?? "123456:TEST-TOKEN";
const WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET ?? "test-webhook-secret";

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

function signInitData(user, authDate = Math.floor(Date.now() / 1000)) {
  const params = new URLSearchParams({ auth_date: String(authDate), user: JSON.stringify(user) });
  const dcs = [...params.entries()].map(([k, v]) => `${k}=${v}`).sort().join("\n");
  const secret = crypto.createHmac("sha256", "WebAppData").update(BOT_TOKEN).digest();
  params.set("hash", crypto.createHmac("sha256", secret).update(dcs).digest("hex"));
  return params.toString();
}

let seq = 920000000;
async function buyer() {
  seq++;
  const r = await fetch(BASE + "/api/auth/telegram", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ initData: signInitData({ id: seq, first_name: "Нагрузка" }) }),
  });
  const d = await r.json();
  return { "content-type": "application/json", authorization: `Bearer ${d.token}` };
}

const order = (key, productId, qty, extra = {}) => ({
  idempotencyKey: key,
  items: [{ productId, qty }],
  customerName: "Тестовый Покупатель",
  phone: "+7 900 111-22-33",
  address: "",
  comment: "",
  ...extra,
});

async function getProduct(id) {
  const r = await fetch(`${BASE}/api/products/${id}`);
  return (await r.json()).product;
}

// находим/создаём товар с остатком 1 через админский API не выйдет — берём из каталога и урезаем напрямую в БД
const { prepareDemoData, pool } = await import("./db.mjs");
await prepareDemoData();

const catalog = await (await fetch(`${BASE}/api/catalog`)).json();
const target = catalog.products.find((p) => p.stock >= 1);
await pool.query("update products set stock = 1 where id = $1", [target.id]);
check("товар для теста гонки: остаток = 1", (await getProduct(target.id)).stock === 1);

const buyers = await Promise.all(Array.from({ length: 8 }, () => buyer()));
const results = await Promise.all(
  buyers.map((headers, i) =>
    fetch(`${BASE}/api/orders`, { method: "POST", headers, body: JSON.stringify(order(crypto.randomUUID(), target.id, 1)) }).then(async (r) => ({ status: r.status, body: await r.json() })),
  ),
);
const okCount = results.filter((r) => r.status === 201).length;
const oosCount = results.filter((r) => r.status === 409 && r.body.code === "out_of_stock").length;
check("8 параллельных заказов на 1 шт: ровно 1 успешный", okCount === 1, results.map((r) => [r.status, r.body.code]));
check("остальные 7 получили out_of_stock", oosCount === 7, oosCount);
check("остаток не ушёл в минус", (await getProduct(target.id)).stock === 0, (await getProduct(target.id)).stock);

// идемпотентность: 6 одинаковых параллельных запросов с одним ключом
await pool.query("update products set stock = 10 where id = $1", [target.id]);
const key = crypto.randomUUID();
const h = await buyer();
const same = await Promise.all(
  Array.from({ length: 6 }, () =>
    fetch(`${BASE}/api/orders`, { method: "POST", headers: h, body: JSON.stringify(order(key, target.id, 2)) }).then(async (r) => ({ status: r.status, body: await r.json() })),
  ),
);
const created = same.filter((r) => r.status === 201).length;
const reused = same.filter((r) => r.status === 200).length;
const inflight = same.filter((r) => r.body?.code === "in_flight").length;
check("параллельный повтор ключа: 1 заказ (201) + остальные 200/409 in_flight", created === 1 && reused + inflight === 5, same.map((r) => [r.status, r.body?.code]));
const distinctIds = new Set(same.filter((r) => r.body?.order).map((r) => r.body.order.id));
check("все ответы ссылаются на один и тот же заказ", distinctIds.size === 1, [...distinctIds]);
check("остаток списан один раз (10 → 8)", (await getProduct(target.id)).stock === 8, (await getProduct(target.id)).stock);

// rate limit заказов: 10/10 мин на пользователя
const rlBuyer = await buyer();
const statuses = [];
for (let i = 0; i < 12; i++) {
  const r = await fetch(`${BASE}/api/orders`, { method: "POST", headers: rlBuyer, body: JSON.stringify(order(crypto.randomUUID(), target.id, 1)) });
  statuses.push(r.status);
}
check("после 10 заказов в окне приходит 429", statuses.filter((s) => s === 429).length >= 1, statuses);

// гонка платёжных вебхуков: один и тот же charge_id приходит дважды одновременно
await pool.query("update products set stock = 5 where id = $1", [target.id]);
const raceBuyer = await buyer();
const raceOrderRes = await fetch(`${BASE}/api/orders`, {
  method: "POST",
  headers: raceBuyer,
  body: JSON.stringify(order(crypto.randomUUID(), target.id, 1)),
});
const raceOrder = raceOrderRes.status === 201 ? (await raceOrderRes.json()).order : null;
if (raceOrder) {
  const charge = `race-${crypto.randomUUID()}`;
  const payload = {
    update_id: 21,
    message: {
      chat: { id: 1 },
      successful_payment: { invoice_payload: `order_${raceOrder.id}`, currency: "XTR", total_amount: 1, telegram_payment_charge_id: charge },
    },
  };
  const hooks = await Promise.all(
    Array.from({ length: 3 }, () =>
      fetch(`${BASE}/api/webhooks/telegram`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": WEBHOOK_SECRET },
        body: JSON.stringify(payload),
      }).then((r) => r.status),
    ),
  );
  check("параллельные дубликаты платёжного вебхука все отвечают 200", hooks.every((s) => s === 200), hooks);
  const { rows } = await pool.query("select count(*)::int c from payment_events where external_event_id = $1", [charge]);
  check("платёжное событие записано ровно один раз", rows[0].c === 1, rows[0].c);
} else {
  check("тест гонки вебхуков: удалось создать заказ", false, raceOrderRes.status);
}

console.log(`\nИТОГО: PASS=${pass}, FAIL=${fails.length}`);
if (fails.length) {
  for (const f of fails) console.log(" -", f.name, String(JSON.stringify(f.extra)).slice(0, 300));
  process.exitCode = 1;
}
await pool.end();
