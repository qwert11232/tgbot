import type { NextRequest } from "next/server";
import { and, asc, desc, eq, ilike, inArray } from "drizzle-orm";
import { dbHttp } from "@/db";
import { categories, productImages, products } from "@/db/schema";
import { json, errorResponse } from "@/lib/http";

export const dynamic = "force-dynamic";

/** Публичный каталог Mini App: простые чтения без транзакций — идут через neon-http. */
export async function GET(req: NextRequest) {
  try {
    const url = new URL(req.url);
    const q = url.searchParams.get("q")?.trim() ?? "";
    const categorySlug = url.searchParams.get("category")?.trim() ?? "";
    const idsParam = url.searchParams.get("ids")?.trim() ?? "";
    const limit = Math.min(48, Math.max(1, Number(url.searchParams.get("limit")) || 24));
    const offset = Math.max(0, Number(url.searchParams.get("offset")) || 0);

    const cats = await dbHttp
      .select()
      .from(categories)
      .where(eq(categories.isActive, true))
      .orderBy(asc(categories.sortOrder), asc(categories.name));

    const conditions = [eq(products.isActive, true)];

    if (idsParam) {
      const ids = idsParam.split(",").map((s) => s.trim()).filter((s) => /^[0-9a-f-]{36}$/i.test(s)).slice(0, 50);
      if (ids.length === 0) return json({ products: [], categories: cats, nextOffset: null });
      conditions.push(inArray(products.id, ids));
    }
    if (q) conditions.push(ilike(products.name, `%${q.slice(0, 80)}%`));
    if (categorySlug) {
      const cat = cats.find((c) => c.slug === categorySlug);
      if (!cat) return json({ products: [], categories: cats, nextOffset: null });
      conditions.push(eq(products.categoryId, cat.id));
    }

    const rows = await dbHttp
      .select()
      .from(products)
      .where(and(...conditions))
      .orderBy(desc(products.createdAt))
      .limit(limit + 1)
      .offset(offset);

    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);
    const ids = page.map((p) => p.id);
    const images = ids.length
      ? await dbHttp
          .select()
          .from(productImages)
          .where(and(inArray(productImages.productId, ids), eq(productImages.isPrimary, true)))
      : [];
    const imageByProduct = new Map(images.map((img) => [img.productId, img.url]));

    return json({
      products: page.map((p) => ({
        id: p.id,
        name: p.name,
        slug: p.slug,
        description: p.description,
        priceMinor: p.priceMinor,
        stock: p.stock,
        imageUrl: imageByProduct.get(p.id) ?? null,
      })),
      categories: cats.map((c) => ({ id: c.id, name: c.name, slug: c.slug })),
      nextOffset: hasMore ? offset + limit : null,
    });
  } catch (err) {
    return errorResponse(err);
  }
}
