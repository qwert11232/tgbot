import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { staffSessions, staffUsers, type StaffRole } from "@/db/schema";
import { ForbiddenError } from "@/lib/http";
import { verifyAdminSessionJwt, ADMIN_COOKIE, ADMIN_SESSION_TTL_SEC } from "@/lib/admin-jwt";

export { ADMIN_COOKIE, ADMIN_SESSION_TTL_SEC } from "@/lib/admin-jwt";

/**
 * Выбор реализации авторизации админки: собственная сессия на signed httpOnly
 * cookie (JWT HS256) + серверная таблица staff_sessions для мгновенного отзыва.
 * Better Auth не используем, чтобы не тащить его схему/миграции и сохранить
 * полный контроль над трёхуровневой моделью защиты и RBAC.
 */

export interface AdminActor {
  id: string;
  email: string;
  name: string;
  role: StaffRole;
}

/**
 * Уровень 2: полная проверка по БД — сессия существует и не отозвана,
 * пользователь активен, sessionVersion совпадает с выданным в JWT.
 */
export async function getAdminActor(): Promise<AdminActor | null> {
  const store = await cookies();
  const token = store.get(ADMIN_COOKIE)?.value;
  if (!token) return null;
  const payload = await verifyAdminSessionJwt(token);
  if (!payload) return null;

  const [session] = await db.select().from(staffSessions).where(eq(staffSessions.id, payload.sid)).limit(1);
  if (!session || session.revokedAt || session.expiresAt.getTime() <= Date.now()) return null;
  if (session.userId !== payload.sub) return null;

  const [user] = await db.select().from(staffUsers).where(eq(staffUsers.id, payload.sub)).limit(1);
  if (!user || !user.isActive || user.sessionVersion !== payload.sv) return null;

  return { id: user.id, email: user.email, name: user.name, role: user.role };
}

/** Уровень 3 (страницы): редирект на логин, если сессии нет. */
export async function requireAdmin(): Promise<AdminActor> {
  const actor = await getAdminActor();
  if (!actor) redirect("/admin/login");
  return actor;
}

/** Уровень 3 (actions): явная проверка роли. Бросает ForbiddenError для owner-only операций. */
export function assertRole(actor: AdminActor, role: StaffRole): AdminActor {
  if (role === "owner" && actor.role !== "owner") {
    throw new ForbiddenError("Требуется роль владельца (owner)");
  }
  return actor;
}

export async function setAdminSessionCookie(token: string): Promise<void> {
  const store = await cookies();
  store.set(ADMIN_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: ADMIN_SESSION_TTL_SEC,
  });
}

export async function clearAdminSessionCookie(): Promise<void> {
  const store = await cookies();
  store.set(ADMIN_COOKIE, "", { httpOnly: true, path: "/", maxAge: 0 });
}
