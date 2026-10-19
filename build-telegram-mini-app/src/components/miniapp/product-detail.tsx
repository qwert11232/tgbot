"use client";

import { useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Minus, Plus, ShoppingBag } from "lucide-react";
import { addToCart, getCart, setLineQty, useCart } from "@/components/miniapp/cart-store";
import { formatPrice } from "@/lib/format";

export interface ProductViewData {
  id: string;
  name: string;
  description: string;
  priceMinor: number;
  stock: number;
  category: { id: string; name: string; slug: string } | null;
}

export interface ProductImageView {
  id: string;
  url: string;
  isPrimary: boolean;
}

export function ProductView({ product, images }: { product: ProductViewData; images: ProductImageView[] }) {
  const router = useRouter();
  const { lines } = useCart();
  const galleryRef = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(0);

  const line = lines.find((l) => l.id === product.id);
  const qty = line?.qty ?? 0;
  const soldOut = product.stock <= 0;

  const sortedImages = useMemo(
    () => [...images].sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary)),
    [images],
  );

  const onScroll = () => {
    const el = galleryRef.current;
    if (!el) return;
    setActive(Math.round(el.scrollLeft / el.clientWidth));
  };

  return (
    <div className="pb-28">
      <div
        ref={galleryRef}
        onScroll={onScroll}
        className="no-scrollbar flex snap-x snap-mandatory overflow-x-auto"
      >
        {sortedImages.length === 0 && (
          <div className="flex aspect-square w-full shrink-0 items-center justify-center bg-cream text-mute">
            нет фото
          </div>
        )}
        {sortedImages.map((img) => (
          <div key={img.id} className="w-full shrink-0 snap-center">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={img.url} alt={product.name} className="aspect-square w-full bg-cream object-cover" />
          </div>
        ))}
      </div>
      {sortedImages.length > 1 && (
        <div className="mt-3 flex justify-center gap-1.5">
          {sortedImages.map((img, i) => (
            <span
              key={img.id}
              className={`h-1.5 rounded-full transition-all ${i === active ? "w-5 bg-clay" : "w-1.5 bg-line"}`}
            />
          ))}
        </div>
      )}

      <div className="px-4 pt-5">
        {product.category && (
          <p className="text-xs font-medium uppercase tracking-widest text-mute">{product.category.name}</p>
        )}
        <h1 className="font-display mt-1 text-2xl leading-tight text-ink">{product.name}</h1>
        <p className="mt-3 text-2xl font-semibold text-ink">{formatPrice(product.priceMinor)}</p>
        <p className={`mt-1 text-xs ${soldOut ? "text-clay-deep" : "text-sage"}`}>
          {soldOut ? "нет в наличии" : `в наличии: ${product.stock} шт.`}
        </p>
        <p className="mt-5 whitespace-pre-line text-[15px] leading-relaxed text-ink/80">{product.description}</p>
      </div>

      <div className="fixed inset-x-0 bottom-0 z-20 mx-auto w-full max-w-md border-t border-line/70 bg-paper/95 px-4 py-3 backdrop-blur">
        {soldOut ? (
          <button disabled className="w-full rounded-full bg-line py-3.5 text-sm font-semibold text-mute">
            Нет в наличии
          </button>
        ) : qty === 0 ? (
          <button
            onClick={() => addToCart(product.id, 1, product.stock)}
            className="flex w-full items-center justify-center gap-2 rounded-full bg-clay py-3.5 text-sm font-semibold text-white transition hover:bg-clay-deep"
          >
            <ShoppingBag size={17} /> В корзину · {formatPrice(product.priceMinor)}
          </button>
        ) : (
          <div className="flex items-center gap-3">
            <div className="flex items-center rounded-full border border-line">
              <button
                aria-label="Убавить"
                onClick={() => setLineQty(product.id, qty - 1, product.stock)}
                className="p-3 text-ink"
              >
                <Minus size={16} />
              </button>
              <span className="w-8 text-center text-sm font-semibold">{qty}</span>
              <button
                aria-label="Прибавить"
                onClick={() => setLineQty(product.id, qty + 1, product.stock)}
                disabled={qty >= product.stock}
                className="p-3 text-ink disabled:text-line"
              >
                <Plus size={16} />
              </button>
            </div>
            <button
              onClick={() => router.push("/app/cart")}
              className="flex-1 rounded-full bg-ink py-3.5 text-sm font-semibold text-paper"
            >
              Корзина · {qty} шт.
            </button>
          </div>
        )}
        <div className="mt-2 text-center">
          <Link href="/app" className="text-xs text-mute underline underline-offset-4">
            продолжить покупки
          </Link>
        </div>
      </div>
    </div>
  );
}
