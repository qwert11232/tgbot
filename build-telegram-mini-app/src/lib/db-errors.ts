/**
 * Преобразование ошибок БД/инфраструктуры в безопасные сообщения для UI.
 *
 * ВАЖНО: drizzle оборачивает ошибку драйвера в DrizzleQueryError — исходный
 * Postgres-код и constraint лежат в `err.cause`, а в `err.message` остаётся
 * весь SQL-запрос вместе с параметрами (включая bcrypt-хеши). Отдавать
 * `err.message` в браузер нельзя (см. TEST-REPORT.md, дефект P0-6).
 */

interface PgLikeError {
  code?: string;
  constraint?: string;
  detail?: string;
  message?: string;
  cause?: unknown;
}

const UNIQUE_FALLBACK = /duplicate key value violates unique constraint|unique violation|already exists/i;
const FK_FALLBACK = /violates foreign key constraint|foreign key violation/i;
const CHECK_FALLBACK = /violates check constraint/i;

function asPgError(err: unknown): PgLikeError | null {
  if (!err || typeof err !== "object") return null;
  return err as PgLikeError;
}

/** Ищет постгресовый код (SQLSTATE) в ошибке и её цепочке `cause`. */
export function pgErrorInfo(err: unknown): { code?: string; constraint?: string; message: string } {
  const messages: string[] = [];
  let current: unknown = err;
  for (let depth = 0; depth < 5 && current; depth++) {
    const e = asPgError(current);
    if (!e) break;
    if (typeof e.message === "string") messages.push(e.message);
    if (e.code || e.constraint) {
      return { code: e.code, constraint: e.constraint, message: messages.join(" | ") };
    }
    current = e.cause;
  }
  return { message: messages.join(" | ") };
}

export function isUniqueViolation(err: unknown): boolean {
  const { code, message } = pgErrorInfo(err);
  return code === "23505" || UNIQUE_FALLBACK.test(message);
}

export function isForeignKeyViolation(err: unknown): boolean {
  const { code, message } = pgErrorInfo(err);
  return code === "23503" || FK_FALLBACK.test(message);
}

const CONSTRAINT_MESSAGES: Record<string, string> = {
  staff_users_email_uq: "Сотрудник с таким email уже существует",
  categories_slug_uq: "Категория с таким адресом уже существует",
  products_slug_uq: "Товар с таким адресом уже существует",
  orders_number_uq: "Конфликт номера заказа, попробуйте ещё раз",
  payment_events_provider_event_uq: "Платёжное событие уже обработано",
  tg_users_telegram_id_uq: "Пользователь Telegram уже зарегистрирован",
  products_category_id_categories_id_fk: "Выбранная категория не найдена",
  order_items_product_id_products_id_fk: "Товар из заказа больше не существует",
  payment_events_order_id_orders_id_fk: "Заказ не найден",
  orders_user_id_tg_users_id_fk: "Пользователь не найден",
  idempotency_keys_order_id_orders_id_fk: "Заказ не найден",
  staff_sessions_user_id_staff_users_id_fk: "Сотрудник не найден",
};

/**
 * Возвращает сообщение, которое можно показать пользователю.
 * Никогда не содержит SQL, параметров запроса и хешей.
 */
export function userFacingDbError(err: unknown, fallback = "Не удалось выполнить операцию. Попробуйте ещё раз"): string {
  const { code, constraint, message } = pgErrorInfo(err);

  if (constraint && CONSTRAINT_MESSAGES[constraint]) return CONSTRAINT_MESSAGES[constraint];

  switch (code) {
    case "23505":
      return "Такая запись уже существует";
    case "23503":
      return "Связанная запись не найдена или уже удалена";
    case "23502":
      return "Не заполнено обязательное поле";
    case "23514":
      return "Данные не проходят проверку ограничений";
    case "22001":
      return "Слишком длинное значение";
    case "22P02":
      return "Некорректный формат данных";
    case "40001":
    case "40P01":
      return "Конфликт параллельных изменений. Повторите операцию";
    default:
      break;
  }

  if (isUniqueViolation(err)) return "Такая запись уже существует";
  if (isForeignKeyViolation(err)) return "Связанная запись не найдена или уже удалена";
  if (CHECK_FALLBACK.test(message)) return "Данные не проходят проверку ограничений";

  // Ошибки, которые поднимает сам код (валидация цен, бизнес-правила) — безопасны.
  if (err instanceof Error && !looksLikeDbError(err.message)) return err.message;

  return fallback;
}

const DB_MESSAGE_MARKERS = [
  "failed query",
  "insert into",
  "update ",
  "delete from",
  "select ",
  "params:",
  "constraint",
  "syntax error",
  "relation ",
  "column ",
  "password_hash",
];

function looksLikeDbError(message: string): boolean {
  const lower = message.toLowerCase();
  return DB_MESSAGE_MARKERS.some((m) => lower.includes(m));
}

/** Логирует полную ошибку на сервере, возвращает безопасный текст. */
export function logAndSanitize(err: unknown, context: string, fallback?: string): string {
  console.error(`[${context}]`, err);
  return userFacingDbError(err, fallback);
}
