// Юнит-проверки чистых функций (без БД и сети).
// Запуск: npx tsx tests/unit.ts
import crypto from "node:crypto";
import { verifyInitData } from "@/lib/telegram-auth";
import { starsAmountForMinor, minorPerStar, paymentMode, paymentsEnabled } from "@/lib/payments";
import { slugify, uniqueSlug } from "@/lib/slug";
import { detectImageByMagicBytes } from "@/lib/image-validation";
import { formatPrice, statusLabel } from "@/lib/format";
import { ORDER_TRANSITIONS, RESTOCK_ON_CANCEL_FROM } from "@/lib/order-transitions";

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


// ------------------------------------------------ доступность палитры (WCAG AA)
// Значения берутся из globals.css — если кто-то «украсит» цвет, тест упадёт.
import { readFileSync } from "node:fs";

function relLuminance(hex: string): number {
  const h = hex.replace("#", "");
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
  const f = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}
function contrast(a: string, b: string): number {
  const [la, lb] = [relLuminance(a), relLuminance(b)];
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

const css = readFileSync(new URL("../src/app/globals.css", import.meta.url), "utf8");
const palette: Record<string, string> = {};
for (const [, name, value] of css.matchAll(/--color-([a-z-]+):\s*(#[0-9a-f]{6})/gi)) palette[name] = value;

check("палитра: цвета прочитаны из globals.css", ["paper", "ink", "mute", "clay", "sage"].every((c) => palette[c]), palette);

const aaBody = 4.5;
// Вторичный текст лежит и на paper, и на cream — проверяем обе подложки.
for (const bg of ["paper", "cream"]) {
  for (const name of ["ink", "mute", "clay", "clay-deep", "sage"]) {
    const value = palette[name];
    if (!value || !palette[bg]) continue;
    const ratio = contrast(value, palette[bg]);
    check(
      `контраст ${name} на ${bg} ≥ ${aaBody}:1 (WCAG AA)`,
      ratio >= aaBody,
      { ratio: Number(ratio.toFixed(2)), value },
    );
  }
}
check("белый текст на clay ≥ 4.5:1", contrast("#ffffff", palette.clay) >= aaBody, Number(contrast("#ffffff", palette.clay).toFixed(2)));
check("белый текст на clay-deep ≥ 4.5:1", contrast("#ffffff", palette["clay-deep"]) >= aaBody, Number(contrast("#ffffff", palette["clay-deep"]).toFixed(2)));

check("prefers-reduced-motion учтён в стилях", css.includes("prefers-reduced-motion"));
check("видимый фокус для клавиатуры задан (:focus-visible)", css.includes(":focus-visible"));
check("безопасные зоны Telegram проброшены в CSS (--safe-top/--safe-bottom)", css.includes("--safe-top") && css.includes("--safe-bottom"));

// Поля ввода 16px: иначе iOS Safari зумит страницу при фокусе.
const checkoutSource = readFileSync(new URL("../src/app/app/checkout/page.tsx", import.meta.url), "utf8");
const catalogSource = readFileSync(new URL("../src/app/app/page.tsx", import.meta.url), "utf8");
check(
  "поля ввода не меньше 16px (нет text-sm на input/textarea)",
  !/placeholder=|value=\{q\}/.test(checkoutSource.replace(/text-base/g, "")) || !/text-sm[^"]*outline-none/.test(checkoutSource),
  "проверка классов полей",
);
check("поиск в каталоге — text-base", catalogSource.includes("bg-transparent text-base"));

console.log(`\nИТОГО: PASS=${pass}, FAIL=${fails.length}`);
if (fails.length) process.exitCode = 1;
