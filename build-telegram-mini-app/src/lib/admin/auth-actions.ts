"use server";

import { z } from "zod";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { staffSessions, staffUsers } from "@/db/schema";
import {
  ADMIN_SESSION_TTL_SEC,
  setAdminSessionCookie,
  clearAdminSessionCookie,
  getAdminActor,
} from "@/lib/admin-session";
import { signAdminSessionJwt } from "@/lib/admin-jwt";
import { verifyPasswordOrDummy } from "@/lib/passwords";
import { rateLimit, RATE_LIMITS } from "@/lib/rate-limit";
import { getClientIp } from "@/lib/http";

const loginSchema = z.object({
  email: z.email().max(200),
  password: z.string().min(1).max(200),
});

/** Возврат на запрошенную страницу админки после логина (только внутренние пути). */
function safeNextPath(raw: FormDataEntryValue | null): string {
  const value = typeof raw === "string" ? raw : "";
  if (!/^\/admin(\/[A-Za-z0-9\-_/]*)?$/.test(value)) return "/admin";
  if (value === "/admin/login") return "/admin";
  return value;
}

export interface LoginState {
  error?: string;
}

export async function loginAction(_prev: LoginState, formData: FormData): Promise<LoginState> {
  const h = await headers();
  const ip = getClientIp(h);

  const parsed = loginSchema.safeParse({
    email: formData.get("email"),
    password: formData.get("password"),
  });
  if (!parsed.success) return { error: "Введите корректные email и пароль" };

  // Rate limit: 8 попыток / 10 минут — и на IP, и на email.
  // Лимит только по IP обходится подменой X-Forwarded-For (дефект P1-9),
  // поэтому вторая «ось» привязана к аккаунту и от заголовков не зависит.
  const emailKey = parsed.data.email.trim().toLowerCase();
  const [byIp, byEmail] = await Promise.all([
    rateLimit(`admin-login:ip:${ip}`, RATE_LIMITS.adminLogin.limit, RATE_LIMITS.adminLogin.windowSec),
    rateLimit(`admin-login:email:${emailKey}`, RATE_LIMITS.adminLogin.limit, RATE_LIMITS.adminLogin.windowSec),
  ]);
  const rl = !byIp.ok ? byIp : byEmail;
  if (!rl.ok) return { error: `Слишком много попыток. Повторите через ${rl.retryAfterSec} с.` };

  const [user] = await db.select().from(staffUsers).where(eq(staffUsers.email, parsed.data.email)).limit(1);
  // Сравнение с dummy-хэшом при отсутствии пользователя — выравниваем тайминг (анти user-enumeration).
  const passwordOk = await verifyPasswordOrDummy(parsed.data.password, user?.passwordHash ?? null);
  if (!user || !passwordOk) return { error: "Неверный email или пароль" };
  if (!user.isActive) return { error: "Учётная запись деактивирована" };

  const expiresAt = new Date(Date.now() + ADMIN_SESSION_TTL_SEC * 1000);
  const [session] = await db
    .insert(staffSessions)
    .values({ userId: user.id, expiresAt, ip, userAgent: h.get("user-agent") ?? null })
    .returning();

  const token = await signAdminSessionJwt({ sid: session.id, sub: user.id, sv: user.sessionVersion });
  await setAdminSessionCookie(token);
  // proxy.ts кладёт исходный путь в ?next= — раньше он терялся (дефект P1-13).
  redirect(safeNextPath(formData.get("next")));
}

export async function logoutAction(): Promise<void> {
  const actor = await getAdminActor();
  if (actor) {
    // Отзываем все активные сессии пользователя (logout со всех устройств своих сессий).
    await db
      .update(staffSessions)
      .set({ revokedAt: new Date() })
      .where(eq(staffSessions.userId, actor.id));
  }
  await clearAdminSessionCookie();
  redirect("/admin/login");
}
