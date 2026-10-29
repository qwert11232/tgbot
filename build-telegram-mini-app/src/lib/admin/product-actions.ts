"use server";

import { revalidatePath } from "next/cache";
import { z, ZodError } from "zod";
import { and, asc, desc, eq, gt, lt, ne, sql } from "drizzle-orm";
import { db } from "@/db";
import { productImages, products } from "@/db/schema";
import { getAdminActor } from "@/lib/admin-session";
import { ForbiddenError, HttpError } from "@/lib/http";
import { uniqueSlug } from "@/lib/slug";
import { deleteImage } from "@/lib/storage";
import { isUniqueViolation, userFacingDbError } from "@/lib/db-errors";

type ActionResult<T = undefined> = T extends undefined
  ? { ok: true } | { ok: false; error: string }
  : { ok: true; data: T } | { ok: false; error: string };

const ok = () => ({ ok: true as const });

function fail(err: unknown): { ok: false; error: string } {
  if (err instanceof ZodError) return { ok: false, error: err.issues[0]?.message ?? "Ошибка валидации данных" };
  if (err instanceof ForbiddenError || err instanceof HttpError) return { ok: false, error: err.message };
  console.error("[product] action failed:", err);
  return { ok: false, error: userFacingDbError(err, "Не удалось сохранить товар. Попробуйте ещё раз") };
}

/** Товары и галереи доступны обеим ролям (owner и manager). */
async function requireStaff() {
  const actor = await getAdminActor();
  if (!actor) throw new ForbiddenError("Требуется авторизация администратора");
  return actor;
}

const productInputSchema = z.object({
  name: z.string().trim().min(2, "Название минимум 2 символа").max(220),
  description: z.string().trim().max(5000).default(""),
  categoryId: z
    .string()
    .trim()
    .nullable()
    .optional()
    .transform((v) => (v && /^[0-9a-f-]{36}$/i.test(v) ? v : null)),
  priceRub: z.string().trim().min(1, "Укажите цену").max(20),
  stock: z.coerce.number().int().min(0, "Остаток не может быть отрицательным").max(1_000_000),
  isActive: z.boolean().default(true),
});

function priceToMinor(priceRub: string): number {
  const normalized = priceRub.replace(/\s/g, "").replace(",", ".");
  const value = Math.round(Number(normalized) * 100);
  if (!Number.isFinite(value) || value < 0) throw new Error("Некорректная цена");
  return value;
}

export async function createProductAction(input: unknown): Promise<ActionResult<{ id: string }>> {
  try {
    await requireStaff();
    const data = productInputSchema.parse(input);
    const priceMinor = priceToMinor(data.priceRub);

    // Редкий конфликт slug — повтор с новым суффиксом.
    let inserted: { id: string } | undefined;
    for (let attempt = 0; attempt < 2 && !inserted; attempt++) {
      try {
        [inserted] = await db
          .insert(products)
          .values({
            name: data.name,
            slug: uniqueSlug(data.name),
            description: data.description,
            categoryId: data.categoryId,
            priceMinor,
            stock: data.stock,
            isActive: data.isActive,
          })
          .returning({ id: products.id });
      } catch (err) {
        // drizzle оборачивает ошибку драйвера: код 23505 ищем и в cause.
        if (attempt === 1 || !isUniqueViolation(err)) throw err;
      }
    }
    revalidatePath("/admin/products");
    return { ok: true as const, data: { id: inserted!.id } };
  } catch (err) {
    return fail(err);
  }
}

export async function updateProductAction(productId: string, input: unknown): Promise<ActionResult> {
  try {
    await requireStaff();
    if (!z.uuid().safeParse(productId).success) throw new Error("Некорректный id товара");
    const data = productInputSchema.parse(input);
    const priceMinor = priceToMinor(data.priceRub);

    const updated = await db
      .update(products)
      .set({
        name: data.name,
        description: data.description,
        categoryId: data.categoryId,
        priceMinor,
        stock: data.stock,
        isActive: data.isActive,
        updatedAt: new Date(),
      })
      .where(eq(products.id, productId))
      .returning({ id: products.id });
    if (updated.length === 0) throw new Error("Товар не найден");

    revalidatePath("/admin/products");
    revalidatePath(`/admin/products/${productId}`);
    return ok();
  } catch (err) {
    return fail(err);
  }
}

export async function deleteProductAction(productId: string): Promise<ActionResult> {
  try {
    await requireStaff();
    if (!z.uuid().safeParse(productId).success) throw new Error("Некорректный id товара");

    const images = await db.select().from(productImages).where(eq(productImages.productId, productId));
    const deleted = await db.delete(products).where(eq(products.id, productId)).returning({ id: products.id });
    if (deleted.length === 0) throw new Error("Товар не найден");

    // Файлы удаляем best-effort после коммита (order_items хранит снапшоты — заказы не пострадают).
    for (const img of images) void deleteImage(img.url);

    revalidatePath("/admin/products");
    return ok();
  } catch (err) {
    return fail(err);
  }
}

/* --------------------------------- gallery --------------------------------- */

export async function attachProductImageAction(productId: string, url: string): Promise<ActionResult<{ id: string }>> {
  try {
    await requireStaff();
    if (!z.uuid().safeParse(productId).success) throw new Error("Некорректный id товара");
    if (!/^\/uploads\/[\w/.-]+$/.test(url) && !/^https:\/\/[\w.-]+blob\.vercel-storage\.com\//.test(url) && !/^https:\/\//.test(url)) {
      throw new Error("Недопустимый URL изображения");
    }

    const id = await db.transaction(async (tx) => {
      const [agg] = await tx
        .select({ max: sql<number | null>`max(${productImages.sortOrder})` })
        .from(productImages)
        .where(eq(productImages.productId, productId));
      const maxSort = agg?.max === null || agg?.max === undefined ? null : Number(agg.max);
      const [img] = await tx
        .insert(productImages)
        .values({ productId, url, sortOrder: (maxSort ?? -1) + 1, isPrimary: maxSort === null })
        .returning({ id: productImages.id });
      return img.id;
    });

    revalidatePath(`/admin/products/${productId}`);
    return { ok: true as const, data: { id } };
  } catch (err) {
    return fail(err);
  }
}

export async function removeProductImageAction(imageId: string): Promise<ActionResult> {
  try {
    await requireStaff();
    if (!z.uuid().safeParse(imageId).success) throw new Error("Некорректный id изображения");

    const url = await db.transaction(async (tx) => {
      const [image] = await tx.select().from(productImages).where(eq(productImages.id, imageId)).limit(1);
      if (!image) throw new Error("Изображение не найдено");
      await tx.delete(productImages).where(eq(productImages.id, image.id));
      if (image.isPrimary) {
        // Первое оставшееся фото становится главным.
        const [next] = await tx
          .select()
          .from(productImages)
          .where(eq(productImages.productId, image.productId))
          .orderBy(asc(productImages.sortOrder))
          .limit(1);
        if (next) await tx.update(productImages).set({ isPrimary: true }).where(eq(productImages.id, next.id));
      }
      return { url: image.url, productId: image.productId };
    });

    void deleteImage(url.url);
    revalidatePath(`/admin/products/${url.productId}`);
    return ok();
  } catch (err) {
    return fail(err);
  }
}

export async function moveProductImageAction(imageId: string, direction: "up" | "down"): Promise<ActionResult> {
  try {
    await requireStaff();
    if (!z.uuid().safeParse(imageId).success) throw new Error("Некорректный id изображения");

    const productId = await db.transaction(async (tx) => {
      const [image] = await tx.select().from(productImages).where(eq(productImages.id, imageId)).limit(1);
      if (!image) throw new Error("Изображение не найдено");

      const neighborQuery =
        direction === "up"
          ? tx
              .select()
              .from(productImages)
              .where(and(eq(productImages.productId, image.productId), lt(productImages.sortOrder, image.sortOrder)))
              .orderBy(desc(productImages.sortOrder))
              .limit(1)
          : tx
              .select()
              .from(productImages)
              .where(and(eq(productImages.productId, image.productId), gt(productImages.sortOrder, image.sortOrder)))
              .orderBy(asc(productImages.sortOrder))
              .limit(1);
      const [neighbor] = await neighborQuery;
      if (!neighbor) return image.productId; // край — без изменений

      // Меняем местами sort_order (промежуточные отрицательные значения — чтобы не поймать конфликтов).
      await tx.update(productImages).set({ sortOrder: neighbor.sortOrder }).where(eq(productImages.id, image.id));
      await tx.update(productImages).set({ sortOrder: image.sortOrder }).where(eq(productImages.id, neighbor.id));
      return image.productId;
    });

    revalidatePath(`/admin/products/${productId}`);
    return ok();
  } catch (err) {
    return fail(err);
  }
}

export async function setPrimaryImageAction(imageId: string): Promise<ActionResult> {
  try {
    await requireStaff();
    if (!z.uuid().safeParse(imageId).success) throw new Error("Некорректный id изображения");

    const productId = await db.transaction(async (tx) => {
      const [image] = await tx.select().from(productImages).where(eq(productImages.id, imageId)).limit(1);
      if (!image) throw new Error("Изображение не найдено");
      // Ровно одно главное фото на товар — в одной транзакции.
      await tx.update(productImages).set({ isPrimary: false }).where(and(eq(productImages.productId, image.productId), ne(productImages.id, image.id)));
      await tx.update(productImages).set({ isPrimary: true }).where(eq(productImages.id, image.id));
      return image.productId;
    });

    revalidatePath(`/admin/products/${productId}`);
    return ok();
  } catch (err) {
    return fail(err);
  }
}
