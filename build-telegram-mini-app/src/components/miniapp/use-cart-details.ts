"use client";

import { useEffect, useMemo, useState } from "react";
import { useCart } from "@/components/miniapp/cart-store";

export interface CartProduct {
  id: string;
  name: string;
  priceMinor: number;
  stock: number;
  imageUrl: string | null;
}

/**
 * Детали корзины: подтягивает актуальные цены/остатки по id из localStorage.
 *
 * Вынесено из `app/cart/page.tsx` (раньше checkout импортировал хук прямо из
 * страницы — вместе со всей страницей в бандл).
 * Строки, которых больше нет в каталоге (товар удалён/снят с продажи),
 * отбрасываются, чтобы не получить 409 «товар не найден» на checkout (P2-18).
 */
export function useCartDetails() {
  const { lines, count } = useCart();
  const [fetched, setFetched] = useState<CartProduct[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const idsKey = useMemo(() => lines.map((l) => l.id).sort().join(","), [lines]);

  useEffect(() => {
    if (!idsKey) return;
    const controller = new AbortController();
    fetch(`/api/catalog?ids=${encodeURIComponent(idsKey)}`, { signal: controller.signal })
      .then((r) => r.json())
      .then((d) => {
        setFetched((d.products ?? []) as CartProduct[]);
        setError(null);
      })
      .catch((err) => {
        if (controller.signal.aborted) return;
        setFetched([]);
        setError(err instanceof Error ? err.message : "Не удалось загрузить корзину");
      });
    return () => controller.abort();
  }, [idsKey]);

  // Без товаров в корзине детали не нужны — состояние не трогаем в эффекте.
  const details = useMemo(() => (idsKey ? fetched : []), [idsKey, fetched]);

  const detailById = useMemo(() => new Map((details ?? []).map((d) => [d.id, d])), [details]);

  // В заказ уходят только строки, которые есть в каталоге, и не больше остатка.
  const availableLines = useMemo(
    () =>
      details === null
        ? lines
        : lines
            .filter((l) => detailById.has(l.id))
            .map((l) => ({ ...l, qty: Math.min(l.qty, Math.max(1, detailById.get(l.id)!.stock)) })),
    [lines, details, detailById],
  );

  const missingCount = details === null ? 0 : lines.filter((l) => !detailById.has(l.id)).length;
  const total = availableLines.reduce((sum, l) => sum + (detailById.get(l.id)?.priceMinor ?? 0) * l.qty, 0);

  return { lines: availableLines, rawLines: lines, count, details, detailById, total, missingCount, error };
}
