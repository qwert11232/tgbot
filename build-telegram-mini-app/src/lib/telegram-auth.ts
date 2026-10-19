import crypto from "node:crypto";
import { SignJWT, jwtVerify } from "jose";
import { eq, sql } from "drizzle-orm";
import { cookies } from "next/headers";
import { db, withDbRetry } from "@/db";
import { tgUsers, type TgUser } from "@/db/schema";

export const TG_COOKIE = "tg_session";
export const TG_SESSION_TTL_SEC = 60 * 60 * 24 * 30; // 30 дней

export interface TgInitUser {
  id: number;
  first_name?: string;
  last_name?: string;
  username?: string;
  language_code?: string;
}

export function botToken(): string {
  return process.env.BOT_TOKEN ?? "";
}

/**
 * Обход Telegram-авторизации для разработки в обычном браузере.
 * Двойное условие безопасности: работает ТОЛЬКО при явном флаге TG_AUTH_DEV_BYPASS=1
 * И отсутствующем BOT_TOKEN (реальный бот не настроен). В боевом окружении,
 * где задан BOT_TOKEN, обход невозможен даже при выставленном флаге.
 */
export function isDevBypassAllowed(): boolean {
  return process.env.TG_AUTH_DEV_BYPASS === "1" && !botToken();
}

export const DEV_TG_USER: TgInitUser = {
  id: 777000111,
  first_name: "Dev",
  last_name: "Preview",
  username: "dev_preview",
  language_code: "ru",
};

/**
 * Серверная верификация WebApp.initData:
 *  1) HMAC-SHA256(botToken, ключ "WebAppData") по data-check-string — подлинность;
 *  2) проверка auth_date не старше maxAgeSec — защита от replay-атак.
 */
export function verifyInitData(initData: string, token: string, maxAgeSec = 86400): TgInitUser | null {
  try {
    if (!initData || !token) return null;
    const params = new URLSearchParams(initData);
    const hash = params.get("hash");
    if (!hash) return null;
    params.delete("hash");

    const dataCheckString = Array.from(params.entries())
      .map(([k, v]) => `${k}=${v}`)
      .sort()
      .join("\n");

    const secretKey = crypto.createHmac("sha256", "WebAppData").update(token).digest();
    const expectedHex = crypto.createHmac("sha256", secretKey).update(dataCheckString).digest("hex");
    const expected = Buffer.from(expectedHex, "hex");
    const received = Buffer.from(hash, "hex");
    if (expected.length !== received.length || !crypto.timingSafeEqual(expected, received)) return null;

    const now = Math.floor(Date.now() / 1000);
    const authDate = Number(params.get("auth_date") ?? 0);
    if (!Number.isFinite(authDate) || authDate <= 0) return null;
    if (now - authDate > maxAgeSec || authDate - now > 300) return null; // replay protection + допуск на skew

    const userRaw = params.get("user");
    if (!userRaw) return null;
    const user = JSON.parse(userRaw) as TgInitUser;
    if (!user || typeof user.id !== "number") return null;
    return user;
  } catch {
    return null;
  }
}

function tgSessionSecret(): Uint8Array {
  const secret = process.env.TG_SESSION_SECRET ?? process.env.ADMIN_SESSION_SECRET;
  if (secret && secret.length >= 32) return new TextEncoder().encode(secret);
  if (process.env.NODE_ENV === "production") {
    throw new Error("TG_SESSION_SECRET (минимум 32 символа) обязателен в production");
  }
  return new TextEncoder().encode("dev-only-insecure-tg-secret-change-me");
}

export async function signTgSessionJwt(user: TgUser): Promise<string> {
  return new SignJWT({ sub: user.id, tid: user.telegramId })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${TG_SESSION_TTL_SEC}s`)
    .sign(tgSessionSecret());
}

/** Upsert пользователя Telegram по telegram_id, обновляет профильные поля. */
export async function upsertTgUser(u: TgInitUser): Promise<TgUser> {
  return withDbRetry(async () => {
    const [user] = await db
      .insert(tgUsers)
      .values({
        telegramId: u.id,
        username: u.username ?? null,
        firstName: u.first_name ?? null,
        lastName: u.last_name ?? null,
        languageCode: u.language_code ?? null,
      })
      .onConflictDoUpdate({
        target: tgUsers.telegramId,
        set: {
          username: u.username ?? null,
          firstName: u.first_name ?? null,
          lastName: u.last_name ?? null,
          languageCode: u.language_code ?? null,
          updatedAt: new Date(),
        },
      })
      .returning();
    return user;
  });
}

/**
 * Извлекает авторизованного Telegram-пользователя из запроса:
 * сначала заголовок Authorization: Bearer <jwt>, затем cookie tg_session.
 */
export async function getTgUserFromRequest(req: Request): Promise<TgUser | null> {
  const bearer = req.headers.get("authorization");
  let token: string | undefined;
  if (bearer?.startsWith("Bearer ")) {
    token = bearer.slice(7).trim();
  } else {
    const store = await cookies();
    token = store.get(TG_COOKIE)?.value;
  }
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, tgSessionSecret());
    if (typeof payload.sub !== "string") return null;
    const [user] = await db.select().from(tgUsers).where(eq(tgUsers.id, payload.sub)).limit(1);
    return user ?? null;
  } catch {
    return null;
  }
}

/** Нормализация telegram_id из initData для индексов/сравнений. */
export const tgIdSql = (id: number) => sql`${id}::bigint`;
