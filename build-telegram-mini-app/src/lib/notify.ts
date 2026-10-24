import { sendMessage } from "@/lib/telegram-bot";

/**
 * Уведомления администратору (группа/чат из ADMIN_NOTIFY_CHAT_ID).
 * Best-effort: сбой Telegram не должен ломать бизнес-операцию.
 */
export async function notifyAdmin(text: string): Promise<void> {
  const chatId = process.env.ADMIN_NOTIFY_CHAT_ID?.trim();
  if (!chatId) return;
  await sendMessage(chatId, text).catch((err) => {
    console.error("[notify] admin notification failed:", err);
  });
}

/** Экранирование пользовательских данных для parse_mode=HTML. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function formatRub(minor: number): string {
  return `${(minor / 100).toFixed(2)} ₽`;
}
