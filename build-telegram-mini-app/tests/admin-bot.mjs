// Проверки админки, которая живёт в Telegram-боте: доступ по ролям, заказы,
// товары, сотрудники, отчёты, загрузка фото.
//
// Требует: собранное приложение (npm run build), запущенный сервер с
//   ADMIN_TELEGRAM_ID=700001, TELEGRAM_API_BASE=http://127.0.0.1:3333,
//   TELEGRAM_WEBHOOK_SECRET=test-webhook-secret,
// плюс mock Bot API (node tests/mock-telegram.mjs).
// Запуск: node tests/admin-bot.mjs
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { prepareDemoData, pool } from "./db.mjs";

const BASE = process.env.BASE ?? "http://127.0.0.1:3000";
const WH = process.env.TELEGRAM_WEBHOOK_SECRET ?? "test-webhook-secret";
const MOCK_API = process.env.MOCK_TG ?? "http://127.0.0.1:3333";
const OWNER_ID = Number(process.env.ADMIN_TELEGRAM_ID ?? 700001);
const MANAGER_ID = 700002;

let pass = 0;
const fails = [];
function check(name, cond, extra) {
  if (cond) {
    pass++;
    console.log(`PASS  ${name}`);
  } else {
    fails.push({ name, extra });
    console.log(`FAIL  ${name}${extra !== undefined ? `  << ${JSON.stringify(extra).slice(0, 400)}` : ""}`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let updateId = 10_000;

async function tg(update) {
  updateId += 1;
  const res = await fetch(`${BASE}/api/webhooks/telegram`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": WH },
    body: JSON.stringify({ update_id: updateId, ...update }),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function text(from, message, text, extra = {}) {
  return tg({ message: { message_id: 1, chat: { id: from }, from: { id: from }, text, ...extra } });
}

async function press(from, data, messageId = 100) {
  return tg({
    callback_query: { id: `cb-${updateId}`, from: { id: from }, data, message: { message_id: messageId, chat: { id: from } } },
  });
}

async function calls() {
  return (await fetch(`${MOCK_API}/__calls`)).json();
}
async function resetMock() {
  await fetch(`${MOCK_API}/__reset`, { method: "POST" });
}

/** Ждёт вызов Bot API, удовлетворяющий предикату. */
async function waitCall(method, predicate = () => true, timeoutMs = 4000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const found = (await calls()).find((c) => c.method === method && predicate(c.body));
    if (found) return found;
    await sleep(100);
  }
  return null;
}

/** Текст, который бот показал в чате (sendMessage или editMessageText). */
async function lastScreen(chatId) {
  const all = (await calls()).filter(
    (c) =>
      (c.method === "sendMessage" || c.method === "editMessageText") &&
      String(c.body.chat_id) === String(chatId),
  );
  return all.length ? String(all[all.length - 1].body.text ?? "") : "";
}

async function screenAfter(chatId, fn) {
  await resetMock();
  await fn();
  return lastScreen(chatId);
}

await prepareDemoData();

// Владелец должен существовать до начала проверок: приложение создаёт его из env.
await text(OWNER_ID, null, "/admin");
await pool.query("update staff_users set is_active = true where telegram_id = $1", [OWNER_ID]);

// ---------------------------------------------------------------- доступ
{
  const screen = await screenAfter(OWNER_ID, () => text(OWNER_ID, null, "/admin"));
  check("владелец получает меню панели", screen.includes("панель управления"), screen.slice(0, 120));
  check("в меню есть заказы, товары и отчёт", screen.includes("/orders") && screen.includes("/products") && screen.includes("/report"), screen);

  const idScreen = await screenAfter(OWNER_ID, () => text(OWNER_ID, null, "/id"));
  check("/id возвращает Telegram ID", idScreen.includes(String(OWNER_ID)), idScreen);

  const stranger = 771234;
  const denied = await screenAfter(stranger, () => text(stranger, null, "/admin"));
  check("посторонний не попадает в панель", denied.includes("Нет доступа") && denied.includes(String(stranger)), denied.slice(0, 160));

  const guestStart = await screenAfter(stranger, () => text(stranger, null, "/start"));
  check("/start остаётся покупательским (не админским)", guestStart.includes("ГОРН") && !guestStart.includes("Нет доступа"), guestStart.slice(0, 120));
}

// ---------------------------------------------------------------- заказы
{
  const { rows: orders } = await pool.query("select id, order_number, status from orders order by created_at desc limit 1");
  const order = orders[0];
  check("в БД есть заказ для проверок (создан сидом/смоуком)", Boolean(order), order);

  if (order) {
    const listScreen = await screenAfter(OWNER_ID, () => text(OWNER_ID, null, "/orders"));
    check("/orders показывает список заказов", listScreen.includes("Заказы") && listScreen.includes(`#${order.order_number}`), listScreen.slice(0, 200));

    const card = await screenAfter(OWNER_ID, () => press(OWNER_ID, `o:card:${order.id}`));
    check("карточка заказа показывает покупателя и состав", card.includes("Заказ #") && card.includes("Покупатель"), card.slice(0, 200));

    // Разрешим переход paid → processing (если заказ уже дальше — сначала вернём в paid через БД).
    await pool.query("update orders set status = 'paid' where id = $1", [order.id]);
    await resetMock();
    await press(OWNER_ID, `o:set:${order.id}:processing`);
    await sleep(400);
    const { rows: after } = await pool.query("select status from orders where id = $1", [order.id]);
    check("кнопка «В сборку» меняет статус заказа", after[0]?.status === "processing", after[0]);
    const toast = await waitCall("answerCallbackQuery", (b) => String(b.text ?? "").includes("В сборке"));
    check("нажатие подтверждается всплывающим уведомлением", Boolean(toast), toast?.body);

    // Недопустимый переход: delivered → pending_payment.
    await pool.query("update orders set status = 'delivered' where id = $1", [order.id]);
    await resetMock();
    await press(OWNER_ID, `o:set:${order.id}:pending_payment`);
    const errToast = await waitCall("answerCallbackQuery", (b) => String(b.text ?? "").includes("недопустим"));
    check("недопустимый переход отклоняется с объяснением", Boolean(errToast), errToast?.body);
    const { rows: stillDelivered } = await pool.query("select status from orders where id = $1", [order.id]);
    check("статус не изменился после отказа", stillDelivered[0]?.status === "delivered", stillDelivered[0]);

    // Отмена возвращает остатки.
    const { rows: items } = await pool.query(
      "select product_id, qty from order_items where order_id = $1 and product_id is not null limit 1",
      [order.id],
    );
    if (items[0]) {
      const before = (await pool.query("select stock from products where id = $1", [items[0].product_id])).rows[0].stock;
      await pool.query("update orders set status = 'paid' where id = $1", [order.id]);
      await resetMock();
      await press(OWNER_ID, `o:set:${order.id}:cancelled`);
      await sleep(400);
      const after2 = (await pool.query("select stock from products where id = $1", [items[0].product_id])).rows[0].stock;
      check("отмена заказа возвращает остаток на склад", after2 === before + items[0].qty, { before, after2, qty: items[0].qty });
    }
  }

  const notFound = await screenAfter(OWNER_ID, () => text(OWNER_ID, null, "999999"));
  check("поиск по несуществующему номеру → «не найден»", notFound.includes("не найден"), notFound);
}

// ---------------------------------------------------------------- товары
{
  const listScreen = await screenAfter(OWNER_ID, () => text(OWNER_ID, null, "/products"));
  check("/products показывает товары с ценой и остатком", listScreen.includes("Товары") && listScreen.includes("остаток"), listScreen.slice(0, 160));

  const { rows } = await pool.query("select id, name, price_minor, stock, is_active from products order by created_at limit 1");
  const product = rows[0];

  const prompt = await screenAfter(OWNER_ID, () => press(OWNER_ID, `p:price:${product.id}`));
  check("кнопка «Цена» просит ввести сумму", prompt.includes("Новая цена"), prompt.slice(0, 120));

  await resetMock();
  await text(OWNER_ID, null, "1 990,50");
  const { rows: priced } = await pool.query("select price_minor from products where id = $1", [product.id]);
  check("цена из текста сохраняется (в копейках)", priced[0].price_minor === 199050, priced[0]);

  await press(OWNER_ID, `p:stock:${product.id}`);
  await resetMock();
  await text(OWNER_ID, null, "7");
  const { rows: stocked } = await pool.query("select stock from products where id = $1", [product.id]);
  check("остаток из текста сохраняется", stocked[0].stock === 7, stocked[0]);

  await press(OWNER_ID, `p:price:${product.id}`);
  await resetMock();
  await text(OWNER_ID, null, "не число");
  const badPrice = await waitCall("sendMessage", (b) => String(b.text ?? "").includes("Не понял цену"));
  check("нечисловая цена → понятная ошибка, без падения", Boolean(badPrice), badPrice?.body?.text);
  await text(OWNER_ID, null, "/cancel");

  await resetMock();
  await press(OWNER_ID, `p:toggle:${product.id}`);
  await sleep(300);
  const { rows: toggled } = await pool.query("select is_active from products where id = $1", [product.id]);
  check("кнопка скрытия переключает доступность товара", toggled[0].is_active === !product.is_active, toggled[0]);
  await press(OWNER_ID, `p:toggle:${product.id}`);

  // Создание товара: имя → цена.
  await press(OWNER_ID, "p:new");
  await text(OWNER_ID, null, "Тестовая ваза из бота");
  await resetMock();
  await text(OWNER_ID, null, "2500");
  const created = await waitCall("sendMessage", (b) => String(b.text ?? "").includes("Товар создан"));
  check("создание товара через бота работает", Boolean(created), created?.body?.text?.slice(0, 160));
  const { rows: newProduct } = await pool.query("select price_minor, is_active from products where name = $1", [
    "Тестовая ваза из бота",
  ]);
  check("новый товар сохранён с ценой и активен", newProduct[0]?.price_minor === 250000 && newProduct[0]?.is_active === true, newProduct[0]);

  // Фото: mock getFile отдаёт 1×1 PNG.
  const productId = (await pool.query("select id from products where name = $1", ["Тестовая ваза из бота"])).rows[0].id;
  await press(OWNER_ID, `p:photo:${productId}`);
  await resetMock();
  await tg({
    message: { message_id: 5, chat: { id: OWNER_ID }, from: { id: OWNER_ID }, photo: [{ file_id: "small" }, { file_id: "big" }] },
  });
  const photoScreen = await waitCall("sendMessage", (b) => String(b.text ?? "").includes("Фото обновлено"));
  check("фото товара загружается из Telegram", Boolean(photoScreen), photoScreen?.body?.text?.slice(0, 160));
  const { rows: images } = await pool.query("select url, is_primary from product_images where product_id = $1", [productId]);
  check(
    "изображение записано и помечено главным",
    images.length === 1 && images[0].is_primary === true && String(images[0].url).includes("/uploads/"),
    images,
  );

  // Убираем тестовый товар: иначе он попадёт в каталог и сломает проверки заказов
  // (товар с нулевым остатком выбирается как «первый» в других наборах).
  await pool.query("delete from products where id = $1", [productId]);
  const { rows: gone } = await pool.query("select count(*)::int c from products where id = $1", [productId]);
  check("тестовый товар удалён после проверки", gone[0].c === 0, gone[0]);
}

// --------------------------------------------------------- сотрудники и роли
{
  const staffScreen = await screenAfter(OWNER_ID, () => text(OWNER_ID, null, "/staff"));
  check("/staff показывает список сотрудников", staffScreen.includes("Сотрудники"), staffScreen.slice(0, 160));

  await press(OWNER_ID, "s:add");
  await resetMock();
  await text(OWNER_ID, null, String(MANAGER_ID));
  const namePrompt = await waitCall("sendMessage", (b) => String(b.text ?? "").includes("имя сотрудника"));
  check("добавление сотрудника: запрос ID и имени", Boolean(namePrompt), namePrompt?.body?.text?.slice(0, 120));

  await resetMock();
  await text(OWNER_ID, null, "Менеджер Тест");
  const added = await waitCall("sendMessage", (b) => String(b.text ?? "").includes("Сотрудник добавлен"));
  check("сотрудник добавлен", Boolean(added), added?.body?.text?.slice(0, 160));
  const { rows: staffRow } = await pool.query("select role, is_active from staff_users where telegram_id = $1", [MANAGER_ID]);
  check("новый сотрудник — менеджер и активен", staffRow[0]?.role === "manager" && staffRow[0]?.is_active === true, staffRow[0]);

  // Менеджер: панель доступна, раздел сотрудников — нет.
  const managerMenu = await screenAfter(MANAGER_ID, () => text(MANAGER_ID, null, "/admin"));
  check("менеджер получает меню панели", managerMenu.includes("панель управления") && managerMenu.includes("менеджер"), managerMenu.slice(0, 140));

  await resetMock();
  await press(MANAGER_ID, "s:list");
  const managerDenied = await waitCall("answerCallbackQuery", (b) => String(b.text ?? "").includes("Только владелец"));
  check("менеджеру закрыт раздел сотрудников", Boolean(managerDenied), managerDenied?.body);

  // Менеджер может менять статус заказа.
  const { rows: anyOrder } = await pool.query("select id from orders order by created_at desc limit 1");
  if (anyOrder[0]) {
    await pool.query("update orders set status = 'paid' where id = $1", [anyOrder[0].id]);
    await resetMock();
    await press(MANAGER_ID, `o:set:${anyOrder[0].id}:processing`);
    await sleep(400);
    const { rows: byManager } = await pool.query("select status from orders where id = $1", [anyOrder[0].id]);
    check("менеджер может менять статус заказа", byManager[0]?.status === "processing", byManager[0]);
  }

  // Отключение доступа менеджера.
  const { rows: manager } = await pool.query("select id from staff_users where telegram_id = $1", [MANAGER_ID]);
  await press(OWNER_ID, `s:toggle:${manager[0].id}`);
  await sleep(300);
  const { rows: disabled } = await pool.query("select is_active from staff_users where telegram_id = $1", [MANAGER_ID]);
  check("owner отключает доступ сотруднику", disabled[0]?.is_active === false, disabled[0]);

  const afterDisable = await screenAfter(MANAGER_ID, () => text(MANAGER_ID, null, "/admin"));
  check("отключённый сотрудник теряет доступ", afterDisable.includes("Нет доступа"), afterDisable.slice(0, 120));
}

// ---------------------------------------------------------------- отчёты
{
  const report = await screenAfter(OWNER_ID, () => text(OWNER_ID, null, "/report"));
  check("отчёт показывает выручку за день и неделю", report.includes("Сегодня") && report.includes("7 дней"), report.slice(0, 200));
  check("отчёт содержит топ товаров", report.includes("Топ товаров"), report.slice(0, 240));
}

// -------------------------------------------------- состояние диалога и сброс
{
  await press(OWNER_ID, "p:new");
  const cancelScreen = await screenAfter(OWNER_ID, () => text(OWNER_ID, null, "/cancel"));
  check("/cancel сбрасывает начатый диалог", cancelScreen.includes("Отменено"), cancelScreen);
  const { rows: stateRows } = await pool.query("select count(*)::int c from bot_states where chat_id = $1", [OWNER_ID]);
  check("состояние диалога удалено из БД", stateRows[0].c === 0, stateRows[0]);
}

// ------------------------------------------------------------- уведомления
{
  const { rows: staff } = await pool.query("select count(*)::int c from staff_users where is_active and notifications");
  check("есть сотрудники для уведомлений", staff[0].c > 0, staff[0]);

  await resetMock();
  const { rows: product } = await pool.query("select id from products where is_active and stock > 0 limit 1");
  // Новый заказ через API Mini App → уведомление сотруднику в личку.
  const buyerId = 700900 + Math.floor(Math.random() * 100);
  const initData = signInitData({ id: buyerId, first_name: "Покупатель" });
  const login = await fetch(`${BASE}/api/auth/telegram`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ initData }),
  });
  const auth = await login.json();
  const orderRes = await fetch(`${BASE}/api/orders`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${auth.token}` },
    body: JSON.stringify({
      idempotencyKey: `bot-notify-${Date.now()}`,
      customerName: "Тест Уведомление",
      phone: "+79990000000",
      items: [{ productId: product[0].id, qty: 1 }],
    }),
  });
  check("заказ покупателя создаётся", orderRes.status === 201, orderRes.status);
  const noted = await waitCall("sendMessage", (b) => String(b.text ?? "").includes("Новый заказ"));
  check("сотрудник получает уведомление о новом заказе", Boolean(noted), noted?.body?.text?.slice(0, 160));
}

console.log(`\nИТОГО: PASS=${pass}, FAIL=${fails.length}`);
if (fails.length) {
  for (const f of fails) console.log(" -", f.name, String(JSON.stringify(f.extra)).slice(0, 300));
  process.exitCode = 1;
}
await pool.end();

/* ------------------------------- вспомогательное ------------------------------ */

function signInitData(user) {
  const authDate = Math.floor(Date.now() / 1000);
  const fields = {
    auth_date: String(authDate),
    query_id: `AAH${Math.random().toString(36).slice(2)}`,
    user: JSON.stringify(user),
  };
  const dataCheckString = Object.keys(fields)
    .sort()
    .map((k) => `${k}=${fields[k]}`)
    .join("\n");
  const secret = crypto.createHmac("sha256", "WebAppData").update(process.env.BOT_TOKEN ?? "123456:TEST-TOKEN").digest();
  const hash = crypto.createHmac("sha256", secret).update(dataCheckString).digest("hex");
  return new URLSearchParams({ ...fields, hash }).toString();
}
