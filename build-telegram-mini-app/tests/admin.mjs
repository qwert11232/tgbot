// Проверки админки: сессии, страницы, загрузка файлов, server actions, RBAC.
// Запуск: node /home/user/tests/admin.mjs
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { prepareDemoData } from "./db.mjs";

const require = createRequire("/home/user/tgbot/build-telegram-mini-app/package.json");
const { SignJWT } = require("jose");
const { Pool } = require("pg");
const flight = require("next/dist/compiled/react-server-dom-webpack/client.node.js");

const BASE = process.env.BASE ?? "http://127.0.0.1:3000";
const ADMIN_SECRET = process.env.ADMIN_SESSION_SECRET ?? "0123456789abcdef0123456789abcdef";
const DATABASE_URL = process.env.DATABASE_URL ?? "postgresql://postgres@127.0.0.1:55432/app_db";

// id server actions зависят от сборки — читаем из манифеста Next
import { readFileSync } from "node:fs";
const manifestPath = process.env.ACTION_MANIFEST ?? "/home/user/tgbot/build-telegram-mini-app/.next/server/server-reference-manifest.json";
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const ACTIONS = {};
for (const [id, info] of Object.entries(manifest.node ?? {})) {
  if (info.exportedName) ACTIONS[info.exportedName] ??= id;
}

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

const pool = new Pool({ connectionString: DATABASE_URL });
await prepareDemoData().catch(() => {});

async function signAdminJwt(payload) {
  return new SignJWT({ ...payload })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("12h")
    .sign(new TextEncoder().encode(ADMIN_SECRET));
}

async function makeSession(userId, { revoked = false, sv = 1, expiresInMs = 3600_000 } = {}) {
  const { rows } = await pool.query(
    "insert into staff_sessions (user_id, expires_at, revoked_at) values ($1, $2, $3) returning id",
    [userId, new Date(Date.now() + expiresInMs), revoked ? new Date() : null],
  );
  const sid = rows[0].id;
  const token = await signAdminJwt({ sid, sub: userId, sv });
  return { sid, token, cookie: `admin_session=${token}` };
}

async function getStaff(email) {
  const { rows } = await pool.query("select * from staff_users where email = $1", [email]);
  return rows[0];
}

async function get(path, cookie, init = {}) {
  const res = await fetch(BASE + path, {
    redirect: "manual",
    ...init,
    headers: { ...(cookie ? { cookie } : {}), ...(init.headers ?? {}) },
  });
  const text = await res.text();
  return { status: res.status, body: text, headers: res.headers };
}

async function callAction(name, args, cookie, path = "/admin/staff") {
  const res = await fetch(BASE + path, {
    method: "POST",
    redirect: "manual",
    headers: {
      "next-action": ACTIONS[name],
      "content-type": "text/plain;charset=UTF-8",
      origin: BASE,
      ...(cookie ? { cookie } : {}),
    },
    body: JSON.stringify(args),
  });
  const text = await res.text();
  return { status: res.status, body: text, headers: res.headers };
}

// ------------------------------------------------------------------ подготовка
const owner = await getStaff("admin@gorn.local");
check("в БД есть owner из сида", Boolean(owner), owner?.email);

const managerEmail = `manager-${Date.now()}@gorn.local`;
const { rows: managerRows } = await pool.query(
  "insert into staff_users (email, name, password_hash, role) values ($1, $2, $3, 'manager') returning *",
  [managerEmail, "Менеджер Тест", "$2b$12$abcdefghijklmnopqrstuv"],
);
const manager = managerRows[0];

const ownerS = await makeSession(owner.id, { sv: owner.session_version });
const managerS = await makeSession(manager.id, { sv: manager.session_version });

// -------------------------------------------------------------------- proxy
const anon = await get("/admin/orders");
check("proxy: /admin/orders без cookie → 307 /admin/login", anon.status === 307 && (anon.headers.get("location") ?? "").includes("/admin/login"), [anon.status, anon.headers.get("location")]);
const anonNext = await get("/admin/products?page=2");
check("proxy: сохраняет next в редиректе", decodeURIComponent(anonNext.headers.get("location") ?? "").includes("next=/admin/products"), anonNext.headers.get("location"));
const loginPage = await get("/admin/login");
check("страница логина открывается без авторизации", loginPage.status === 200 && loginPage.body.includes("панель управления"), loginPage.status);
const tooLong = await makeSession(owner.id, { expiresInMs: 1000 });

// ------------------------------------------------------------------ страницы
for (const [path, marker] of [
  ["/admin", "Последние заказы"],
  ["/admin/products", "Новый товар"],
  ["/admin/products/new", "Новый товар"],
  ["/admin/orders", "Показано до 150"],
  ["/admin/staff", "Сотрудники"],
]) {
  const r = await get(path, ownerS.cookie);
  check(`owner GET ${path} → 200 + контент`, r.status === 200 && r.body.includes(marker), [r.status, r.body.slice(0, 120)]);
}

const managerStaffPage = await get("/admin/staff", managerS.cookie);
check("manager видит на /admin/staff отказ «Доступ ограничен»", managerStaffPage.status === 200 && managerStaffPage.body.includes("Доступ ограничен"), managerStaffPage.status);
const managerProductsPage = await get("/admin/products", managerS.cookie);
check("manager имеет доступ к товарам", managerProductsPage.status === 200, managerProductsPage.status);

// Сессия с отозванным токеном / просроченная / неверный sessionVersion
const revoked = await makeSession(owner.id, { revoked: true, sv: owner.session_version });
const revokedPage = await get("/admin", revoked.cookie);
check("отозванная сессия → редирект на логин", revokedPage.status === 307, [revokedPage.status, revokedPage.headers.get("location")]);
const staleSv = await makeSession(owner.id, { sv: owner.session_version + 5 });
const stalePage = await get("/admin", staleSv.cookie);
check("устаревший sessionVersion → редирект на логин", stalePage.status === 307, [stalePage.status, stalePage.headers.get("location")]);
const expired = await makeSession(owner.id, { expiresInMs: -1000, sv: owner.session_version });
const expiredPage = await get("/admin", expired.cookie);
check("просроченная сессия → редирект", expiredPage.status === 307, [expiredPage.status, expiredPage.headers.get("location")]);
const forged = await signAdminJwt({ sid: crypto.randomUUID(), sub: owner.id, sv: owner.session_version });
const forgedPage = await get("/admin", `admin_session=${forged}`);
check("JWT без записи в staff_sessions → редирект", forgedPage.status === 307, forgedPage.status);

// --------------------------------------------------------------- загрузка
// 1x1 PNG
const pngB64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const png = Buffer.from(pngB64, "base64");
async function upload(cookie, buf, filename, type) {
  const fd = new FormData();
  fd.set("file", new File([buf], filename, { type }));
  const res = await fetch(BASE + "/api/admin/upload", { method: "POST", headers: cookie ? { cookie } : {}, body: fd });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text.slice(0, 200);
  }
  return { status: res.status, body };
}

const upOk = await upload(ownerS.cookie, png, "pixel.png", "image/png");
check("загрузка настоящего PNG → 201 + url", upOk.status === 201 && /^\/uploads\/|^https:/.test(upOk.body?.url ?? ""), upOk);
if (upOk.body?.url) {
  const img = await fetch(BASE + upOk.body.url, { headers: { cookie: ownerS.cookie } });
  check("загруженный файл доступен по /uploads/[...path]", img.status === 200 && img.headers.get("content-type")?.includes("image/png"), [img.status, img.headers.get("content-type")]);
check("загруженный файл отдаётся с nosniff и immutable-кэшем", img.headers.get("x-content-type-options") === "nosniff" && /immutable/.test(img.headers.get("cache-control") ?? ""), img.headers.get("cache-control"));
}
const upFake = await upload(ownerS.cookie, Buffer.from("<html><script>alert(1)</script></html>"), "evil.png", "image/png");
check("файл без сигнатуры изображения → 415", upFake.status === 415, upFake);
const upText = await upload(ownerS.cookie, Buffer.from("hello"), "note.txt", "text/plain");
check("txt → 415", upText.status === 415, upText);
const big = Buffer.concat([png, Buffer.alloc(6 * 1024 * 1024)]);
const upBig = await upload(ownerS.cookie, big, "big.png", "image/png");
check("файл > 5 МБ → 413", upBig.status === 413, upBig);
const upNoFile = await fetch(BASE + "/api/admin/upload", { method: "POST", headers: { cookie: ownerS.cookie }, body: new FormData() });
check("загрузка без file → 400", upNoFile.status === 400, upNoFile.status);
const upAnon = await upload(null, png, "p.png", "image/png");
check("загрузка без сессии → 401", upAnon.status === 401, upAnon.status);
const upManager = await upload(managerS.cookie, png, "p.png", "image/png");
check("manager может загружать изображения", upManager.status === 201, upManager.status);

// --------------------------------------------------------- server actions
const anonCreate = await callAction("createProductAction", [{ name: "Хак", description: "", categoryId: null, priceRub: "10", stock: 1, isActive: true }], null, "/admin/products/new");
check("createProductAction без сессии не создаёт товар (нет 'ok':true)", !anonCreate.body.includes('"ok":true'), anonCreate.body.slice(0, 300));

const created = await callAction(
  "createProductAction",
  [{ name: `Тестовый товар ${Date.now()}`, description: "описание", categoryId: null, priceRub: "1 234,50", stock: 7, isActive: true }],
  ownerS.cookie,
  "/admin/products/new",
);
const createdOk = created.body.includes('"ok":true');
check("owner createProductAction → ok:true", createdOk, created.body.slice(0, 400));
const prodMatch = /"id":"([0-9a-f-]{36})"/.exec(created.body);
const newProductId = prodMatch?.[1];
check("createProductAction вернул id товара", Boolean(newProductId), created.body.slice(0, 400));

if (newProductId) {
  const { rows } = await pool.query("select * from products where id = $1", [newProductId]);
  check("товар создан с ценой 123450 копеек", rows[0]?.price_minor === 123450, rows[0]?.price_minor);
  check("slug сгенерирован уникальный", typeof rows[0]?.slug === "string" && rows[0].slug.length > 0, rows[0]?.slug);

  const upd = await callAction(
    "updateProductAction",
    [newProductId, { name: "Обновлённый товар", description: "", categoryId: null, priceRub: "abc", stock: 3, isActive: false }],
    managerS.cookie,
    `/admin/products/${newProductId}`,
  );
  check("updateProductAction с ценой 'abc' → ok:false «Некорректная цена»", upd.body.includes('"ok":false') && upd.body.includes("Некорректная цена"), upd.body.slice(0, 300));

  const updOk = await callAction(
    "updateProductAction",
    [newProductId, { name: "Обновлённый товар", description: "", categoryId: null, priceRub: "999", stock: 3, isActive: false }],
    managerS.cookie,
    `/admin/products/${newProductId}`,
  );
  check("manager updateProductAction → ok:true", updOk.body.includes('"ok":true'), updOk.body.slice(0, 300));

  const attach = await callAction("attachProductImageAction", [newProductId, "/uploads/products/x.png"], managerS.cookie, `/admin/products/${newProductId}`);
  check("attachProductImageAction → ok:true", attach.body.includes('"ok":true'), attach.body.slice(0, 300));
  const attachBad = await callAction("attachProductImageAction", [newProductId, "javascript:alert(1)"], managerS.cookie, `/admin/products/${newProductId}`);
  check("attachProductImageAction c javascript: URL → ok:false", attachBad.body.includes('"ok":false'), attachBad.body.slice(0, 300));

  const del = await callAction("deleteProductAction", [newProductId], ownerS.cookie, "/admin/products");
  check("deleteProductAction → ok:true", del.body.includes('"ok":true'), del.body.slice(0, 300));
}

// стафф-экшены: manager не может, owner может
const mgrCreateStaff = await callAction(
  "createStaffAction",
  [{ email: `hack-${Date.now()}@gorn.local`, name: "Хак", password: "1234567890", role: "owner" }],
  managerS.cookie,
);
check("manager createStaffAction → отказ по роли", mgrCreateStaff.body.includes('"ok":false') && mgrCreateStaff.body.includes("владельца"), mgrCreateStaff.body.slice(0, 300));

const anonStaff = await callAction("createStaffAction", [{ email: "x@gorn.local", name: "Xx", password: "1234567890", role: "owner" }], null);
check("аноним createStaffAction отсекается proxy (307 → логин)", anonStaff.status === 307, anonStaff.status);

const newStaffEmail = `staff-${Date.now()}@gorn.local`;
const createStaff = await callAction("createStaffAction", [{ email: newStaffEmail, name: "Новый сотрудник", password: "password-123", role: "manager" }], ownerS.cookie);
check("owner createStaffAction → ok:true", createStaff.body.includes('"ok":true'), createStaff.body.slice(0, 300));
const { rows: newStaffRows } = await pool.query("select * from staff_users where email = $1", [newStaffEmail]);
const newStaff = newStaffRows[0];
check("пароль сотрудника захеширован bcrypt", /^\$2[aby]\$/.test(newStaff?.password_hash ?? ""), newStaff?.password_hash?.slice(0, 7));

const dupStaff = await callAction("createStaffAction", [{ email: newStaffEmail, name: "Дубль", password: "password-123", role: "manager" }], ownerS.cookie);
check("дубликат email → безопасное сообщение без SQL/хеша", dupStaff.body.includes('"ok":false') && /уже существует/.test(dupStaff.body) && !/Failed query|params:|\$2[aby]\$/.test(dupStaff.body), dupStaff.body.slice(0, 300));

const selfDemote = await callAction("changeStaffRoleAction", [owner.id, "manager"], ownerS.cookie);
check("нельзя изменить роль самому себе", selfDemote.body.includes('"ok":false') && selfDemote.body.includes("самому себе"), selfDemote.body.slice(0, 300));

const selfDelete = await callAction("deleteStaffAction", [owner.id], ownerS.cookie);
check("нельзя удалить себя", selfDelete.body.includes('"ok":false'), selfDelete.body.slice(0, 300));

const selfDeactivate = await callAction("setStaffActiveAction", [owner.id, false], ownerS.cookie);
check("нельзя деактивировать себя", selfDeactivate.body.includes('"ok":false'), selfDeactivate.body.slice(0, 300));

const demoteNew = await callAction("changeStaffRoleAction", [newStaff.id, "owner"], ownerS.cookie);
check("повышение менеджера до owner работает", demoteNew.body.includes('"ok":true'), demoteNew.body.slice(0, 300));
const { rows: afterPromote } = await pool.query("select role, session_version from staff_users where id = $1", [newStaff.id]);
check("был инкремент session_version", afterPromote[0].session_version === newStaff.session_version + 1, [newStaff.session_version, afterPromote[0].session_version]);

const resetGhost = await callAction("resetStaffPasswordAction", [crypto.randomUUID(), "password-123"], ownerS.cookie);
check("сброс пароля несуществующего сотрудника → ok:false «не найден»", resetGhost.body.includes('"ok":false') && resetGhost.body.includes("не найден"), resetGhost.body.slice(0, 300));

const delStaff = await callAction("deleteStaffAction", [newStaff.id], ownerS.cookie);
check("owner удаляет сотрудника → ok:true", delStaff.body.includes('"ok":true'), delStaff.body.slice(0, 300));
const { rows: afterDelete } = await pool.query("select count(*)::int c from staff_sessions where user_id = $1", [newStaff.id]);
check("сессии удалённого сотрудника удалены каскадом", afterDelete[0].c === 0, afterDelete[0].c);

// логин через action (form-data)
async function loginAction(email, password, ip = "203.0.113.9") {
  const fd = new FormData();
  fd.set("email", email);
  fd.set("password", password);
  // Тот же wire-формат, что использует браузер (encodeReply): 0=[state,"$K1"], _1_email/_1_password
  const body = await flight.encodeReply([{}, fd]);
  const res = await fetch(BASE + "/admin/login", {
    method: "POST",
    headers: { "next-action": ACTIONS.loginAction, origin: BASE, "x-forwarded-for": ip },
    body,
  });
  const text = await res.text();
  return { status: res.status, body: text, headers: res.headers };
}
const loginBad = await loginAction("admin@gorn.local", "wrong-password", "198.51.100.1");
check("логин с неверным паролем → «Неверный email или пароль»", loginBad.body.includes("Неверный email") || loginBad.body.includes("Неверный"), loginBad.body.slice(0, 300));
const loginOk = await loginAction("admin@gorn.local", "gorn-admin-2026", "198.51.100.2");
const setCookie = loginOk.headers.get("set-cookie") ?? "";
check("логин owner (сид-пароль) → 303 + cookie admin_session", (loginOk.status === 303 || loginOk.status === 200) && setCookie.includes("admin_session="), [loginOk.status, setCookie.slice(0, 80)]);
const sessionCookie = setCookie.split(";")[0];
const dash = await get("/admin", sessionCookie);
check("логин → сессия даёт доступ к /admin", dash.status === 200 && dash.body.includes("Последние заказы"), dash.status);

// Перебор пароля ограничен (8 / 10 минут на IP)
let limited = false;
for (let i = 0; i < 9; i++) {
  const r = await loginAction("admin@gorn.local", "bad", "192.0.2.77");
  if (r.body.includes("Слишком много попыток")) limited = true;
}
check("rate limit логина срабатывает после 8 попыток", limited);

// ------------------------------------------------------------------ итоги
console.log(`\nИТОГО: PASS=${pass}, FAIL=${fails.length}`);
if (fails.length) {
  console.log("Провалы:");
  for (const f of fails) console.log(" -", f.name, String(JSON.stringify(f.extra)).slice(0, 300));
  process.exitCode = 1;
}
await pool.end();
