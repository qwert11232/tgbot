"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Save, Trash2 } from "lucide-react";
import { createProductAction, deleteProductAction, updateProductAction } from "@/lib/admin/product-actions";

interface CategoryOpt {
  id: string;
  name: string;
}

interface InitialData {
  name: string;
  description: string;
  categoryId: string | null;
  priceMinor: number;
  stock: number;
  isActive: boolean;
}

export function ProductForm({
  mode,
  productId,
  categories,
  initial,
}: {
  mode: "create" | "edit";
  productId?: string;
  categories: CategoryOpt[];
  initial?: InitialData;
}) {
  const router = useRouter();
  const [name, setName] = useState(initial?.name ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [categoryId, setCategoryId] = useState(initial?.categoryId ?? "");
  const [priceRub, setPriceRub] = useState(
    initial ? String(initial.priceMinor / 100).replace(".", ",") : "",
  );
  const [stock, setStock] = useState(String(initial?.stock ?? 0));
  const [isActive, setIsActive] = useState(initial?.isActive ?? true);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setPending(true);
    setError(null);
    const input = {
      name,
      description,
      categoryId: categoryId || null,
      priceRub,
      stock: Number(stock || 0),
      isActive,
    };
    if (mode === "create") {
      const res = await createProductAction(input);
      setPending(false);
      if (!res.ok) {
        setError(res.error);
        return;
      }
      router.push(`/admin/products/${res.data.id}`);
    } else {
      const res = await updateProductAction(productId!, input);
      setPending(false);
      if (!res.ok) {
        setError(res.error);
        return;
      }
      router.push("/admin/products");
      router.refresh();
    }
  }

  return (
    <form onSubmit={onSubmit} className="card-shadow space-y-4 rounded-2xl bg-white/70 p-6">
      <label className="block">
        <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-mute">Название *</span>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
          minLength={2}
          maxLength={220}
          className="w-full rounded-xl border border-line bg-white px-4 py-2.5 text-sm outline-none focus:border-clay"
        />
      </label>

      <label className="block">
        <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-mute">Описание</span>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={4}
          maxLength={5000}
          className="w-full resize-y rounded-xl border border-line bg-white px-4 py-2.5 text-sm outline-none focus:border-clay"
        />
      </label>

      <div className="grid gap-4 sm:grid-cols-3">
        <label className="block">
          <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-mute">
            Цена, ₽ *
          </span>
          <input
            value={priceRub}
            onChange={(e) => setPriceRub(e.target.value)}
            required
            inputMode="decimal"
            placeholder="1 890"
            className="w-full rounded-xl border border-line bg-white px-4 py-2.5 text-sm outline-none focus:border-clay"
          />
        </label>
        <label className="block">
          <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-mute">
            Остаток, шт. *
          </span>
          <input
            value={stock}
            onChange={(e) => setStock(e.target.value.replace(/[^0-9]/g, ""))}
            required
            inputMode="numeric"
            className="w-full rounded-xl border border-line bg-white px-4 py-2.5 text-sm outline-none focus:border-clay"
          />
        </label>
        <label className="block">
          <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-mute">Категория</span>
          <select
            value={categoryId ?? ""}
            onChange={(e) => setCategoryId(e.target.value)}
            className="w-full rounded-xl border border-line bg-white px-4 py-2.5 text-sm outline-none focus:border-clay"
          >
            <option value="">Без категории</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
      </div>

      <label className="flex items-center gap-2.5 text-sm text-ink">
        <input
          type="checkbox"
          checked={isActive}
          onChange={(e) => setIsActive(e.target.checked)}
          className="h-4 w-4 accent-[#c06840]"
        />
        Товар активен (виден в магазине)
      </label>

      {error && (
        <p className="rounded-xl bg-clay/10 px-4 py-2.5 text-xs font-medium text-clay-deep">{error}</p>
      )}

      <button
        type="submit"
        disabled={pending}
        className="inline-flex items-center gap-2 rounded-full bg-clay px-6 py-2.5 text-sm font-semibold text-white transition hover:bg-clay-deep disabled:opacity-50"
      >
        <Save size={16} /> {pending ? "Сохраняем…" : mode === "create" ? "Создать товар" : "Сохранить"}
      </button>
    </form>
  );
}

export function DeleteProductButton({ productId }: { productId: string }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onDelete() {
    if (!window.confirm("Удалить товар безвозвратно? Галерея и файлы будут удалены.")) return;
    setPending(true);
    setError(null);
    const res = await deleteProductAction(productId);
    setPending(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    router.push("/admin/products");
    router.refresh();
  }

  return (
    <span className="inline-flex items-center gap-2">
      {error && <span className="text-xs text-clay-deep">{error}</span>}
      <button
        onClick={onDelete}
        disabled={pending}
        className="inline-flex items-center gap-1.5 rounded-full border border-clay/40 px-4 py-2 text-xs font-semibold text-clay-deep transition hover:bg-clay/10 disabled:opacity-50"
      >
        <Trash2 size={14} /> {pending ? "Удаляем…" : "Удалить товар"}
      </button>
    </span>
  );
}
