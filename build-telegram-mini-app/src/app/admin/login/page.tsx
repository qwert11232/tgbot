import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getAdminActor } from "@/lib/admin-session";
import { LoginForm } from "./login-form";

export const metadata: Metadata = { title: "Вход — ГОРН" };
export const dynamic = "force-dynamic";

/** Куда безопасно возвращать после логина: только внутренние пути админки. */
function safeNextPath(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  if (!/^\/admin(\/[A-Za-z0-9\-_/]*)?$/.test(raw)) return undefined;
  if (raw === "/admin/login" || raw.startsWith("/admin/login?")) return undefined;
  return raw;
}

export default async function AdminLoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  // Уже авторизованного сотрудника не заставляем смотреть на форму логина.
  const actor = await getAdminActor();
  if (actor) redirect("/admin");

  const sp = await searchParams;
  return <LoginForm nextPath={safeNextPath(sp.next)} />;
}
