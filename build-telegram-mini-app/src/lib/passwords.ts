import bcrypt from "bcryptjs";

const BCRYPT_ROUNDS = 12;

/** Заранее посчитанный хэш для выравнивания времени ответа при несуществующем email. */
let dummyHash: string | null = null;

export function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, BCRYPT_ROUNDS);
}

export function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

/** Сравнение с фиктивным хэшом, если пользователь не найден — защита от user-enumeration по таймингу. */
export async function verifyPasswordOrDummy(password: string, hash: string | null): Promise<boolean> {
  if (!dummyHash) dummyHash = await bcrypt.hash("timing-equalizer", BCRYPT_ROUNDS);
  return bcrypt.compare(password, hash ?? dummyHash);
}
