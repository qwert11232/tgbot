import { eq } from "drizzle-orm";
import { db } from "@/db";
import { botStates } from "@/db/schema";

/**
 * Машина состояний диалога. Живёт в БД (bot_states), а не в памяти процесса:
 * на Vercel каждый апдейт может попасть в новый инстанс, и начатый ввод
 * («введите цену») обязан пережить это.
 */

export type BotStateName =
  | "order_message" // сотрудник пишет сообщение покупателю
  | "product_price"
  | "product_stock"
  | "product_photo"
  | "product_new_name"
  | "product_new_price"
  | "staff_add_id"
  | "staff_add_name";

export interface BotState {
  state: BotStateName;
  payload: Record<string, unknown>;
}

export async function getState(chatId: number): Promise<BotState | null> {
  const [row] = await db.select().from(botStates).where(eq(botStates.chatId, chatId)).limit(1);
  if (!row) return null;
  return { state: row.state as BotStateName, payload: row.payload ?? {} };
}

export async function setState(
  chatId: number,
  staffId: string | null,
  state: BotStateName,
  payload: Record<string, unknown> = {},
): Promise<void> {
  await db
    .insert(botStates)
    .values({ chatId, staffId, state, payload })
    .onConflictDoUpdate({
      target: botStates.chatId,
      set: { state, payload, staffId, updatedAt: new Date() },
    });
}

export async function clearState(chatId: number): Promise<void> {
  await db.delete(botStates).where(eq(botStates.chatId, chatId));
}

/** Сумма в рублях («1 890», «1890,50») → минорные единицы (копейки). */
export function parseRubToMinor(input: string): number | null {
  const normalized = input.replace(/\s|\u00a0/g, "").replace(",", ".").replace(/₽|р|руб\.?/gi, "");
  if (!/^\d+(\.\d{1,2})?$/.test(normalized)) return null;
  const value = Math.round(Number(normalized) * 100);
  return Number.isFinite(value) ? value : null;
}

/** Целое неотрицательное число («12»). */
export function parseCount(input: string): number | null {
  const normalized = input.replace(/\s|\u00a0/g, "");
  if (!/^\d+$/.test(normalized)) return null;
  const value = Number(normalized);
  return Number.isSafeInteger(value) ? value : null;
}
