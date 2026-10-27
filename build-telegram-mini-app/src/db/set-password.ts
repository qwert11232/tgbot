import "dotenv/config";
import { eq, sql } from "drizzle-orm";
import { db } from "./index";
import { staffUsers } from "./schema";
import { hashPassword } from "../lib/passwords";

/**
 * Сброс пароля сотрудника из консоли (в админке нет «забыли пароль»).
 *
 *   npx tsx src/db/set-password.ts <email> <новый-пароль>
 *   npm run db:passwd -- owner@example.com 'новый-пароль'
 *
 * Требования к паролю те же, что в UI: 10–100 символов.
 * Сбрасывает session_version — все активные сессии сотрудника разлогиниваются.
 */

const MIN_LENGTH = 10;
const MAX_LENGTH = 100;

async function main() {
  const [emailArg, password] = process.argv.slice(2);
  if (!emailArg || !password) {
    console.error("Использование: npx tsx src/db/set-password.ts <email> <новый-пароль>");
    process.exit(1);
  }

  if (password.length < MIN_LENGTH || password.length > MAX_LENGTH) {
    console.error(`Пароль должен быть от ${MIN_LENGTH} до ${MAX_LENGTH} символов.`);
    process.exit(1);
  }

  const email = emailArg.trim().toLowerCase();
  const [user] = await db.select().from(staffUsers).where(eq(staffUsers.email, email)).limit(1);
  if (!user) {
    console.error(`Сотрудник с email «${email}» не найден.`);
    process.exit(1);
  }

  await db
    .update(staffUsers)
    .set({
      passwordHash: await hashPassword(password),
      sessionVersion: sql`${staffUsers.sessionVersion} + 1`,
      updatedAt: new Date(),
    })
    .where(eq(staffUsers.id, user.id));

  console.log(`Пароль обновлён: ${email} (${user.role}). Активные сессии сброшены.`);
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error("Не удалось обновить пароль:", err instanceof Error ? err.message : err);
    process.exit(1);
  },
);
