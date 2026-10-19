import { SignJWT, jwtVerify } from "jose";

/**
 * Edge-safe часть сессий админки (без next/headers и БД) — используется proxy.ts
 * для быстрой проверки подписи (уровень 1 защиты).
 */

export const ADMIN_COOKIE = "admin_session";
export const ADMIN_SESSION_TTL_SEC = 60 * 60 * 12; // 12 часов

function sessionSecret(): Uint8Array {
  const secret = process.env.ADMIN_SESSION_SECRET;
  if (secret && secret.length >= 32) return new TextEncoder().encode(secret);
  if (process.env.NODE_ENV === "production") {
    throw new Error("ADMIN_SESSION_SECRET (минимум 32 символа) обязателен в production");
  }
  return new TextEncoder().encode("dev-only-insecure-admin-secret-change-me");
}

export interface AdminJwtPayload {
  sid: string;
  sub: string;
  sv: number; // sessionVersion на момент выдачи
}

export async function signAdminSessionJwt(payload: AdminJwtPayload): Promise<string> {
  return new SignJWT({ ...payload })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${ADMIN_SESSION_TTL_SEC}s`)
    .sign(sessionSecret());
}

/** Только криптографическая проверка (подпись + exp), без БД — для proxy.ts. */
export async function verifyAdminSessionJwt(token: string): Promise<AdminJwtPayload | null> {
  try {
    const { payload } = await jwtVerify(token, sessionSecret());
    if (typeof payload.sid !== "string" || typeof payload.sub !== "string" || typeof payload.sv !== "number") {
      return null;
    }
    return { sid: payload.sid, sub: payload.sub, sv: payload.sv };
  } catch {
    return null;
  }
}
