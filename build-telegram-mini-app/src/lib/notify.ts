import { sendMessage } from "@/lib/telegram-bot";

/**
 * Уведомления администратору (группа/чат из ADMIN_NOTIFY_CHAT_ID).
 * Best-effort: сбой Telegram не должен ломать бизнес-операцию.
 */
export async function notifyAdmin(text: string): Promise<void> {
  // 1) Общий чат/группа (если задан ADMIN_NOTIFY_CHAT_ID).
  const chatId = process.env.ADMIN_NOTIFY_CHAT_ID?.trim();
  if (chatId) {
    await sendMessage(chatId, text).catch((err) => {
      console.error("[notify] admin notification failed:", err);
    });
  }
  // 2) Личные сообщения сотрудникам из staff_users (админка переехала в бота).
  try {
    const { notifyStaff } = await import("@/lib/admin-bot/service");
    await notifyStaff(text);
  } catch (err) {
    console.error("[notify] staff notification failed:", err);
  }
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
