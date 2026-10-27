/**
 * Политика cookie сессии админки — чистые функции без next/headers,
 * чтобы их можно было покрыть юнит-тестами.
 *
 * История дефекта: cookie ставилась как `SameSite=lax` + `secure: NODE_ENV ===
 * "production"`. Из-за этого вход в панель слетал и каждый раздел снова просил
 * пароль:
 *
 *  1. `next start` за обычным http (self-hosted, локальная сеть, IP:3000):
 *     браузер отбрасывает Secure-cookie, сессия не сохраняется;
 *  2. панель открыта во встроенном окне (iframe на другом домене — превью,
 *     порталы): `SameSite=lax` не отправляется в стороннем контексте.
 */

export type AdminCookieSameSite = "lax" | "strict" | "none";

export interface AdminCookiePolicy {
  secure: boolean;
  sameSite: AdminCookieSameSite;
}

export interface AdminCookiePolicyInput {
  /** `x-forwarded-proto` как пришёл от прокси/CDN (может быть списком). */
  forwardedProto?: string | null;
  /** `process.env.NODE_ENV` — используется, если прокси не сообщил протокол. */
  nodeEnv?: string | null;
  /** `ADMIN_COOKIE_SAMESITE`: lax | strict | none. */
  override?: string | null;
}

export function resolveAdminCookiePolicy(input: AdminCookiePolicyInput): AdminCookiePolicy {
  const proto = (input.forwardedProto ?? "").split(",")[0].trim().toLowerCase();
  const nodeEnv = input.nodeEnv ?? "development";
  const isHttps = proto ? proto === "https" : nodeEnv === "production";

  const raw = (input.override ?? "").trim().toLowerCase();
  const sameSite: AdminCookieSameSite = raw === "none" || raw === "strict" || raw === "lax" ? raw : "lax";

  if (sameSite === "none") {
    // SameSite=None без Secure браузер выбрасывает — на http откатываемся на lax.
    return isHttps ? { secure: true, sameSite: "none" } : { secure: false, sameSite: "lax" };
  }
  return { secure: isHttps, sameSite };
}
