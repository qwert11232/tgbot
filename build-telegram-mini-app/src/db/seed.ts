import "dotenv/config";
import { eq } from "drizzle-orm";
import { db } from "./index";
import { categories, productImages, products, staffUsers } from "./schema";
import { hashPassword } from "../lib/passwords";

/**
 * Сид: первый owner (ADMIN_EMAIL/ADMIN_PASSWORD), демо-категории и товары.
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
    images: ["/seed/mug-dune.jpg"],
  },
  {
    name: "Чашка эспрессо «Уголь», 90 мл",
    slug: "chashka-espresso-ugol",
    category: "cups",
    description: "Компактная чашка для эспрессо из тёмной каменной массы. Матовая поверхность, удобная ручка под два пальца.",
    priceMinor: 129000,
    stock: 20,
    images: ["/seed/espresso.jpg"],
  },
  {
    name: "Ваза «Терра», высота 24 см",
    slug: "vaza-terra-24",
    category: "vases",
    description: "Высокая ваза из терракотовой глины без глазури. Живая фактура гончарного круга. Для сухоцветов и ветвей; для воды — с внутренним колбовидным вкладышем.",
    priceMinor: 349000,
    stock: 6,
    images: ["/seed/vase-terra.jpg"],
  },
  {
    name: "Подсвечники «Пара», набор из двух",
    slug: "podsvechniki-para",
    category: "candles",
    description: "Пара низких подсвечников под тонкие свечи. Молочная глазурь, устойчивое основание. Свечи в комплект не входят.",
    priceMinor: 219000,
    stock: 9,
    images: ["/seed/candles.jpg"],
  },
  {
    name: "Тарелка обеденная «Камень», 26 см",
    slug: "tarelka-kamen-26",
    category: "tableware",
    description: "Обеденная тарелка из каменной керамики с широким матовым бортом. Стекуется, подходит для ежедневного использования.",
    priceMinor: 249000,
    stock: 15,
    images: ["/seed/plate.jpg"],
  },
  {
    name: "Пиала «Лазурь», 400 мл",
    slug: "piala-lazur",
    category: "tableware",
    description: "Глубокая пиала с плывущей синей глазурью — узор не повторяется. Для супов, боулов и утренней гранолы.",
    priceMinor: 169000,
    stock: 0,
    images: ["/seed/bowl.jpg"],
  },
];

async function main() {
  console.log("→ Сид: владелец");
  const email = (process.env.ADMIN_EMAIL ?? "admin@gorn.local").toLowerCase();
  const password = process.env.ADMIN_PASSWORD ?? "gorn-admin-2026";
  const [existingAdmin] = await db.select().from(staffUsers).where(eq(staffUsers.email, email)).limit(1);
  if (!existingAdmin) {
    await db.insert(staffUsers).values({
      email,
      name: "Владелец",
      passwordHash: await hashPassword(password),
      role: "owner",
    });
    console.log(`  создан owner: ${email}`);
  } else {
    console.log(`  owner уже существует: ${email}`);
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
