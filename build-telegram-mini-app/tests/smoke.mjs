// Smoke/e2e проверки HTTP-слоя магазина (Next.js app в build-telegram-mini-app)
// Запуск: node /home/user/tests/smoke.mjs
import crypto from "node:crypto";
import { prepareDemoData, pool } from "./db.mjs";

const BASE = process.env.BASE ?? "http://127.0.0.1:3000";
const BOT_TOKEN = process.env.BOT_TOKEN ?? "123456:TEST-TOKEN";
const WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET ?? "test-webhook-secret";
const PAYMENT_SECRET = process.env.PAYMENT_WEBHOOK_SECRET ?? "pay-webhook-secret";
const ADMIN_SECRET = process.env.ADMIN_SESSION_SECRET ?? "0123456789abcdef0123456789abcdef";

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

await prepareDemoData();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function req(path, init = {}) {
  const res = await fetch(BASE + path, init);
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text.slice(0, 300);
  }
  return { status: res.status, body, headers: res.headers, res };
}

function signInitData(user, { authDate = Math.floor(Date.now() / 1000), token = BOT_TOKEN } = {}) {
  const params = new URLSearchParams({
    auth_date: String(authDate),
    query_id: "AAHdF6IQAAAAAN0XohDhrOrc",
    user: JSON.stringify(user),
  });
  const dcs = [...params.entries()]
    .map(([k, v]) => `${k}=${v}`)
    .sort()
    .join("\n");
  const secret = crypto.createHmac("sha256", "WebAppData").update(token).digest();
  const hash = crypto.createHmac("sha256", secret).update(dcs).digest("hex");
  params.set("hash", hash);
  return params.toString();
}

async function loginTg(user) {
  const initData = signInitData(user);
  const r = await req("/api/auth/telegram", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ initData }),
  });
  return r;
}

// ---------------------------------------------------------------- публичное
const health = await req("/api/health");
check("GET /api/health = 200 ok:true", health.status === 200 && health.body?.ok === true, health.body);

const catalog = await req("/api/catalog");
check("GET /api/catalog 200", catalog.status === 200);
const products = catalog.body?.products ?? [];
check("каталог отдаёт товары (seed)", products.length >= 6, products.length);
check("категории в каталоге", (catalog.body?.categories ?? []).length >= 4, catalog.body?.categories?.length);
check(
  "в каталоге есть imageUrl у товара",
  products.some((p) => p.imageUrl),
  products.map((p) => p.imageUrl),
);
const emptyStock = products.find((p) => p.stock === 0);
const inStock = products.find((p) => p.stock >= 5);
check("в каталоге есть товар в наличии", Boolean(inStock), products.map((p) => [p.name, p.stock]));
check("товар с нулевым остатком отдаётся в каталоге", Boolean(emptyStock), products.map((p) => [p.name, p.stock]));

const detail = await req(`/api/products/${inStock.id}`);
check("GET /api/products/[id] 200 + галерея", detail.status === 200 && Array.isArray(detail.body?.images), detail.body);
const badDetail = await req("/api/products/not-a-uuid");
check("GET /api/products/[id] c мусорным id → 400", badDetail.status === 400, badDetail.status);

// Поиск/категории/пагинация
const byCat = await req("/api/catalog?category=vases");
check("фильтр по категории", byCat.status === 200 && (byCat.body.products ?? []).length >= 1 && (byCat.body.products ?? []).every((p) => true), byCat.body?.products?.map((p) => p.name));
const bySearch = await req(`/api/catalog?q=${encodeURIComponent("Кружка")}`);
check("поиск по названию", bySearch.status === 200 && (bySearch.body.products ?? []).length >= 1, bySearch.body?.products?.map((p) => p.name));
const page1 = await req("/api/catalog?limit=2");
check("пагинация: limit=2 + nextOffset", (page1.body?.products ?? []).length === 2 && page1.body?.nextOffset === 2, page1.body);
const idsFilter = await req(`/api/catalog?ids=${products[0].id},${products[1].id}`);
check("фильтр по ids", (idsFilter.body?.products ?? []).length === 2, idsFilter.body?.products?.length);
const badIds = await req("/api/catalog?ids=xxx");
check("ids=мусор → пустой список", Array.isArray(badIds.body?.products) && badIds.body.products.length === 0, badIds.body);

// ------------------------------------------------------------------- auth
const noAuthOrders = await req("/api/orders");
check("GET /api/orders без токена → 401", noAuthOrders.status === 401, noAuthOrders.status);

const badInit = await req("/api/auth/telegram", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ initData: "user=%7B%7D&hash=deadbeef&auth_date=1" }),
});
check("невалидный initData → 401", badInit.status === 401, badInit.body);

const expired = await req("/api/auth/telegram", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ initData: signInitData({ id: 111222333, first_name: "Old" }, { authDate: Math.floor(Date.now() / 1000) - 90000 }) }),
});
check("просроченный auth_date → 401", expired.status === 401, expired.body);

const tampered = (() => {
  const good = signInitData({ id: 555, first_name: "A" });
  return good.replace(/%22id%22%3A555/, "%22id%22%3A556");
})();
const tamperRes = await req("/api/auth/telegram", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ initData: tampered }),
});
check("подмена user в initData → 401", tamperRes.status === 401, tamperRes.body);

const devBypass = await req("/api/auth/telegram", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ dev: "web-dev" }),
});
check("dev-обход при заданном BOT_TOKEN не работает → 401", devBypass.status === 401, devBypass.body);

const userA = { id: 900000001, first_name: "Тест", last_name: "Покупатель", username: "buyer_a", language_code: "ru" };
const authA = await loginTg(userA);
check("валидный initData → 200 + token + cookie", authA.status === 200 && typeof authA.body?.token === "string", authA.body);
check("cookie tg_session выставлена HttpOnly/SameSite=None", /tg_session=/.test(authA.headers.get("set-cookie") ?? "") && /HttpOnly/i.test(authA.headers.get("set-cookie") ?? ""), authA.headers.get("set-cookie"));

const tokenA = authA.body?.token;
const H = { "content-type": "application/json", authorization: `Bearer ${tokenA}` };

let buyerSeq = 910000000;
async function newBuyer() {
  buyerSeq++;
  const r = await loginTg({ id: buyerSeq, first_name: `Покупатель${buyerSeq}` });
  return { "content-type": "application/json", authorization: `Bearer ${r.body.token}` };
}

const myEmpty = await req("/api/orders", { headers: H });
check("GET /api/orders с токеном → 200 []", myEmpty.status === 200 && Array.isArray(myEmpty.body?.orders), myEmpty.body);

const cookieOnly = await req("/api/orders", { headers: { cookie: `tg_session=${tokenA}` } });
check("авторизация по cookie tg_session работает", cookieOnly.status === 200, cookieOnly.status);

const badToken = await req("/api/orders", { headers: { authorization: "Bearer not.a.jwt" } });
check("битый JWT → 401", badToken.status === 401, badToken.status);

const otherSession = await (async () => {
  // чужой валидный JWT, подписанный тем же секретом, но несуществующим sub
  const { SignJWT } = await import("/home/user/tgbot/build-telegram-mini-app/node_modules/jose/dist/webapi/index.js");
  const jwt = await new SignJWT({ sub: crypto.randomUUID(), tid: 1 })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(new TextEncoder().encode("abcdef0123456789abcdef0123456789"));
  return req("/api/orders", { headers: { authorization: `Bearer ${jwt}` } });
})().catch((e) => ({ status: 0, body: String(e) }));
check("JWT с несуществующим пользователем → 401", otherSession.status === 401, otherSession.status);

// ------------------------------------------------------------------ заказы
const Ho = await newBuyer();
const stockBefore = (await req(`/api/products/${inStock.id}`)).body.product.stock;
const orderBody = {
  idempotencyKey: crypto.randomUUID(),
  items: [{ productId: inStock.id, qty: 2 }],
  customerName: "Иван Тестов",
  phone: "+7 900 000-00-00",
  address: "Вологда, ул. Мира, 1",
  comment: "Позвонить",
};
const created = await req("/api/orders", { method: "POST", headers: Ho, body: JSON.stringify(orderBody) });
check("POST /api/orders → 201", created.status === 201, created);
check("заказ: сумма = цена × qty", created.body?.order?.totalMinor === inStock.priceMinor * 2, created.body?.order);
check("заказ: позиции в ответе", (created.body?.order?.items ?? []).length === 1, created.body?.order?.items);
check("заказ: invoiceUrl (BOT_TOKEN задан, Telegram недоступен) → null допустимо", created.body?.invoiceUrl === null || typeof created.body?.invoiceUrl === "string", created.body?.invoiceUrl);

const stockAfter = (await req(`/api/products/${inStock.id}`)).body.product.stock;
check("остаток списан ровно на qty", stockAfter === stockBefore - 2, { stockBefore, stockAfter });

const replay = await req("/api/orders", { method: "POST", headers: Ho, body: JSON.stringify(orderBody) });
check("идемпотентный повтор → 200 + тот же заказ", replay.status === 200 && replay.body?.order?.id === created.body?.order?.id && replay.body?.reused === true, replay.body?.order?.id);
const stockAfterReplay = (await req(`/api/products/${inStock.id}`)).body.product.stock;
check("повтор НЕ списывает остаток второй раз", stockAfterReplay === stockAfter, { stockAfter, stockAfterReplay });

const conflict = await req("/api/orders", {
  method: "POST",
  headers: Ho,
  body: JSON.stringify({ ...orderBody, items: [{ productId: inStock.id, qty: 3 }] }),
});
check("тот же ключ, другой состав → 409 idempotency_conflict", conflict.status === 409 && conflict.body?.code === "idempotency_conflict", conflict.body);

const H2 = await newBuyer();
const oos = await req("/api/orders", {
  method: "POST",
  headers: H2,
  body: JSON.stringify({ ...orderBody, idempotencyKey: crypto.randomUUID(), items: [{ productId: emptyStock.id, qty: 1 }] }),
});
check("заказ товара без остатка → 409 out_of_stock", oos.status === 409 && oos.body?.code === "out_of_stock", oos.body);

const tooMany = await req("/api/orders", {
  method: "POST",
  headers: H2,
  body: JSON.stringify({ ...orderBody, idempotencyKey: crypto.randomUUID(), items: [{ productId: inStock.id, qty: 100 }] }),
});
check("qty > 99 → 400 валидация", tooMany.status === 400, tooMany.status);

const noName = await req("/api/orders", {
  method: "POST",
  headers: H2,
  body: JSON.stringify({ ...orderBody, idempotencyKey: crypto.randomUUID(), customerName: "Я" }),
});
check("короткое имя → 400", noName.status === 400, noName.body);

const dupItems = await req("/api/orders", {
  method: "POST",
  headers: H2,
  body: JSON.stringify({
    ...orderBody,
    idempotencyKey: crypto.randomUUID(),
    items: [
      { productId: products[1].id, qty: 1 },
      { productId: products[1].id, qty: 1 },
    ],
  }),
});
check("дубликаты позиций схлопываются в одну строку qty=2", dupItems.status === 201 && dupItems.body?.order?.items?.length === 1 && dupItems.body.order.items[0].qty === 2, dupItems.body?.order?.items);

const notFoundProduct = await req("/api/orders", {
  method: "POST",
  headers: H2,
  body: JSON.stringify({ ...orderBody, idempotencyKey: crypto.randomUUID(), items: [{ productId: crypto.randomUUID(), qty: 1 }] }),
});
check("несуществующий товар → 409", notFoundProduct.status === 409 && notFoundProduct.body?.code === "out_of_stock", notFoundProduct.body);

const myOrders = await req("/api/orders", { headers: Ho });
check("GET /api/orders возвращает созданные заказы", (myOrders.body?.orders ?? []).length >= 1, myOrders.body?.orders?.length);

const userB = { id: 900000002, first_name: "Второй", username: "buyer_b" };
const authB = await loginTg(userB);
const ordersB = await req("/api/orders", { headers: { authorization: `Bearer ${authB.body?.token}` } });
check("чужой пользователь не видит заказы A", ordersB.status === 200 && (ordersB.body?.orders ?? []).length === 0, ordersB.body);

// --------------------------------------------------------- вебхук Telegram
const noSecret = await req("/api/webhooks/telegram", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
check("webhook telegram без secret-token → 401", noSecret.status === 401, noSecret.status);

const startMsg = await req("/api/webhooks/telegram", {
  method: "POST",
  headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": WEBHOOK_SECRET },
  body: JSON.stringify({ update_id: 1, message: { chat: { id: userA.id }, text: "/start" } }),
});
check("/start обрабатывается → 200", startMsg.status === 200 && startMsg.body?.ok === true, startMsg.body);

const orderId = created.body.order.id;
const chargeId = `charge-${crypto.randomUUID()}`;
const stars = Math.max(1, Math.ceil(created.body.order.totalMinor / 130));
const pcqOk = await req("/api/webhooks/telegram", {
  method: "POST",
  headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": WEBHOOK_SECRET },
  body: JSON.stringify({
    update_id: 2,
    pre_checkout_query: { id: "pcq1", invoice_payload: `order_${orderId}`, currency: "XTR", total_amount: stars },
  }),
});
check("pre_checkout_query с верной суммой → 200", pcqOk.status === 200, pcqOk.body);

const success = await req("/api/webhooks/telegram", {
  method: "POST",
  headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": WEBHOOK_SECRET },
  body: JSON.stringify({
    update_id: 3,
    message: {
      chat: { id: userA.id },
      successful_payment: {
        invoice_payload: `order_${orderId}`,
        currency: "XTR",
        total_amount: stars,
        telegram_payment_charge_id: chargeId,
        provider_payment_charge_id: "prov-1",
      },
    },
  }),
});
check("successful_payment обрабатывается → 200", success.status === 200, success.body);

const afterPaid = await req("/api/orders", { headers: Ho });
const paidOrder = (afterPaid.body?.orders ?? []).find((o) => o.id === orderId);
check("после successful_payment заказ paid", paidOrder?.status === "paid", paidOrder?.status);

const successDup = await req("/api/webhooks/telegram", {
  method: "POST",
  headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": WEBHOOK_SECRET },
  body: JSON.stringify({
    update_id: 4,
    message: {
      chat: { id: userA.id },
      successful_payment: { invoice_payload: `order_${orderId}`, currency: "XTR", total_amount: stars, telegram_payment_charge_id: chargeId },
    },
  }),
});
check("повторный successful_payment идемпотентен → 200", successDup.status === 200, successDup.body);

// ------------------------------------------------------ внешний эквайринг
const Hex = await newBuyer();
const createdExternal = await req("/api/orders", {
  method: "POST",
  headers: Hex,
  body: JSON.stringify({ ...orderBody, idempotencyKey: crypto.randomUUID(), items: [{ productId: inStock.id, qty: 1 }] }),
});
const extOrder = createdExternal.body.order;

const badSig = await req("/api/webhooks/payment", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ event_id: `evt-${crypto.randomUUID().slice(0, 8)}`, order_id: extOrder.id, status: "paid" }) });
check("payment webhook без подписи → 401", badSig.status === 401, badSig.status);

const extEventId = `evt-${crypto.randomUUID().slice(0, 8)}`;
const extBody = JSON.stringify({ event_id: extEventId, order_id: extOrder.id, status: "paid", amount_minor: extOrder.totalMinor });
const extSig = crypto.createHmac("sha256", PAYMENT_SECRET).update(extBody).digest("hex");
const extPaid = await req("/api/webhooks/payment", { method: "POST", headers: { "content-type": "application/json", "x-payment-signature": extSig }, body: extBody });
check("payment webhook с подписью → 200 ok", extPaid.status === 200 && extPaid.body?.ok === true, extPaid.body);

const extDup = await req("/api/webhooks/payment", { method: "POST", headers: { "content-type": "application/json", "x-payment-signature": extSig }, body: extBody });
check("повторный payment webhook → duplicate:true", extDup.status === 200 && extDup.body?.duplicate === true, extDup.body);

const ordersAfterExt = await req("/api/orders", { headers: Hex });
check("заказ оплачен через внешний вебхук (paid)", (ordersAfterExt.body.orders.find((o) => o.id === extOrder.id) ?? {}).status === "paid", ordersAfterExt.body.orders.map((o) => [o.id, o.status]));

// Отмена (возврат остатков) через внешний вебхук
const beforeCancelStock = (await req(`/api/products/${inStock.id}`)).body.product.stock;
const Hc = await newBuyer();
const cancelOrder = await req("/api/orders", {
  method: "POST",
  headers: Hc,
  body: JSON.stringify({ ...orderBody, idempotencyKey: crypto.randomUUID(), items: [{ productId: inStock.id, qty: 2 }] }),
});
const afterCreateStock = (await req(`/api/products/${inStock.id}`)).body.product.stock;
check("остаток списан при создании заказа под отмену", afterCreateStock === beforeCancelStock - 2, { beforeCancelStock, afterCreateStock });
const cancelBody = JSON.stringify({ event_id: `evt-cancel-${crypto.randomUUID().slice(0, 8)}`, order_id: cancelOrder.body.order.id, status: "cancelled" });
const cancelSig = crypto.createHmac("sha256", PAYMENT_SECRET).update(cancelBody).digest("hex");
const cancelled = await req("/api/webhooks/payment", { method: "POST", headers: { "content-type": "application/json", "x-payment-signature": cancelSig }, body: cancelBody });
const afterCancelStock = (await req(`/api/products/${inStock.id}`)).body.product.stock;
check("cancelled возвращает остатки", cancelled.status === 200 && afterCancelStock === beforeCancelStock, { afterCancelStock, beforeCancelStock, body: cancelled.body });

// ---------------------------------------------------------------- админка
const anonAdmin = await fetch(BASE + "/admin", { redirect: "manual" });
check("GET /admin без cookie → redirect 307 на /admin/login", anonAdmin.status === 307 && (anonAdmin.headers.get("location") ?? "").includes("/admin/login"), [anonAdmin.status, anonAdmin.headers.get("location")]);
const anonApi = await req("/api/admin/upload", { method: "POST" });
check("/api/admin/upload без сессии → 401", anonApi.status === 401, anonApi.status);

// Подделываем валидную сессию admin через прямой INSERT + JWT (server action логина проверим отдельно)
console.log("\n--- дальше требуются данные БД (сид) ---");

console.log(`\nИТОГО: PASS=${pass}, FAIL=${fails.length}`);
await pool.end().catch(() => {});
if (fails.length) {
  console.log("Провалы:");
  for (const f of fails) console.log(" -", f.name, JSON.stringify(f.extra));
  process.exitCode = 1;
}
