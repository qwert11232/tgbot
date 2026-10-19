import { NextResponse, type NextRequest } from "next/server";
import { verifyAdminSessionJwt, ADMIN_COOKIE } from "@/lib/admin-jwt";

/**
 * Уровень 1 защиты админки (Next.js 16 "proxy", бывший middleware):
 * быстрая криптографическая проверка session-JWT БЕЗ обращения к БД.
 * Это только отсекатель трафика — реальные решения принимают
 * уровень 2 (БД-проверка) и уровень 3 (роль на странице/в action).
 */
export async function proxy(request: NextRequest): Promise<NextResponse> {
  const { pathname } = request.nextUrl;

  if (pathname === "/admin/login") return NextResponse.next();

  const token = request.cookies.get(ADMIN_COOKIE)?.value;
  const payload = token ? await verifyAdminSessionJwt(token) : null;

  if (pathname.startsWith("/api/admin")) {
    if (!payload) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    return NextResponse.next();
  }

  if (!payload) {
    const url = request.nextUrl.clone();
    url.pathname = "/admin/login";
    url.search = `?next=${encodeURIComponent(pathname)}`;
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/admin/:path*", "/api/admin/:path*"],
};
