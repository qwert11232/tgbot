import { asc, eq } from "drizzle-orm";
import { notFound } from "next/navigation";
import { dbHttp } from "@/db";
import { categories, productImages, products } from "@/db/schema";
import { ProductView } from "@/components/miniapp/product-detail";
import { TelegramBack } from "@/components/miniapp/telegram-back";

export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f-]{36}$/i;

export default async function ProductPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!UUID_RE.test(id)) notFound();

  const [product] = await dbHttp.select().from(products).where(eq(products.id, id)).limit(1);
  if (!product || !product.isActive) notFound();

  const images = await dbHttp
    .select()
    .from(productImages)
    .where(eq(productImages.productId, product.id))
    .orderBy(asc(productImages.sortOrder), asc(productImages.createdAt));

  const category = product.categoryId
    ? ((await dbHttp.select().from(categories).where(eq(categories.id, product.categoryId)).limit(1))[0] ?? null)
    : null;

  return (
    <>
      <TelegramBack href="/app" />
      <ProductView
        product={{
          id: product.id,
          name: product.name,
          description: product.description,
          priceMinor: product.priceMinor,
          stock: product.stock,
          category: category ? { id: category.id, name: category.name, slug: category.slug } : null,
        }}
        images={images.map((img) => ({ id: img.id, url: img.url, isPrimary: img.isPrimary }))}
      />
    </>
  );
}
