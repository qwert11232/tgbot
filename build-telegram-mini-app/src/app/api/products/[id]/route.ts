import type { NextRequest } from "next/server";
import { asc, eq } from "drizzle-orm";
import { dbHttp } from "@/db";
import { categories, productImages, products } from "@/db/schema";
import { json, errorResponse, HttpError } from "@/lib/http";

export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f-]{36}$/i;

/** Публичная карточка товара с галереей (чтение через neon-http). */
export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    if (!UUID_RE.test(id)) throw new HttpError(400, "Некорректный id товара", "bad_id");

    const [product] = await dbHttp.select().from(products).where(eq(products.id, id)).limit(1);
    if (!product || !product.isActive) throw new HttpError(404, "Товар не найден", "not_found");

    const images = await dbHttp
      .select()
      .from(productImages)
      .where(eq(productImages.productId, product.id))
      .orderBy(asc(productImages.sortOrder), asc(productImages.createdAt));

    const category = product.categoryId
      ? (await dbHttp.select().from(categories).where(eq(categories.id, product.categoryId)).limit(1))[0] ?? null
      : null;

    return json({
      product: {
        id: product.id,
        name: product.name,
        slug: product.slug,
        description: product.description,
        priceMinor: product.priceMinor,
        stock: product.stock,
        category: category ? { id: category.id, name: category.name, slug: category.slug } : null,
      },
      images: images.map((img) => ({ id: img.id, url: img.url, isPrimary: img.isPrimary })),
    });
  } catch (err) {
    return errorResponse(err);
  }
}
