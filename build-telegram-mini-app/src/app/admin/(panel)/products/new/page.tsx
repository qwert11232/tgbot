import { asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { categories } from "@/db/schema";
import { requireAdmin } from "@/lib/admin-session";
import { ProductForm } from "@/components/admin/product-form";

export const dynamic = "force-dynamic";

export default async function NewProductPage() {
  await requireAdmin(); // уровень 3: проверка на каждой странице
  const cats = await db
    .select()
    .from(categories)
    .where(eq(categories.isActive, true))
    .orderBy(asc(categories.sortOrder), asc(categories.name));

  return (
    <div className="max-w-2xl">
      <h1 className="font-display text-3xl text-ink">Новый товар</h1>
      <p className="mt-1 text-sm text-mute">Сначала сохраните товар — затем добавьте фотографии галереи.</p>
      <div className="mt-6">
        <ProductForm mode="create" categories={cats.map((c) => ({ id: c.id, name: c.name }))} />
      </div>
    </div>
  );
}
