"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { KeyRound, Trash2, UserPlus, UserX, UserCheck } from "lucide-react";
import type { StaffRole } from "@/db/schema";
import {
  changeStaffRoleAction,
  createStaffAction,
  deleteStaffAction,
  resetStaffPasswordAction,
  setStaffActiveAction,
} from "@/lib/admin/staff-actions";

interface StaffRow {
  id: string;
  email: string;
  name: string;
  role: StaffRole;
  isActive: boolean;
  createdAt: string;
}

type Result = { ok: boolean; error?: string };

export function StaffManager({ staff, currentUserId }: { staff: StaffRow[]; currentUserId: string }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);

  async function run(action: Promise<Result>) {
    setError(null);
    const res = await action;
    if (!res.ok) setError(res.error ?? "Ошибка");
    else router.refresh();
  }

  return (
    <div className="space-y-6">
      <CreateStaffForm onResult={run} />

      {error && (
        <p className="rounded-xl bg-clay/10 px-4 py-2.5 text-xs font-medium text-clay-deep">{error}</p>
      )}

      <div className="card-shadow overflow-hidden rounded-2xl bg-white/70">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-line text-left text-xs text-mute">
              <th className="px-5 py-3 font-medium">Сотрудник</th>
              <th className="px-5 py-3 font-medium">Роль</th>
              <th className="hidden px-5 py-3 font-medium sm:table-cell">Статус</th>
              <th className="px-5 py-3 text-right font-medium">Действия</th>
            </tr>
          </thead>
          <tbody>
            {staff.map((s) => {
              const isSelf = s.id === currentUserId;
              return (
                <tr key={s.id} className="border-b border-line/60 last:border-0">
                  <td className="px-5 py-3">
                    <p className="font-medium text-ink">
                      {s.name} {isSelf && <span className="text-xs text-mute">(это вы)</span>}
                    </p>
                    <p className="text-xs text-mute">{s.email}</p>
                  </td>
                  <td className="px-5 py-3">
                    <select
                      value={s.role}
                      disabled={isSelf}
                      onChange={(e) => void run(changeStaffRoleAction(s.id, e.target.value as StaffRole))}
                      className="rounded-lg border border-line bg-white px-2.5 py-1.5 text-xs font-semibold disabled:opacity-50"
                    >
                      <option value="owner">owner</option>
                      <option value="manager">manager</option>
                    </select>
                  </td>
                  <td className="hidden px-5 py-3 sm:table-cell">
                    <span
                      className={`rounded-full px-2.5 py-1 text-[11px] font-semibold ${
                        s.isActive ? "bg-emerald-100 text-emerald-800" : "bg-stone-200 text-stone-500"
                      }`}
                    >
                      {s.isActive ? "активен" : "выключен"}
                    </span>
                  </td>
                  <td className="px-5 py-3">
                    <div className="flex justify-end gap-1.5">
                      <button
                        title="Сбросить пароль"
                        onClick={() => {
                          const pw = window.prompt("Новый пароль (минимум 10 символов):");
                          if (pw) void run(resetStaffPasswordAction(s.id, pw));
                        }}
                        className="rounded-full p-2 text-mute transition hover:bg-cream hover:text-ink"
                      >
                        <KeyRound size={15} />
                      </button>
                      {!isSelf && (
                        <>
                          <button
                            title={s.isActive ? "Деактивировать" : "Активировать"}
                            onClick={() => void run(setStaffActiveAction(s.id, !s.isActive))}
                            className="rounded-full p-2 text-mute transition hover:bg-cream hover:text-ink"
                          >
                            {s.isActive ? <UserX size={15} /> : <UserCheck size={15} />}
                          </button>
                          <button
                            title="Удалить"
                            onClick={() => {
                              if (window.confirm(`Удалить сотрудника ${s.email}?`)) void run(deleteStaffAction(s.id));
                            }}
                            className="rounded-full p-2 text-mute transition hover:bg-clay/10 hover:text-clay-deep"
                          >
                            <Trash2 size={15} />
                          </button>
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function CreateStaffForm({ onResult }: { onResult: (a: Promise<Result>) => Promise<void> }) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<StaffRole>("manager");
  const [pending, setPending] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setPending(true);
    setLocalError(null);
    const res = await createStaffAction({ email, name, password, role });
    setPending(false);
    if (!res.ok) {
      setLocalError(res.error);
      return;
    }
    setEmail("");
    setName("");
    setPassword("");
    setRole("manager");
    router.refresh();
  }

  return (
    <form onSubmit={onSubmit} className="card-shadow rounded-2xl bg-white/70 p-5">
      <h2 className="inline-flex items-center gap-2 text-xs font-bold uppercase tracking-wide text-mute">
        <UserPlus size={14} /> Добавить сотрудника
      </h2>
      <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
          minLength={2}
          placeholder="Имя"
          className="rounded-xl border border-line bg-white px-3.5 py-2.5 text-sm outline-none focus:border-clay"
        />
        <input
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
          type="email"
          placeholder="Email"
          className="rounded-xl border border-line bg-white px-3.5 py-2.5 text-sm outline-none focus:border-clay"
        />
        <input
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
          minLength={10}
          type="password"
          placeholder="Пароль (от 10 символов)"
          autoComplete="new-password"
          className="rounded-xl border border-line bg-white px-3.5 py-2.5 text-sm outline-none focus:border-clay"
        />
        <div className="flex gap-2">
          <select
            value={role}
            onChange={(e) => setRole(e.target.value as StaffRole)}
            className="flex-1 rounded-xl border border-line bg-white px-3.5 py-2.5 text-sm"
          >
            <option value="manager">manager</option>
            <option value="owner">owner</option>
          </select>
          <button
            type="submit"
            disabled={pending}
            className="rounded-xl bg-clay px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-clay-deep disabled:opacity-50"
          >
            {pending ? "…" : "Создать"}
          </button>
        </div>
      </div>
      {localError && <p className="mt-3 text-xs font-medium text-clay-deep">{localError}</p>}
    </form>
  );
}
