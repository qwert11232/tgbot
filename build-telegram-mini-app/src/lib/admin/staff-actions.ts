"use server";

import { revalidatePath } from "next/cache";
import { z, ZodError } from "zod";
import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { staffSessions, staffUsers, type StaffRole } from "@/db/schema";
import { getAdminActor, assertRole, type AdminActor } from "@/lib/admin-session";
import { ForbiddenError, HttpError } from "@/lib/http";
import { hashPassword } from "@/lib/passwords";

type ActionResult = { ok: true } | { ok: false; error: string };

function fail(err: unknown): { ok: false; error: string } {
  if (err instanceof ZodError) return { ok: false, error: err.issues[0]?.message ?? "Ошибка валидации" };
  if (err instanceof ForbiddenError || err instanceof HttpError) return { ok: false, error: err.message };
  if (err instanceof Error) {
    if (/unique|duplicate/i.test(err.message)) return { ok: false, error: "Такой email уже занят" };
    return { ok: false, error: err.message };
  }
  return { ok: false, error: "Неизвестная ошибка" };
}

/** Раздел «Сотрудники» — только owner (уровень 3: явная проверка роли в каждом action). */
async function requireOwner(): Promise<AdminActor> {
  const actor = await getAdminActor();
  if (!actor) throw new ForbiddenError("Требуется авторизация администратора");
  return assertRole(actor, "owner");
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Блокировка строк активных owner — защита «последнего владельца» от гонок. */
async function lockActiveOwners(tx: Tx) {
  return tx
    .select({ id: staffUsers.id })
    .from(staffUsers)
    .where(and(eq(staffUsers.role, "owner"), eq(staffUsers.isActive, true)))
    .for("update");
}

async function revokeSessions(tx: Tx, userId: string) {
  await tx
    .update(staffSessions)
    .set({ revokedAt: new Date() })
    .where(and(eq(staffSessions.userId, userId), isNull(staffSessions.revokedAt)));
}

const createStaffSchema = z.object({
  email: z.email("Некорректный email").max(200),
  name: z.string().trim().min(2, "Имя минимум 2 символа").max(120),
  password: z.string().min(10, "Пароль минимум 10 символов").max(100),
  role: z.enum(["owner", "manager"]),
});

export async function createStaffAction(input: unknown): Promise<ActionResult> {
  try {
    await requireOwner();
    const data = createStaffSchema.parse(input);
    const passwordHash = await hashPassword(data.password);
    await db.insert(staffUsers).values({
      email: data.email,
      name: data.name,
      passwordHash,
      role: data.role,
    });
    revalidatePath("/admin/staff");
    return { ok: true };
  } catch (err) {
    return fail(err);
  }
}

export async function changeStaffRoleAction(targetId: string, role: StaffRole): Promise<ActionResult> {
  try {
    const actor = await requireOwner();
    if (!z.uuid().safeParse(targetId).success) throw new HttpError(400, "Некорректный id");
    if (!z.enum(["owner", "manager"]).safeParse(role).success) throw new HttpError(400, "Некорректная роль");
    if (targetId === actor.id) throw new HttpError(409, "Нельзя изменить роль самому себе");

    await db.transaction(async (tx) => {
      const [target] = await tx.select().from(staffUsers).where(eq(staffUsers.id, targetId)).for("update").limit(1);
      if (!target) throw new HttpError(404, "Сотрудник не найден");

      if (target.role === "owner" && role === "manager") {
        const owners = await lockActiveOwners(tx);
        if (owners.length <= 1) throw new HttpError(409, "Нельзя понизить единственного владельца");
      }
      await tx
        .update(staffUsers)
        .set({ role, sessionVersion: sql`${staffUsers.sessionVersion} + 1`, updatedAt: new Date() })
        .where(eq(staffUsers.id, targetId));
      await revokeSessions(tx, targetId);
    });

    revalidatePath("/admin/staff");
    return { ok: true };
  } catch (err) {
    return fail(err);
  }
}

export async function setStaffActiveAction(targetId: string, isActive: boolean): Promise<ActionResult> {
  try {
    const actor = await requireOwner();
    if (!z.uuid().safeParse(targetId).success) throw new HttpError(400, "Некорректный id");
    if (targetId === actor.id && !isActive) throw new HttpError(409, "Нельзя деактивировать самого себя");

    await db.transaction(async (tx) => {
      const [target] = await tx.select().from(staffUsers).where(eq(staffUsers.id, targetId)).for("update").limit(1);
      if (!target) throw new HttpError(404, "Сотрудник не найден");

      if (!isActive && target.role === "owner") {
        const owners = await lockActiveOwners(tx);
        if (owners.length <= 1) throw new HttpError(409, "Нельзя деактивировать единственного владельца");
      }
      await tx
        .update(staffUsers)
        .set({ isActive, sessionVersion: sql`${staffUsers.sessionVersion} + 1`, updatedAt: new Date() })
        .where(eq(staffUsers.id, targetId));
      if (!isActive) await revokeSessions(tx, targetId);
    });

    revalidatePath("/admin/staff");
    return { ok: true };
  } catch (err) {
    return fail(err);
  }
}

export async function deleteStaffAction(targetId: string): Promise<ActionResult> {
  try {
    const actor = await requireOwner();
    if (!z.uuid().safeParse(targetId).success) throw new HttpError(400, "Некорректный id");
    if (targetId === actor.id) throw new HttpError(409, "Нельзя удалить самого себя");

    await db.transaction(async (tx) => {
      const [target] = await tx.select().from(staffUsers).where(eq(staffUsers.id, targetId)).for("update").limit(1);
      if (!target) return;

      if (target.role === "owner") {
        const owners = await lockActiveOwners(tx);
        if (owners.length <= 1) throw new HttpError(409, "Нельзя удалить единственного владельца");
      }
      await tx.delete(staffUsers).where(eq(staffUsers.id, targetId)); // сессии удаляются каскадом
    });

    revalidatePath("/admin/staff");
    return { ok: true };
  } catch (err) {
    return fail(err);
  }
}

export async function resetStaffPasswordAction(targetId: string, newPassword: string): Promise<ActionResult> {
  try {
    await requireOwner();
    if (!z.uuid().safeParse(targetId).success) throw new HttpError(400, "Некорректный id");
    const pw = z.string().min(10, "Пароль минимум 10 символов").max(100).parse(newPassword);
    const passwordHash = await hashPassword(pw);

    await db.transaction(async (tx) => {
      await tx
        .update(staffUsers)
        .set({ passwordHash, sessionVersion: sql`${staffUsers.sessionVersion} + 1`, updatedAt: new Date() })
        .where(eq(staffUsers.id, targetId));
      await revokeSessions(tx, targetId);
    });

    revalidatePath("/admin/staff");
    return { ok: true };
  } catch (err) {
    return fail(err);
  }
}
