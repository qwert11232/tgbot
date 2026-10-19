import type { NextRequest } from "next/server";
import { getAdminActor } from "@/lib/admin-session";
import { json, errorResponse, HttpError } from "@/lib/http";
import { rateLimit, RATE_LIMITS } from "@/lib/rate-limit";
import { detectImageByMagicBytes, MAX_IMAGE_BYTES } from "@/lib/image-validation";
import { saveImage } from "@/lib/storage";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Загрузка изображений товаров (админка).
 * Проверки: авторизация, rate limit, лимит размера, сигнатура файла
 * (magic bytes — не доверяем MIME от клиента). Имя файла генерируется сервером.
 */
export async function POST(req: NextRequest) {
  try {
    const actor = await getAdminActor();
    if (!actor) throw new HttpError(401, "Требуется авторизация администратора", "unauthorized");

    const rl = await rateLimit(`admin-upload:${actor.id}`, RATE_LIMITS.adminUpload.limit, RATE_LIMITS.adminUpload.windowSec);
    if (!rl.ok) throw new HttpError(429, `Слишком много загрузок. Повторите через ${rl.retryAfterSec} с.`, "rate_limited");

    const form = await req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) throw new HttpError(400, "Поле file обязательно", "no_file");
    if (file.size <= 0) throw new HttpError(400, "Пустой файл", "empty_file");
    if (file.size > MAX_IMAGE_BYTES) {
      throw new HttpError(413, `Файл больше допустимых ${MAX_IMAGE_BYTES / 1024 / 1024} МБ`, "too_large");
    }

    const buf = Buffer.from(await file.arrayBuffer());
    const detected = detectImageByMagicBytes(buf);
    if (!detected) {
      throw new HttpError(415, "Разрешены только JPEG, PNG, WebP или GIF (проверка по сигнатуре файла)", "bad_type");
    }

    const saved = await saveImage(buf, detected.ext, detected.mime);
    return json({ url: saved.url }, 201);
  } catch (err) {
    return errorResponse(err);
  }
}
