import { NextResponse } from "next/server";
import { ZodError } from "zod";

/** Ошибка с HTTP-статусом — маппится в ответ в route handlers. */
export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public code?: string,
  ) {
    super(message);
  }
}

export class ForbiddenError extends Error {
  constructor(message = "Недостаточно прав") {
    super(message);
  }
}

export function json<T>(data: T, init?: number | ResponseInit): NextResponse {
  const responseInit: ResponseInit = typeof init === "number" ? { status: init } : (init ?? {});
  return NextResponse.json(data, responseInit);
}

/** Унифицированный маппинг ошибок route handlers в JSON-ответы. */
export function errorResponse(err: unknown): NextResponse {
  if (err instanceof HttpError) {
    return NextResponse.json({ error: err.message, code: err.code ?? null }, { status: err.status });
  }
  if (err instanceof ForbiddenError) {
    return NextResponse.json({ error: err.message, code: "forbidden" }, { status: 403 });
  }
  if (err instanceof ZodError) {
    const first = err.issues[0];
    return NextResponse.json(
      { error: `Ошибка валидации: ${first?.path.join(".")} ${first?.message ?? ""}`.trim(), code: "validation" },
      { status: 400 },
    );
  }
  console.error("[api] unexpected error:", err);
  return NextResponse.json({ error: "Внутренняя ошибка сервера", code: "internal" }, { status: 500 });
}

/**
 * IP клиента для rate limiting.
 *
 * X-Forwarded-For легко подделывается клиентом (заголовок просто дописывается
 * слева), поэтому брать первый элемент нельзя — иначе лимит логина обходится
 * одной строкой (дефект P1-9). Доверяем только заголовкам, которые
 * проставляет инфраструктура:
 *   1. x-vercel-forwarded-for (Vercel, не перезаписывается клиентом);
 *   2. x-real-ip (nginx/Cloudflare-прокси);
 *   3. последний элемент x-forwarded-for — адрес, добавленный нашим прокси.
 * Значение из query/body/cookie не используется никогда.
 */
export function getClientIp(headers: Headers): string {
  const vercel = headers.get("x-vercel-forwarded-for");
  if (vercel) return vercel.split(",")[0]?.trim() || "unknown";

  const realIp = headers.get("x-real-ip");
  if (realIp) return realIp.trim() || "unknown";

  const fwd = headers.get("x-forwarded-for");
  if (fwd) {
    const parts = fwd.split(",").map((p) => p.trim()).filter(Boolean);
    const last = parts[parts.length - 1];
    if (last) return last;
  }
  return "unknown";
}

export async function sha256Hex(input: string): Promise<string> {
  const { createHash } = await import("node:crypto");
  return createHash("sha256").update(input).digest("hex");
}
