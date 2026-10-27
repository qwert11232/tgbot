import type { NextRequest } from "next/server";
import crypto from "node:crypto";
import { json, errorResponse, HttpError } from "@/lib/http";
import { expireStaleOrders, orderTtlMinutes } from "@/lib/orders/expire";

export const dynamic = "force-dynamic";

/**
 * Крон автоотмены неоплаченных заказов с возвратом остатков.
 *
 * Вызывается по расписанию (vercel.json → crons: раз в сутки, т.к. на Vercel
 * Hobby чаще нельзя; частый ритм 10 минут — .github/workflows/expire-orders.yml)
 * или вручную:
 *   curl -H "Authorization: Bearer $CRON_SECRET" https://app/api/cron/expire-orders
 * Защита: CRON_SECRET (Vercel присылает его в Authorization автоматически).
 * Если CRON_SECRET не задан, ручка доступна только вне production — чтобы
 * нельзя было случайно дёргать её на открытом стенде.
 */
function isAuthorized(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET?.trim() ?? "";
  if (!secret) return process.env.NODE_ENV !== "production";

  const header = req.headers.get("authorization") ?? "";
  const fromHeader = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  const fromQuery = req.nextUrl.searchParams.get("secret") ?? "";
  const provided = fromHeader || fromQuery;
  if (!provided) return false;

  const a = Buffer.from(provided);
  const b = Buffer.from(secret);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export async function GET(req: NextRequest) {
  try {
    if (!isAuthorized(req)) throw new HttpError(401, "Неверный или отсутствующий CRON_SECRET", "unauthorized");

    const limit = Math.min(500, Math.max(1, Number(req.nextUrl.searchParams.get("limit")) || 100));
    const result = await expireStaleOrders(limit);

    return json({
      ok: true,
      ttlMinutes: orderTtlMinutes(),
      cancelled: result.cancelled,
      orderNumbers: result.orderNumbers,
    });
  } catch (err) {
    return errorResponse(err);
  }
}
