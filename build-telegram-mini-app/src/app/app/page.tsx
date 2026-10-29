"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Plus, Search, ShoppingBag } from "lucide-react";
import { addToCart, useCart } from "@/components/miniapp/cart-store";
import { formatPrice } from "@/lib/format";

interface ProductBrief {
  id: string;
  name: string;
  description: string;
  priceMinor: number;
  stock: number;
  imageUrl: string | null;
}

interface CategoryBrief {
  id: string;
  name: string;
  slug: string;
}

export default function CatalogPage() {
  const router = useRouter();
  const [products, setProducts] = useState<ProductBrief[]>([]);
  const [categories, setCategories] = useState<CategoryBrief[]>([]);
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const [q, setQ] = useState("");
  const [category, setCategory] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const { count } = useCart();

  // Номер последнего запроса: ответ на устаревший (медленный) запрос не должен
  // перетирать результаты нового поиска (дефект P2-17).
  const requestRef = useRef(0);

  const load = useCallback(async (reset: boolean, offset: number, query: string, cat: string) => {
    const requestId = ++requestRef.current;
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (query) params.set("q", query);
      if (cat) params.set("category", cat);
      params.set("offset", String(offset));
      const res = await fetch(`/api/catalog?${params.toString()}`);
      if (requestId !== requestRef.current) return;
      if (!res.ok) throw new Error("Не удалось загрузить каталог");
      const data = await res.json();
      setCategories(data.categories ?? []);
      setNextOffset(data.nextOffset ?? null);
      setProducts((prev) => (reset ? (data.products ?? []) : [...prev, ...(data.products ?? [])]));
      setError(null);
    } catch (err) {
      if (requestId !== requestRef.current) return;
      setError(err instanceof Error ? err.message : "Не удалось загрузить каталог");
    } finally {
      if (requestId === requestRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const t = setTimeout(() => void load(true, 0, q, category), q ? 300 : 0);
    return () => clearTimeout(t);
  }, [q, category, load]);

  return (
    <div className="pb-24">
      <div className="px-4 pt-4">
        <label className="flex items-center gap-2 rounded-full border border-line bg-white/60 px-4 py-2.5">
          <Search size={16} className="text-mute" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Поиск по каталогу"
            className="w-full bg-transparent text-sm outline-none placeholder:text-mute"
          />
        </label>
      </div>

      <div className="no-scrollbar mt-3 flex gap-2 overflow-x-auto px-4 pb-1">
        <Chip active={category === ""} onClick={() => setCategory("")}>
          Все
        </Chip>
        {categories.map((c) => (
          <Chip key={c.id} active={category === c.slug} onClick={() => setCategory(c.slug)}>
            {c.name}
          </Chip>
        ))}
      </div>

      <div className="mt-4 grid grid-cols-2 gap-3 px-4">
        {products.map((p) => (
          <div key={p.id} className="card-shadow group overflow-hidden rounded-2xl bg-white/70">
            <Link href={`/app/product/${p.id}`} className="block">
              {p.imageUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={p.imageUrl} alt={p.name} className="aspect-square w-full bg-cream object-cover" />
              ) : (
                <div className="flex aspect-square w-full items-center justify-center bg-cream text-xs text-mute">
                  нет фото
                </div>
              )}
              <div className="px-3 pt-2.5 pb-1.5">
                <p className="line-clamp-2 text-[13px] font-medium leading-snug text-ink">{p.name}</p>
                <p className="mt-1.5 text-sm font-semibold text-ink">{formatPrice(p.priceMinor)}</p>
              </div>
            </Link>
            <div className="px-3 pb-3">
              <button
                disabled={p.stock <= 0}
                onClick={() => addToCart(p.id, 1, p.stock)}
                className="inline-flex w-full items-center justify-center gap-1 rounded-full bg-ink py-2 text-xs font-semibold text-paper transition enabled:hover:bg-clay disabled:opacity-40"
              >
                <Plus size={14} /> {p.stock <= 0 ? "Нет в наличии" : "В корзину"}
              </button>
            </div>
          </div>
        ))}
      </div>

      {error && !loading && (
        <p className="px-4 py-8 text-center text-sm text-clay-deep">
          {error}. <button onClick={() => void load(true, 0, q, category)} className="underline underline-offset-4">Повторить</button>
        </p>
      )}

      {loading && (
        <div className="mt-4 grid grid-cols-2 gap-3 px-4">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="animate-pulse overflow-hidden rounded-2xl bg-cream/70">
              <div className="aspect-square" />
              <div className="space-y-2 px-3 py-3">
                <div className="h-3 w-3/4 rounded bg-line/70" />
                <div className="h-3 w-1/2 rounded bg-line/70" />
              </div>
            </div>
          ))}
        </div>
      )}

      {!loading && products.length === 0 && (
        <p className="px-4 py-16 text-center text-sm text-mute">Ничего не нашлось. Попробуйте другой запрос.</p>
      )}

      {nextOffset !== null && !loading && (
        <div className="mt-6 px-4">
          <button
            onClick={() => void load(false, nextOffset, q, category)}
            className="w-full rounded-full border border-line py-3 text-sm font-semibold text-ink"
          >
            Показать ещё
          </button>
        </div>
      )}

      {count > 0 && (
        <div className="fixed inset-x-0 bottom-0 z-20 mx-auto w-full max-w-md px-4 pb-4">
          <button
            onClick={() => router.push("/app/cart")}
            className="flex w-full items-center justify-center gap-2 rounded-full bg-clay py-3.5 text-sm font-semibold text-white shadow-lg shadow-clay/30 transition hover:bg-clay-deep"
          >
            <ShoppingBag size={17} /> Корзина · {count} шт.
          </button>
        </div>
      )}
    </div>
  );
}

function Chip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`shrink-0 rounded-full px-4 py-2 text-xs font-semibold transition ${
        active ? "bg-ink text-paper" : "border border-line bg-white/60 text-ink hover:border-mute"
      }`}
    >
      {children}
    </button>
  );
}
