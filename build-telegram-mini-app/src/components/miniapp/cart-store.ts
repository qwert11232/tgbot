"use client";

import { useEffect, useState } from "react";

export interface CartLine {
  id: string;
  qty: number;
}

const KEY = "gorn_cart_v1";
const EVENT = "gorn-cart-changed";

export function getCart(): CartLine[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "[]") as CartLine[];
    return Array.isArray(raw) ? raw.filter((l) => typeof l?.id === "string" && l.qty > 0) : [];
  } catch {
    return [];
  }
}

export function setCart(lines: CartLine[]): void {
  localStorage.setItem(KEY, JSON.stringify(lines));
  window.dispatchEvent(new Event(EVENT));
}

export function addToCart(id: string, qty = 1, maxStock = 99): void {
  // Товар без остатка в корзину не попадает: раньше Math.max(1, 0) добавлял 1 шт.
  if (maxStock <= 0) return;
  const limit = Math.max(1, maxStock);
  const lines = getCart();
  const existing = lines.find((l) => l.id === id);
  if (existing) existing.qty = Math.min(limit, existing.qty + qty);
  else lines.push({ id, qty: Math.min(qty, limit) });
  setCart(lines);
}

export function setLineQty(id: string, qty: number, maxStock = 99): void {
  let lines = getCart();
  if (qty <= 0 || maxStock <= 0) lines = lines.filter((l) => l.id !== id);
  else lines = lines.map((l) => (l.id === id ? { ...l, qty: Math.min(Math.max(1, maxStock), qty) } : l));
  setCart(lines);
}

export function clearCart(): void {
  setCart([]);
}

export function useCart() {
  const [lines, setLines] = useState<CartLine[]>([]);

  useEffect(() => {
    const sync = () => setLines(getCart());
    sync();
    window.addEventListener(EVENT, sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener(EVENT, sync);
      window.removeEventListener("storage", sync);
    };
  }, []);

  const count = lines.reduce((sum, l) => sum + l.qty, 0);
  return { lines, count };
}
