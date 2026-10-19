"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Minus, Plus, Trash2 } from "lucide-react";
import { clearCart, setLineQty, useCart } from "@/components/miniapp/cart-store";
import { formatPrice } from "@/lib/format";

export interface ProductBrief {
  id: string;
  name: string;
  priceMinor: number;
  stock: number;
  imageUrl: string | null;
}

export function useCartDetails() {
  const { lines, count } = useCart();
  const [details, setDetails] = useState<ProductBrief[] | null>(null);
  const idsKey = useMemo(() => lines.map((l) => l.id).sort().join(","), [lines]);

  useEffect(() => {
    if (!idsKey) {
      setDetails([]);
      return;
    }
    let cancelled = false;
    fetch(`/api/catalog?ids=${idsKey}`)
      .then((r) => r.json())
      .then((d) => {
        if (!cancelled) setDetails(d.products ?? []);
      })
      .catch(() => {
        if (!cancelled) setDetails([]);
      });
    return () => {
      cancelled = true;
    };
  }, [idsKey]);

  const detailById = useMemo(() => new Map((details ?? []).map((d) => [d.id, d])), [details]);
  const total = lines.reduce((sum, l) => sum + (detailById.get(l.id)?.priceMinor ?? 0) * l.qty, 0);
  return { lines, count, details, detailById, total };
}

export default function CartPage() {
  const router = useRouter();
  const { lines, details, detailById, total } = useCartDetails();

  if (lines.length === 0) {
    return (
      <div className="flex flex-col items-center px-4 py-24 text-center">
        <p className="font-display text-2xl text-ink">Корзина пуста</p>
        <p className="mt-2 text-sm text-mute">Загляните в каталог — там живая глина.</p>
        <Link href="/app" className="mt-8 rounded-full bg-ink px-8 py-3 text-sm font-semibold text-paper">
          В каталог
        </Link>
      </div>
    );
  }

  return (
    <div className="pb-32">
      <h1 className="font-display px-4 pt-5 text-2xl text-ink">Корзина</h1>
      <div className="mt-4 space-y-3 px-4">
        {lines.map((line) => {
          const d = detailById.get(line.id);
          if (details !== null && !d) return null;
          return (
            <div key={line.id} className="card-shadow flex gap-3 rounded-2xl bg-white/70 p-3">
              <Link href={`/app/product/${line.id}`} className="shrink-0">
                {d?.imageUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={d.imageUrl} alt={d?.name ?? ""} className="h-20 w-20 rounded-xl bg-cream object-cover" />
                ) : (
                  <div className="h-20 w-20 rounded-xl bg-cream" />
                )}
              </Link>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-ink">{d?.name ?? "…"}</p>
                <p className="mt-0.5 text-sm font-semibold text-ink">
                  {d ? formatPrice(d.priceMinor * line.qty) : "…"}
                </p>
                <div className="mt-2 flex items-center justify-between">
                  <div className="flex items-center rounded-full border border-line">
                    <button
                      aria-label="Убавить"
                      onClick={() => setLineQty(line.id, line.qty - 1, d?.stock ?? 99)}
                      className="p-2 text-ink"
                    >
                      <Minus size={14} />
                    </button>
                    <span className="w-7 text-center text-xs font-bold">{line.qty}</span>
                    <button
                      aria-label="Прибавить"
                      onClick={() => setLineQty(line.id, line.qty + 1, d?.stock ?? 99)}
                      disabled={d ? line.qty >= d.stock : true}
                      className="p-2 text-ink disabled:text-line"
                    >
                      <Plus size={14} />
                    </button>
                  </div>
                  <button
                    aria-label="Удалить"
                    onClick={() => setLineQty(line.id, 0)}
                    className="p-2 text-mute transition hover:text-clay-deep"
                  >
                    <Trash2 size={16} />
                  </button>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      <div className="mt-5 flex items-center justify-between px-4">
        <span className="text-sm text-mute">Итого</span>
        <span className="text-xl font-semibold text-ink">{formatPrice(total)}</span>
      </div>
      <div className="px-4 pt-1">
        <button onClick={clearCart} className="text-xs text-mute underline underline-offset-4">
          очистить корзину
        </button>
      </div>

      <div className="fixed inset-x-0 bottom-0 z-20 mx-auto w-full max-w-md px-4 pb-4">
        <button
          onClick={() => router.push("/app/checkout")}
          className="w-full rounded-full bg-clay py-3.5 text-sm font-semibold text-white shadow-lg shadow-clay/30 transition hover:bg-clay-deep"
        >
          Оформить заказ · {formatPrice(total)}
        </button>
      </div>
    </div>
  );
}
