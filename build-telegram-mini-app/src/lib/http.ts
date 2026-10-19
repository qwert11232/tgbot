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

export function getClientIp(headers: Headers): string {
  const fwd = headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0]?.trim() || "unknown";
  return headers.get("x-real-ip") ?? "unknown";
}

export async function sha256Hex(input: string): Promise<string> {
  const { createHash } = await import("node:crypto");
  return createHash("sha256").update(input).digest("hex");
}
