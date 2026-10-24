import type { NextConfig } from "next";

/**
 * Заголовки безопасности.
 *
 * CSP задаём только директивой frame-ancestors: Mini App открывается внутри
 * Telegram (в т.ч. в iframe на web.telegram.org), поэтому X-Frame-Options и
 * «полный» CSP сломали бы встраивание. nosniff + строгий referrer закрывают
 * базовые риски (дефект P1-12).
 */
const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=()" },
  {
    key: "Content-Security-Policy",
    value: [
      "frame-ancestors 'self' https://web.telegram.org https://*.telegram.org https://*.t.me",
      "base-uri 'self'",
      "object-src 'none'",
    ].join("; "),
  },
  { key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" },
];

const nextConfig: NextConfig = {
  poweredByHeader: false,
  async headers() {
    return [
      { source: "/:path*", headers: securityHeaders },
      // Покупательские экраны не должны кэшироваться как документ.
      { source: "/app/:path*", headers: [{ key: "Cache-Control", value: "private, no-cache" }] },
    ];
  },
};

export default nextConfig;
