"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AlertCircle } from "lucide-react";
import { useCartDetails } from "@/components/miniapp/use-cart-details";
import { clearCart } from "@/components/miniapp/cart-store";
import { useTelegram } from "@/components/miniapp/telegram-provider";
import { formatPrice } from "@/lib/format";

const ORDER_KEY_STORAGE = "gorn_order_key";

/**
 * Оформление заказа. Ключ идемпотентности живёт в localStorage и переживает
 * перезагрузку/повторный сабмит: повтор с ТЕМ ЖЕ содержимым вернёт тот же
 * заказ, с ДРУГИМ — сервер ответит 409 idempotency_conflict, тогда ключ
 * перевыпускается (иначе покупатель не смог бы изменить заказ).
 *
 * Оплата: если окно Telegram не открылось или покупатель его закрыл, заказ
 * остаётся в «Мои заказы» с кнопкой «Оплатить» (POST /api/orders/[id]/invoice),
 * поэтому корзина очищается сразу после создания заказа — данные не теряются.
 */
export default function CheckoutPage() {
  const router = useRouter();
  const { lines, total, details, missingCount } = useCartDetails();
  const { apiFetch, token, ready, authError, user, tg } = useTelegram();

  const [nameInput, setNameInput] = useState<string | null>(null);
  const [phone, setPhone] = useState("");
  const [address, setAddress] = useState("");
  const [comment, setComment] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Имя из Telegram подставляем как значение по умолчанию (без setState в эффекте).
  const customerName = nameInput ?? user?.firstName ?? "";

  if (lines.length === 0) {
    return (
      <div className="flex flex-col items-center px-4 py-24 text-center">
        <p className="font-display text-2xl text-ink">Корзина пуста</p>
        <p className="mt-2 text-sm text-mute">
          {missingCount > 0 ? "Товары из корзины больше не продаются." : "Добавьте что-нибудь из каталога."}
        </p>
        <Link href="/app" className="mt-8 rounded-full bg-ink px-8 py-3 text-sm font-semibold text-paper">
          В каталог
        </Link>
      </div>
    );
  }

  const canSubmit =
    Boolean(token) && customerName.trim().length >= 2 && phone.trim().length >= 5 && !submitting && details !== null;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);

    let key = localStorage.getItem(ORDER_KEY_STORAGE);
    if (!key) {
      key = crypto.randomUUID();
      localStorage.setItem(ORDER_KEY_STORAGE, key);
    }

    try {
      const res = await apiFetch("/api/orders", {
        method: "POST",
        body: JSON.stringify({
          idempotencyKey: key,
          items: lines.map((l) => ({ productId: l.id, qty: l.qty })),
          customerName: customerName.trim(),
          phone: phone.trim(),
          address: address.trim(),
          comment: comment.trim(),
        }),
      });
      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        if (data?.code === "idempotency_conflict") {
          localStorage.removeItem(ORDER_KEY_STORAGE);
          setError("Состав заказа изменился с момента предыдущей попытки. Проверьте данные и отправьте ещё раз.");
        } else {
          setError(data?.error ?? "Не удалось создать заказ. Попробуйте ещё раз.");
        }
        setSubmitting(false);
        return;
      }

      localStorage.removeItem(ORDER_KEY_STORAGE);
      clearCart();

      const invoiceUrl: string | null = data.invoiceUrl ?? null;
      if (invoiceUrl && typeof tg?.openInvoice === "function") {
        tg.openInvoice(invoiceUrl, (status: string) => {
          router.replace(status === "paid" ? "/app/orders?paid=1" : "/app/orders?created=1");
        });
        return;
      }

      // Телеграм-клиент недоступен или оплата выключена — заказ сохранён,
      // оплатить его можно из «Мои заказы».
      router.replace("/app/orders?created=1");
    } catch {
      setError("Сеть недоступна. Попробуйте ещё раз.");
      setSubmitting(false);
    }
  }

  return (
    <div className="px-4 pb-32 pt-5">
      <h1 className="font-display text-2xl text-ink">Оформление</h1>

      {ready && !token && (
        <div className="mt-4 flex items-start gap-2 rounded-2xl border border-clay/40 bg-clay/10 p-3 text-xs leading-relaxed text-clay-deep">
          <AlertCircle size={16} className="mt-0.5 shrink-0" />
          <span>{authError ?? "Требуется авторизация Telegram."}</span>
        </div>
      )}

      {missingCount > 0 && (
        <div className="mt-4 flex items-start gap-2 rounded-2xl bg-cream/70 p-3 text-xs leading-relaxed text-mute">
          <AlertCircle size={16} className="mt-0.5 shrink-0" />
          <span>{missingCount} товар(ов) больше не продаётся и не попадёт в заказ.</span>
        </div>
      )}

      <form onSubmit={submit} className="mt-5 space-y-3">
        <Field label="Имя получателя" required>
          <input
            value={customerName}
            onChange={(e) => setNameInput(e.target.value)}
            required
            minLength={2}
            placeholder="Как к вам обращаться"
            className="w-full rounded-xl border border-line bg-white/70 px-4 py-3 text-sm outline-none focus:border-clay"
          />
        </Field>
        <Field label="Телефон" required>
          <input
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            required
            minLength={5}
            inputMode="tel"
            placeholder="+7 900 000-00-00"
            className="w-full rounded-xl border border-line bg-white/70 px-4 py-3 text-sm outline-none focus:border-clay"
          />
        </Field>
        <Field label="Адрес доставки">
          <input
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            placeholder="Город, улица, дом, квартира"
            className="w-full rounded-xl border border-line bg-white/70 px-4 py-3 text-sm outline-none focus:border-clay"
          />
        </Field>
        <Field label="Комментарий">
          <textarea
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            rows={2}
            placeholder="Пожелания к заказу"
            className="w-full resize-none rounded-xl border border-line bg-white/70 px-4 py-3 text-sm outline-none focus:border-clay"
          />
        </Field>

        {error && (
          <div className="flex items-start gap-2 rounded-2xl border border-clay/40 bg-clay/10 p-3 text-xs leading-relaxed text-clay-deep">
            <AlertCircle size={16} className="mt-0.5 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        <button type="submit" className="hidden" />
      </form>

      <div className="mt-5 rounded-2xl bg-cream/70 p-4 text-sm">
        <div className="flex justify-between text-mute">
          <span>Позиций</span>
          <span>{lines.reduce((s, l) => s + l.qty, 0)}</span>
        </div>
        <div className="mt-1 flex justify-between font-semibold text-ink">
          <span>Итого к оплате</span>
          <span>{formatPrice(total)}</span>
        </div>
        <p className="mt-3 text-[11px] leading-relaxed text-mute">
          Оплата — через Telegram Payments (Stars или картой). Если закроете окно оплаты, заказ останется в «Мои
          заказы» — оплатить его можно оттуда в течение часа.
        </p>
      </div>

      <div className="fixed inset-x-0 bottom-0 z-20 mx-auto w-full max-w-md px-4 pb-4">
        <button
          onClick={(e) => void submit(e)}
          disabled={!canSubmit}
          className="w-full rounded-full bg-clay py-3.5 text-sm font-semibold text-white shadow-lg shadow-clay/30 transition enabled:hover:bg-clay-deep disabled:opacity-40"
        >
          {submitting ? "Создаём заказ…" : `Подтвердить заказ · ${formatPrice(total)}`}
        </button>
      </div>
    </div>
  );
}

function Field({ label, required, children }: { label: string; required?: boolean; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-mute">
        {label} {required && <span className="text-clay">*</span>}
      </span>
      {children}
    </label>
  );
}
