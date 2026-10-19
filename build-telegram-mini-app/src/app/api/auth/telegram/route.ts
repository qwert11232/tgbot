import type { NextRequest } from "next/server";
import { z } from "zod";
import {
  verifyInitData,
  upsertTgUser,
  signTgSessionJwt,
  botToken,
  isDevBypassAllowed,
  DEV_TG_USER,
  TG_COOKIE,
  TG_SESSION_TTL_SEC,
  type TgInitUser,
} from "@/lib/telegram-auth";
import { json, errorResponse, getClientIp, HttpError } from "@/lib/http";
import { rateLimit, RATE_LIMITS } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  initData: z.string().max(8192).optional().default(""),
  dev: z.literal("web-dev").optional(),
});

/**
 * Авторизация Mini App: серверная проверка подписи initData (HMAC с bot token)
 * + защита от replay (auth_date). Выдаёт JWT сессии покупателя.
 */
export async function POST(req: NextRequest) {
  try {
    const ip = getClientIp(req.headers);
    const rl = await rateLimit(`tg-auth:${ip}`, RATE_LIMITS.tgAuth.limit, RATE_LIMITS.tgAuth.windowSec);
    if (!rl.ok) {
      throw new HttpError(429, `Слишком много запросов. Повторите через ${rl.retryAfterSec} с.`, "rate_limited");
    }

    const body = bodySchema.parse(await req.json().catch(() => ({})));

    let tgUser: TgInitUser | null;
    if (body.dev === "web-dev" && isDevBypassAllowed()) {
      tgUser = DEV_TG_USER; // только локальная разработка, в production отключено жёстко
    } else {
      const token = botToken();
      if (!token) throw new HttpError(503, "BOT_TOKEN не настроен", "bot_not_configured");
      tgUser = verifyInitData(body.initData, token);
      if (!tgUser) {
        throw new HttpError(401, "Невалидные или истёкшие данные Telegram (initData)", "invalid_init_data");
      }
    }

    const user = await upsertTgUser(tgUser);
    const token = await signTgSessionJwt(user);

    const res = json({
      token,
      user: {
        id: user.id,
        telegramId: user.telegramId,
        firstName: user.firstName,
        lastName: user.lastName,
        username: user.username,
      },
    });
    // Cookie для webview-контекстов; основной транспорт — Authorization: Bearer.
    res.cookies.set(TG_COOKIE, token, {
      httpOnly: true,
      sameSite: "none",
      secure: true,
      path: "/",
      maxAge: TG_SESSION_TTL_SEC,
    });
    return res;
  } catch (err) {
    return errorResponse(err);
  }
}
