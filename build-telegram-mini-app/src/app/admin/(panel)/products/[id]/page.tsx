import { asc, eq } from "drizzle-orm";
import { notFound } from "next/navigation";
import { db } from "@/db";
import { categories, productImages, products } from "@/db/schema";
import { requireAdmin } from "@/lib/admin-session";
import { ProductForm, DeleteProductButton } from "@/components/admin/product-form";
import { GalleryEditor } from "@/components/admin/gallery-editor";

export const dynamic = "force-dynamic";

export default async function EditProductPage({ params }: { params: Promise<{ id: string }> }) {
  await requireAdmin(); // уровень 3: проверка на каждой странице
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();

  const [product] = await db.select().from(products).where(eq(products.id, id)).limit(1);
  if (!product) notFound();

  const images = await db
    .select()
    .from(productImages)
    .where(eq(productImages.productId, product.id))
    .orderBy(asc(productImages.sortOrder));

  const cats = await db
    .select()
    .from(categories)
    .where(eq(categories.isActive, true))
    .orderBy(asc(categories.sortOrder), asc(categories.name));

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="font-display text-3xl text-ink">{product.name}</h1>
        <DeleteProductButton productId={product.id} />
      </div>

      <div className="mt-8 grid gap-10 lg:grid-cols-[1fr_360px]">
        <ProductForm
          mode="edit"
          productId={product.id}
          categories={cats.map((c) => ({ id: c.id, name: c.name }))}
          initial={{
            name: product.name,
            description: product.description,
            categoryId: product.categoryId,
            priceMinor: product.priceMinor,
            stock: product.stock,
            isActive: product.isActive,
          }}
        />
        <section>
          <h2 className="text-sm font-bold uppercase tracking-wide text-mute">Галерея</h2>
          <p className="mt-1 text-xs leading-relaxed text-mute">
            Порядок меняется стрелками; «★» — главное фото (показывается в каталоге). Загрузка: до 5 МБ,
            JPEG/PNG/WebP/GIF, проверка по сигнатуре файла.
          </p>
          <div className="mt-4">
            <GalleryEditor
              productId={product.id}
              images={images.map((i) => ({
                id: i.id,
                url: i.url,
                sortOrder: i.sortOrder,
                isPrimary: i.isPrimary,
              }))}
            />
          </div>
        </section>
      </div>
    </div>
  );
}
