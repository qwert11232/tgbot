import type { NextRequest } from "next/server";
import { mimeByFileName, resolveUploadPath } from "@/lib/storage";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Отдача локально загруженных изображений (public/uploads).
 *
 * Нужна потому, что статика из public в `next start` — это снимок на момент
 * сборки: файл, загруженный админом после деплоя, статикой не отдавался (404).
 * В production на Vercel изображения живут в Vercel Blob, и этот маршрут не
 * используется; он страхует self-hosted и локальный production-режим.
 */
export async function GET(_req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  const { path } = await ctx.params;
  const abs = resolveUploadPath(path ?? []);
  if (!abs) return new Response("Not found", { status: 404 });

  try {
    const fs = await import("node:fs/promises");
    const stat = await fs.stat(abs);
    if (!stat.isFile()) return new Response("Not found", { status: 404 });

    const file = await fs.readFile(abs);
    return new Response(new Uint8Array(file), {
      status: 200,
      headers: {
        "content-type": mimeByFileName(abs),
        "content-length": String(file.byteLength),
        // Имена файлов — UUID, содержимое неизменяемо.
        "cache-control": "public, max-age=31536000, immutable",
        "x-content-type-options": "nosniff",
        // Изображения товаров не должны исполняться как документ (SVG/HTML).
        "content-security-policy": "default-src 'none'; img-src 'self'; sandbox",
      },
    });
  } catch {
    return new Response("Not found", { status: 404 });
  }
}
