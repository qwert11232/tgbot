/**
 * Человеческие сообщения для сбоев входа в админку.
 *
 * Проблема: любое исключение в server action (`loginAction`) превращается в
 * страницу «This page couldn't load. A server error occurred.» — пользователь
 * видит только digest, а причина (короткий ADMIN_SESSION_SECRET, недоступная БД,
 * неприменённые миграции) остаётся в логах Vercel. Эти функции переводят
 * известные причины в конкретный текст и подсказку, что делать.
 *
 * Модуль чистый (без импортов Next/БД) — покрыт юнит-тестами.
 */

export interface ConfigIssue {
  code: string;
  message: string;
  hint: string;
}

export interface LoginFailure {
  code: string;
  message: string;
  hint: string;
}

const MIN_SECRET_LENGTH = 32;

type Env = Record<string, string | undefined>;

/** Проверка конфигурации до обращения к БД — даёт точное сообщение. */
export function checkAdminLoginConfig(env: Env, nodeEnv: string | null | undefined): ConfigIssue[] {
  const issues: ConfigIssue[] = [];

  if (!(env.DATABASE_URL ?? "").trim()) {
    issues.push({
      code: "database_url_missing",
      message: "Приложение не настроено: не задан адрес базы данных.",
      hint: "Добавьте DATABASE_URL в Environment Variables проекта (Vercel → Settings) и сделайте Redeploy — новые переменные применяются только после пересборки.",
    });
  }

  const secret = (env.ADMIN_SESSION_SECRET ?? "").trim();
  const isProd = nodeEnv === "production";
  if (!secret) {
    issues.push({
      code: "admin_session_secret_missing",
      message: isProd
        ? "Приложение не настроено: не задан секрет сессий админки."
        : "Не задан ADMIN_SESSION_SECRET — используется небезопасный dev-секрет.",
      hint: "Сгенерируйте строку минимум из 32 символов (например: openssl rand -hex 32), положите её в ADMIN_SESSION_SECRET и сделайте Redeploy.",
    });
  } else if (secret.length < MIN_SECRET_LENGTH) {
    issues.push({
      code: "admin_session_secret_too_short",
      message: `Секрет сессий админки короче ${MIN_SECRET_LENGTH} символов — вход невозможен.`,
      hint: `Сейчас в ADMIN_SESSION_SECRET ${secret.length} символов. Нужно минимум ${MIN_SECRET_LENGTH} (openssl rand -hex 32), затем Redeploy.`,
    });
  }

  return issues;
}

/** Достаёт коды/сообщения из вложенных ошибок (drizzle оборачивает причину в .cause). */
function collectErrorText(error: unknown, depth = 0): string {
  if (!error || depth > 4) return "";
  const parts: string[] = [];
  if (typeof error === "string") return error;
  if (error instanceof Error) {
    parts.push(`${(error as { code?: string }).code ?? ""} ${error.message} ${error.name}`);
    const cause = (error as { cause?: unknown }).cause;
    if (cause) parts.push(collectErrorText(cause, depth + 1));
  } else if (typeof error === "object") {
    const e = error as { code?: unknown; message?: unknown; cause?: unknown; detail?: unknown };
    parts.push(String(e.code ?? ""), String(e.message ?? ""), String(e.detail ?? ""));
    if (e.cause) parts.push(collectErrorText(e.cause, depth + 1));
  }
  return parts.join(" ");
}

const DB_UNREACHABLE = [
  "ECONNREFUSED",
  "ENOTFOUND",
  "EHOSTUNREACH",
  "ETIMEDOUT",
  "ENETUNREACH",
  "EAI_AGAIN",
  "getaddrinfo",
  "Connection terminated",
  "timeout expired",
  "terminating connection",
  "NeonDbError",
  "WebSocket",
  "fetch failed",
  "connect ECONN",
];

const DB_SCHEMA_MISSING = ["42P01", "42703", "does not exist", "undefined_table", "undefined_column"];

const DB_AUTH = ["28P01", "28000", "password authentication failed", "no pg_hba.conf entry"];

/**
 * Переводит ошибку входа в понятный текст. Всегда возвращает что-то осмысленное,
 * поэтому server action не падает страницей «This page couldn't load».
 */
export function describeLoginFailure(error: unknown): LoginFailure {
  const text = collectErrorText(error);

  if (DB_SCHEMA_MISSING.some((marker) => text.includes(marker))) {
    return {
      code: "db_schema_missing",
      message: "База данных подключена, но схема не создана.",
      hint: "Выполните миграции на эту базу: DATABASE_URL=<url> npx drizzle-kit migrate, затем npx tsx src/db/seed.ts (создаст владельца).",
    };
  }

  if (DB_AUTH.some((marker) => text.includes(marker))) {
    return {
      code: "db_auth_failed",
      message: "База данных отклонила подключение — неверные логин или пароль.",
      hint: "Проверьте DATABASE_URL (в строке должны быть пользователь, пароль и ?sslmode=require) и Redeploy.",
    };
  }

  if (DB_UNREACHABLE.some((marker) => text.includes(marker))) {
    return {
      code: "db_unreachable",
      message: "Нет связи с базой данных.",
      hint: "Проверьте, что DATABASE_URL указывает на существующую базу и что проект Neon не приостановлен. Откройте /api/health — там пошаговая диагностика.",
    };
  }

  return {
    code: "unknown",
    message: "Не удалось войти из-за ошибки на сервере.",
    hint: "Подробности — в логах функции на Vercel. Быстрая диагностика конфигурации и БД: /api/health.",
  };
}

/** Редирект в Next реализован через throw — его нельзя глотать в catch. */
export function isNextRedirect(error: unknown): boolean {
  const digest = (error as { digest?: unknown } | null)?.digest;
  return typeof digest === "string" && digest.startsWith("NEXT_REDIRECT");
}
