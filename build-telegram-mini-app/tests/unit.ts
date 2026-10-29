// Юнит-проверки чистых функций (без БД и сети).
// Запуск: npx tsx tests/unit.ts
import crypto from "node:crypto";
import { verifyInitData } from "@/lib/telegram-auth";
import { starsAmountForMinor, minorPerStar, paymentMode, paymentsEnabled } from "@/lib/payments";
import { slugify, uniqueSlug } from "@/lib/slug";
import { detectImageByMagicBytes } from "@/lib/image-validation";
import { formatPrice, statusLabel } from "@/lib/format";
import { ORDER_TRANSITIONS, RESTOCK_ON_CANCEL_FROM } from "@/lib/order-transitions";
import { resolveAdminCookiePolicy } from "@/lib/admin-cookie-policy";
import { checkAdminLoginConfig, describeLoginFailure, isNextRedirect } from "@/lib/admin-login-errors";

let pass = 0;
const fails: string[] = [];
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) {
    pass++;
    console.log(`PASS  ${name}`);
  } else {
    fails.push(name);
    console.log(`FAIL  ${name}${extra !== undefined ? `  << ${JSON.stringify(extra)}` : ""}`);
  }
}

// ---------------------------------------------------------------- initData
const TOKEN = "123456:UNIT-TOKEN";
function makeInitData(user: Record<string, unknown>, authDate = Math.floor(Date.now() / 1000), token = TOKEN) {
  const params = new URLSearchParams({ auth_date: String(authDate), user: JSON.stringify(user) });
  const dcs = [...params.entries()].map(([k, v]) => `${k}=${v}`).sort().join("\n");
  const secret = crypto.createHmac("sha256", "WebAppData").update(token).digest();
  params.set("hash", crypto.createHmac("sha256", secret).update(dcs).digest("hex"));
  return params.toString();
}

const good = makeInitData({ id: 42, first_name: "Тест" });
check("verifyInitData: валидная подпись", verifyInitData(good, TOKEN)?.id === 42);
check("verifyInitData: чужой bot token", verifyInitData(good, "1:OTHER") === null);
check("verifyInitData: просроченный auth_date (25 ч)", verifyInitData(makeInitData({ id: 42 }, Math.floor(Date.now() / 1000) - 90000), TOKEN) === null);
check("verifyInitData: auth_date из будущего (+1 ч)", verifyInitData(makeInitData({ id: 42 }, Math.floor(Date.now() / 1000) + 3600), TOKEN) === null);
check("verifyInitData: пустая строка", verifyInitData("", TOKEN) === null);
check("verifyInitData: без user", (() => {
  const params = new URLSearchParams({ auth_date: String(Math.floor(Date.now() / 1000)) });
  const dcs = [...params.entries()].map(([k, v]) => `${k}=${v}`).sort().join("\n");
  const secret = crypto.createHmac("sha256", "WebAppData").update(TOKEN).digest();
  params.set("hash", crypto.createHmac("sha256", secret).update(dcs).digest("hex"));
  return verifyInitData(params.toString(), TOKEN) === null;
})());
check("verifyInitData: битый JSON в user → null, не исключение", (() => {
  const params = new URLSearchParams({ auth_date: String(Math.floor(Date.now() / 1000)), user: "{oops" });
  const dcs = [...params.entries()].map(([k, v]) => `${k}=${v}`).sort().join("\n");
  const secret = crypto.createHmac("sha256", "WebAppData").update(TOKEN).digest();
  params.set("hash", crypto.createHmac("sha256", secret).update(dcs).digest("hex"));
  return verifyInitData(params.toString(), TOKEN) === null;
})());

// ------------------------------------------------------------------ деньги
const savedPrice = process.env.XTR_PRICE_MINOR;
delete process.env.XTR_PRICE_MINOR;
check("Stars: 1890 ₽ → 1454 звезды при курсе 130 коп.", starsAmountForMinor(189000) === 1454, starsAmountForMinor(189000));
check("Stars: минимальная цена 1 звезда", starsAmountForMinor(0) === 1);
process.env.XTR_PRICE_MINOR = "1";
check("Stars: курс 1 коп. → 1 ₽ = 100 звёзд", starsAmountForMinor(100) === 100, starsAmountForMinor(100));
process.env.XTR_PRICE_MINOR = "abc";
check("Stars: некорректный XTR_PRICE_MINOR откатывается на 130 коп.", minorPerStar() === 130, minorPerStar());
check("Stars: некорректный курс не даёт NaN в сумме", Number.isFinite(starsAmountForMinor(1000)), starsAmountForMinor(1000));
process.env.XTR_PRICE_MINOR = "-5";
check("Stars: отрицательный курс → дефолт", minorPerStar() === 130, minorPerStar());
process.env.XTR_PRICE_MINOR = "0";
check("Stars: XTR_PRICE_MINOR=0 не приводит к делению на ноль", Number.isFinite(starsAmountForMinor(1000)), starsAmountForMinor(1000));
if (savedPrice === undefined) delete process.env.XTR_PRICE_MINOR;
else process.env.XTR_PRICE_MINOR = savedPrice;

process.env.PAYMENT_MODE = "fiat";
check("paymentMode: fiat", paymentMode() === "fiat");
process.env.PAYMENT_MODE = "stars";
check("paymentMode: по умолчанию stars", paymentMode() === "stars");
process.env.PAYMENT_MODE = "garbage";
check("paymentMode: неизвестное значение → stars", paymentMode() === "stars");
const savedBot = process.env.BOT_TOKEN;
process.env.BOT_TOKEN = "";
process.env.PAYMENT_MODE = "stars";
check("paymentsEnabled: без BOT_TOKEN выключены", paymentsEnabled() === false);
process.env.BOT_TOKEN = "1:x";
process.env.PAYMENT_MODE = "fiat";
check("paymentsEnabled: fiat без provider_token выключены", paymentsEnabled() === false);
process.env.PAYMENT_MODE = "stars";
check("paymentsEnabled: stars с BOT_TOKEN включены", paymentsEnabled() === true);
if (savedBot === undefined) delete process.env.BOT_TOKEN;
else process.env.BOT_TOKEN = savedBot;

// -------------------------------------------------------------------- slug
check("slugify: кириллица", slugify("Кружка «Дюна», 320 мл") === "kruzhka-dyuna-320-ml", slugify("Кружка «Дюна», 320 мл"));
check("slugify: пустая строка → item", slugify("***") === "item");
check("slugify: длина ≤ 180", slugify("я".repeat(400)).length <= 180);
check("uniqueSlug: суффикс делает слаги разными", uniqueSlug("ваза") !== uniqueSlug("ваза"));

// ------------------------------------------------------------- изображения
check("magic bytes: JPEG", detectImageByMagicBytes(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))?.ext === "jpg");
check("magic bytes: PNG", detectImageByMagicBytes(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))?.ext === "png");
check("magic bytes: GIF89a", detectImageByMagicBytes(Buffer.from("GIF89a"))?.ext === "gif");
check("magic bytes: WebP", detectImageByMagicBytes(Buffer.from("RIFF0000WEBP"))?.ext === "webp");
check("magic bytes: HTML → null", detectImageByMagicBytes(Buffer.from("<svg></svg>")) === null);
check("magic bytes: SVG (XML) не принимается", detectImageByMagicBytes(Buffer.from("<?xml version=\"1.0\"?><svg/>")) === null);

// -------------------------------------------------------------- форматирование
check("formatPrice: 189000 → «1 890 ₽»", formatPrice(189000).replace(/\u00a0/g, " ") === "1 890 ₽", formatPrice(189000));
check("statusLabel: известный статус", statusLabel("pending_payment") === "Ожидает оплаты");
check("statusLabel: неизвестный статус → как есть", statusLabel("weird") === "weird");

// ------------------------------------------------------------------ граф статусов
const allStatuses = Object.keys(ORDER_TRANSITIONS);
check("граф переходов: все статусы покрыты", allStatuses.length === 6, allStatuses);
check("граф переходов: из terminal-статусов нет выходов", ORDER_TRANSITIONS.delivered.length === 0 && ORDER_TRANSITIONS.cancelled.length === 0);
check("граф переходов: нет перехода в самого себя", allStatuses.every((s) => !ORDER_TRANSITIONS[s as keyof typeof ORDER_TRANSITIONS].includes(s as never)));
check("возврат остатков: отмена из pending_payment входит в список", RESTOCK_ON_CANCEL_FROM.includes("pending_payment"));

// ------------------------------------------------- cookie сессии админки (P0: «снова просит пароль»)
// Раньше: secure всегда при NODE_ENV=production (ломается на http) и жёсткий lax
// (не работает во встроенном окне на другом домене).
const httpNext = resolveAdminCookiePolicy({ forwardedProto: "http", nodeEnv: "production" });
check("cookie админки: http + production → без Secure (иначе браузер выбросит)", httpNext.secure === false && httpNext.sameSite === "lax", httpNext);

const httpsNext = resolveAdminCookiePolicy({ forwardedProto: "https", nodeEnv: "production" });
check("cookie админки: https → Secure", httpsNext.secure === true, httpsNext);

check("cookie админки: заголовок прокси важнее NODE_ENV", resolveAdminCookiePolicy({ forwardedProto: "https", nodeEnv: "development" }).secure === true);

const listProto = resolveAdminCookiePolicy({ forwardedProto: "https, http", nodeEnv: "production" });
check("cookie админки: список протоколов из x-forwarded-proto", listProto.secure === true, listProto);

const embedded = resolveAdminCookiePolicy({ forwardedProto: "https", override: "none" });
check("cookie админки: ADMIN_COOKIE_SAMESITE=none → SameSite=none + Secure", embedded.sameSite === "none" && embedded.secure === true, embedded);

const embeddedHttp = resolveAdminCookiePolicy({ forwardedProto: "http", override: "none" });
check("cookie админки: none на http откатывается на lax (иначе cookie теряется)", embeddedHttp.sameSite === "lax" && embeddedHttp.secure === false, embeddedHttp);

check("cookie админки: strict из env", resolveAdminCookiePolicy({ forwardedProto: "https", override: "strict" }).sameSite === "strict");
check("cookie админки: мусор в env → lax", resolveAdminCookiePolicy({ forwardedProto: "https", override: "weird" }).sameSite === "lax");


// ---------------------------------------- вход в админку: понятные ошибки (не 500)
const cfgNoDb = checkAdminLoginConfig({ ADMIN_SESSION_SECRET: "x".repeat(32) }, "production");
check("логин: нет DATABASE_URL → issue database_url_missing", cfgNoDb.some((i) => i.code === "database_url_missing"), cfgNoDb);

const cfgShortSecret = checkAdminLoginConfig({ DATABASE_URL: "postgres://x", ADMIN_SESSION_SECRET: "short" }, "production");
check("логин: короткий ADMIN_SESSION_SECRET → issue с длиной", cfgShortSecret.some((i) => i.code === "admin_session_secret_too_short"), cfgShortSecret);

check("логин: секрет ровно 32 символа → конфигурация в порядке",
  checkAdminLoginConfig({ DATABASE_URL: "postgres://x", ADMIN_SESSION_SECRET: "y".repeat(32) }, "production").length === 0);

const cfgDev = checkAdminLoginConfig({ DATABASE_URL: "postgres://x" }, "development");
check("логин: dev без секрета → предупреждение, но не блокирует", cfgDev.some((i) => i.code === "admin_session_secret_missing"));

const wrapped = new Error("Failed query: select 1");
(wrapped as { cause?: unknown }).cause = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:5432"), { code: "ECONNREFUSED" });
check("ошибка входа: ECONNREFUSED внутри cause → db_unreachable", describeLoginFailure(wrapped).code === "db_unreachable", describeLoginFailure(wrapped));

const noTable = Object.assign(new Error('relation "staff_users" does not exist'), { code: "42P01" });
check("ошибка входа: 42P01 → db_schema_missing", describeLoginFailure(noTable).code === "db_schema_missing", describeLoginFailure(noTable));

const badAuth = Object.assign(new Error("password authentication failed for user \"postgres\""), { code: "28P01" });
check("ошибка входа: 28P01 → db_auth_failed", describeLoginFailure(badAuth).code === "db_auth_failed", describeLoginFailure(badAuth));

check("ошибка входа: неизвестная ошибка → unknown с подсказкой", describeLoginFailure(new Error("boom")).code === "unknown");
check("ошибка входа: у каждого ответа есть текст и подсказка",
  [describeLoginFailure(wrapped), describeLoginFailure(noTable), describeLoginFailure(new Error("x"))].every((f) => f.message.length > 10 && f.hint.length > 10));

check("redirect не глотается: NEXT_REDIRECT распознаётся", isNextRedirect({ digest: "NEXT_REDIRECT;replace;/admin;303;" }) === true);
check("redirect не глотается: обычная ошибка — false", isNextRedirect(new Error("boom")) === false);
check("redirect не глотается: null безопасен", isNextRedirect(null) === false);

console.log(`\nИТОГО: PASS=${pass}, FAIL=${fails.length}`);
if (fails.length) process.exitCode = 1;
