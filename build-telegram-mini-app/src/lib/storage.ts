/**
 * Хранилище изображений товаров.
 * Production (Vercel): Vercel Blob — требуется BLOB_READ_WRITE_TOKEN.
 * Локальная разработка: файлы в public/uploads (эфемерный fs на serverless —
 * только для dev, в production обязателен Blob).
 */

export interface SavedImage {
  url: string;
}

export async function saveImage(buf: Buffer, ext: string, mime: string): Promise<SavedImage> {
  const key = `products/${crypto.randomUUID()}.${ext}`;

  if (process.env.BLOB_READ_WRITE_TOKEN) {
    const { put } = await import("@vercel/blob");
    const blob = await put(key, buf, {
      access: "public",
      contentType: mime,
      addRandomSuffix: false,
    });
    return { url: blob.url };
  }

  return saveImageLocal(buf, key);
}

async function saveImageLocal(buf: Buffer, key: string): Promise<SavedImage> {
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const abs = path.join(process.cwd(), "public", "uploads", key);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, buf);
  return { url: `/uploads/${key}` };
}

/** Удаление изображения (best-effort): Blob → API, локальный файл → fs. */
export async function deleteImage(url: string): Promise<void> {
  try {
    if (process.env.BLOB_READ_WRITE_TOKEN && url.includes("blob.vercel-storage.com")) {
      const { del } = await import("@vercel/blob");
      await del(url);
      return;
    }
    if (url.startsWith("/uploads/")) {
      const fs = await import("node:fs/promises");
      const path = await import("node:path");
      const abs = path.join(process.cwd(), "public", url);
      // Защита от path traversal: путь обязан остаться внутри public/uploads.
      const uploadsRoot = path.join(process.cwd(), "public", "uploads");
      if (abs.startsWith(uploadsRoot)) await fs.unlink(abs).catch(() => {});
    }
  } catch (err) {
    console.error("[storage] delete failed:", url, err);
  }
}
