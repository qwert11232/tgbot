/**
 * Проверка загружаемых изображений по сигнатуре файла (magic bytes),
 * а не по заявленному клиентом MIME-типу. Поддерживаются JPEG/PNG/WebP/GIF.
 */

export interface DetectedImage {
  ext: "jpg" | "png" | "webp" | "gif";
  mime: "image/jpeg" | "image/png" | "image/webp" | "image/gif";
}

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // 5 МБ

function hasBytes(buf: Buffer, offset: number, bytes: number[]): boolean {
  if (buf.length < offset + bytes.length) return false;
  return bytes.every((b, i) => buf[offset + i] === b);
}

export function detectImageByMagicBytes(buf: Buffer): DetectedImage | null {
  // JPEG: FF D8 FF
  if (hasBytes(buf, 0, [0xff, 0xd8, 0xff])) return { ext: "jpg", mime: "image/jpeg" };
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (hasBytes(buf, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return { ext: "png", mime: "image/png" };
  }
  // WebP: "RIFF" .... "WEBP"
  if (hasBytes(buf, 0, [0x52, 0x49, 0x46, 0x46]) && hasBytes(buf, 8, [0x57, 0x45, 0x42, 0x50])) {
    return { ext: "webp", mime: "image/webp" };
  }
  // GIF: "GIF87a" / "GIF89a"
  if (hasBytes(buf, 0, [0x47, 0x49, 0x46, 0x38, 0x37, 0x61]) || hasBytes(buf, 0, [0x47, 0x49, 0x46, 0x38, 0x39, 0x61])) {
    return { ext: "gif", mime: "image/gif" };
  }
  return null;
}
