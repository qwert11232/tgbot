import path from "node:path";

/**
 * Хранилище изображений товаров.
 *
 * Production (Vercel): Vercel Blob — обязателен BLOB_READ_WRITE_TOKEN.
 * Локальная разработка / self-hosted: файлы в public/uploads, отдаются
 * route-обработчиком /uploads/[...path] (см. src/app/uploads/[...path]/route.ts).
 *
 * Почему не отдаём файлы как статику из public: `next start` обслуживает только
 * те файлы, что существовали на момент `next build`, поэтому загруженное после
 * сборки изображение отдавало 404 (дефект P0-4).
 */

export const UPLOAD_ROOT = path.join(process.cwd(), "public", "uploads");
export const UPLOAD_URL_PREFIX = "/uploads/";

export class StorageNotConfiguredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StorageNotConfiguredError";
  }
}

export interface SavedImage {
  url: string;
}

function isVercel(): boolean {
  return Boolean(process.env.VERCEL);
}

/**
 * Локальная ФС на serverless (Vercel/Lambda) доступна только на чтение и
 * эфемерна: без Blob-токена загрузка не имеет смысла, поэтому честно сообщаем
 * об ошибке конфигурации вместо тихой потери файла.
 */
export function localStorageAvailable(): boolean {
  return !isVercel();
}

export async function saveImage(buf: Buffer, ext: string, mime: string): Promise<SavedImage> {
  const key = `products/${crypto.randomUUID()}.${ext}`;
  const token = process.env.BLOB_READ_WRITE_TOKEN;

  if (token) {
    const { put } = await import("@vercel/blob");
    const blob = await put(key, buf, {
      access: "public",
      contentType: mime,
      addRandomSuffix: false,
    });
    return { url: blob.url };
  }

  if (!localStorageAvailable()) {
    throw new StorageNotConfiguredError(
      "Хранилище изображений не настроено: задайте BLOB_READ_WRITE_TOKEN (Vercel Blob). На serverless локальная файловая система недоступна для записи.",
    );
  }

  return saveImageLocal(buf, key);
}

async function saveImageLocal(buf: Buffer, key: string): Promise<SavedImage> {
  const fs = await import("node:fs/promises");
  const abs = path.join(UPLOAD_ROOT, key);
  try {
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, buf);
  } catch (err) {
    console.error("[storage] write failed:", abs, err);
    throw new StorageNotConfiguredError(
      "Не удалось сохранить файл на диск. Проверьте права на public/uploads или настройте BLOB_READ_WRITE_TOKEN.",
    );
  }
  return { url: `${UPLOAD_URL_PREFIX}${key}` };
}

/** Безопасное разрешение пути внутри public/uploads (защита от path traversal). */
export function resolveUploadPath(segments: string[]): string | null {
  if (segments.length === 0) return null;
  const decoded = segments.map((s) => {
    try {
      return decodeURIComponent(s);
    } catch {
      return s;
    }
  });
  if (decoded.some((s) => s.includes("\0") || s.includes("/") || s.includes("\\") || s === ".." || s === ".")) {
    return null;
  }
  const abs = path.resolve(UPLOAD_ROOT, ...decoded);
  const rootWithSep = UPLOAD_ROOT.endsWith(path.sep) ? UPLOAD_ROOT : UPLOAD_ROOT + path.sep;
  return abs.startsWith(rootWithSep) ? abs : null;
}

const MIME_BY_EXT: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  svg: "image/svg+xml",
  avif: "image/avif",
};

export function mimeByFileName(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  return MIME_BY_EXT[ext] ?? "application/octet-stream";
}

/** Удаление изображения (best-effort): Blob → API, локальный файл → fs. */
export async function deleteImage(url: string): Promise<void> {
  try {
    if (process.env.BLOB_READ_WRITE_TOKEN && url.includes("blob.vercel-storage.com")) {
      const { del } = await import("@vercel/blob");
      await del(url);
      return;
    }
    if (url.startsWith(UPLOAD_URL_PREFIX)) {
      const fs = await import("node:fs/promises");
      const rel = url.slice(UPLOAD_URL_PREFIX.length);
      const abs = resolveUploadPath(rel.split("/"));
      if (abs) await fs.unlink(abs).catch(() => {});
    }
  } catch (err) {
    console.error("[storage] delete failed:", url, err);
  }
}
