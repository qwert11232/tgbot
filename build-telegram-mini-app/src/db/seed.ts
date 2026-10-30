import "dotenv/config";
import { eq } from "drizzle-orm";
import { db } from "./index";
import { categories, productImages, products, staffUsers } from "./schema";


/**
 * Сид: первый owner (ADMIN_TELEGRAM_ID), демо-категории и товары.
 * Вход в админку — через Telegram-бота, поэтому владелец задаётся Telegram ID
 * (узнать свой можно командой /id в боте).
 * Демо-изображения лежат в public/seed (сгенерированные картинки-заглушки).
 * Идемпотентен: повторный запуск не дублирует записи.
 * Запуск: npx tsx src/db/seed.ts
 */

const DEMO_CATEGORIES = [
  { name: "Кружки и чашки", slug: "cups", sortOrder: 1 },
  { name: "Вазы", slug: "vases", sortOrder: 2 },
  { name: "Свечи и подсвечники", slug: "candles", sortOrder: 3 },
  { name: "Посуда", slug: "tableware", sortOrder: 4 },
];

const DEMO_PRODUCTS = [
  {
    name: "Кружка «Дюна», 320 мл",
    slug: "kruzhka-duna-320",
    category: "cups",
    description:
      "Кружка ручной работы из светлого шамота с крапчатой кремовой глазурью. Каждая немного отличается по рисунку крапа — это нормально для ручного обжига. Можно в посудомоечную машину и СВЧ.",
    priceMinor: 189000,
    stock: 12,
    images: ["/seed/mug-dune.png"],
  },
  {
    name: "Чашка эспрессо «Уголь», 90 мл",
    slug: "chashka-espresso-ugol",
    category: "cups",
    description: "Компактная чашка для эспрессо из тёмной каменной массы. Матовая поверхность, удобная ручка под два пальца.",
    priceMinor: 129000,
    stock: 20,
    images: ["/seed/espresso.png"],
  },
  {
    name: "Ваза «Терра», высота 24 см",
    slug: "vaza-terra-24",
    category: "vases",
    description: "Высокая ваза из терракотовой глины без глазури. Живая фактура гончарного круга. Для сухоцветов и ветвей; для воды — с внутренним колбовидным вкладышем.",
    priceMinor: 349000,
    stock: 6,
    images: ["/seed/vase-terra.png"],
  },
  {
    name: "Подсвечники «Пара», набор из двух",
    slug: "podsvechniki-para",
    category: "candles",
    description: "Пара низких подсвечников под тонкие свечи. Молочная глазурь, устойчивое основание. Свечи в комплект не входят.",
    priceMinor: 219000,
    stock: 9,
    images: ["/seed/candles.png"],
  },
  {
    name: "Тарелка обеденная «Камень», 26 см",
    slug: "tarelka-kamen-26",
    category: "tableware",
    description: "Обеденная тарелка из каменной керамики с широким матовым бортом. Стекуется, подходит для ежедневного использования.",
    priceMinor: 249000,
    stock: 15,
    images: ["/seed/plate.png"],
  },
  {
    name: "Пиала «Лазурь», 400 мл",
    slug: "piala-lazur",
    category: "tableware",
    description: "Глубокая пиала с плывущей синей глазурью — узор не повторяется. Для супов, боулов и утренней гранолы.",
    priceMinor: 169000,
    stock: 0,
    images: ["/seed/bowl.png"],
  },
];

async function main() {
  console.log("→ Сид: владелец");
  const rawId = (process.env.ADMIN_TELEGRAM_ID ?? "").trim();
  if (!rawId) {
    console.log("  пропущено: задайте ADMIN_TELEGRAM_ID (ваш Telegram ID, узнать: /id в боте)");
  } else {
    const telegramId = Number(rawId);
    if (!Number.isSafeInteger(telegramId) || telegramId <= 0) {
      console.log(`  ошибка: ADMIN_TELEGRAM_ID должен быть числом, получено «${rawId}»`);
    } else {
      const [existingAdmin] = await db
        .select()
        .from(staffUsers)
        .where(eq(staffUsers.telegramId, telegramId))
        .limit(1);
      if (!existingAdmin) {
        await db.insert(staffUsers).values({ telegramId, name: "Владелец", role: "owner" });
        console.log(`  создан owner: ${telegramId}`);
      } else if (existingAdmin.role !== "owner" || !existingAdmin.isActive) {
        await db
          .update(staffUsers)
          .set({ role: "owner", isActive: true, updatedAt: new Date() })
          .where(eq(staffUsers.id, existingAdmin.id));
        console.log(`  owner обновлён: ${telegramId}`);
      } else {
        console.log(`  owner уже существует: ${telegramId}`);
      }
    }
  }

  console.log("→ Сид: категории");
  const categoryIdBySlug = new Map<string, string>();
  for (const cat of DEMO_CATEGORIES) {
    const [existing] = await db.select().from(categories).where(eq(categories.slug, cat.slug)).limit(1);
    if (existing) {
      categoryIdBySlug.set(cat.slug, existing.id);
      continue;
    }
    const [created] = await db.insert(categories).values(cat).returning({ id: categories.id });
    categoryIdBySlug.set(cat.slug, created.id);
  }
  console.log(`  категорий: ${categoryIdBySlug.size}`);

  console.log("→ Сид: товары");
  let createdCount = 0;
  for (const p of DEMO_PRODUCTS) {
    const [existing] = await db.select().from(products).where(eq(products.slug, p.slug)).limit(1);
    if (existing) continue;
    const [created] = await db
      .insert(products)
      .values({
        name: p.name,
        slug: p.slug,
        description: p.description,
        priceMinor: p.priceMinor,
        stock: p.stock,
        isActive: true,
        categoryId: categoryIdBySlug.get(p.category) ?? null,
      })
      .returning({ id: products.id });
    await db.insert(productImages).values(
      p.images.map((url, i) => ({ productId: created.id, url, sortOrder: i, isPrimary: i === 0 })),
    );
    createdCount++;
  }
  console.log(`  создано товаров: ${createdCount} (пропущено существующих: ${DEMO_PRODUCTS.length - createdCount})`);
  console.log("Готово.");
  process.exit(0);
}

main().catch((err) => {
  console.error("Ошибка сида:", err);
  process.exit(1);
});
