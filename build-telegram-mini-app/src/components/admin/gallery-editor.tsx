"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, ArrowRight, Loader2, Star, Trash2, Upload } from "lucide-react";
import {
  attachProductImageAction,
  moveProductImageAction,
  removeProductImageAction,
  setPrimaryImageAction,
} from "@/lib/admin/product-actions";

interface GalleryImage {
  id: string;
  url: string;
  sortOrder: number;
  isPrimary: boolean;
}

export function GalleryEditor({ productId, images }: { productId: string; images: GalleryImage[] }) {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function onFiles(files: FileList | null) {
    if (!files?.length) return;
    setUploading(true);
    setError(null);
    try {
      for (const file of Array.from(files)) {
        const fd = new FormData();
        fd.set("file", file);
        // Загрузка файла: проверка размера и magic bytes — на сервере (/api/admin/upload).
        const res = await fetch("/api/admin/upload", { method: "POST", body: fd });
        const data = (await res.json().catch(() => ({}))) as { url?: string; error?: string };
        if (!res.ok || !data.url) throw new Error(data.error ?? `Не удалось загрузить «${file.name}»`);
        const attached = await attachProductImageAction(productId, data.url);
        if (!attached.ok) throw new Error(attached.error);
      }
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Ошибка загрузки");
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  async function run(imageId: string, action: Promise<{ ok: boolean; error?: string }>) {
    setBusyId(imageId);
    setError(null);
    const res = await action;
    setBusyId(null);
    if (!res.ok) setError(res.error ?? "Ошибка");
    else router.refresh();
  }

  return (
    <div>
      <div className="grid grid-cols-2 gap-3">
        {images.map((img, idx) => (
          <div
            key={img.id}
            className={`card-shadow group relative overflow-hidden rounded-xl bg-white/70 ${
              img.isPrimary ? "ring-2 ring-clay" : ""
            }`}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={img.url} alt="" className="aspect-square w-full bg-cream object-cover" />
            {img.isPrimary && (
              <span className="absolute left-2 top-2 inline-flex items-center gap-1 rounded-full bg-clay px-2 py-0.5 text-[10px] font-bold text-white">
                <Star size={10} /> главное
              </span>
            )}
            <div className="absolute inset-x-0 bottom-0 flex justify-between bg-gradient-to-t from-ink/70 to-transparent p-2 opacity-0 transition group-hover:opacity-100">
              <div className="flex gap-1">
                <IconBtn
                  label="Раньше"
                  disabled={idx === 0 || busyId === img.id}
                  onClick={() => void run(img.id, moveProductImageAction(img.id, "up"))}
                >
                  <ArrowLeft size={13} />
                </IconBtn>
                <IconBtn
                  label="Позже"
                  disabled={idx === images.length - 1 || busyId === img.id}
                  onClick={() => void run(img.id, moveProductImageAction(img.id, "down"))}
                >
                  <ArrowRight size={13} />
                </IconBtn>
                {!img.isPrimary && (
                  <IconBtn
                    label="Сделать главным"
                    disabled={busyId === img.id}
                    onClick={() => void run(img.id, setPrimaryImageAction(img.id))}
                  >
                    <Star size={13} />
                  </IconBtn>
                )}
              </div>
              <IconBtn
                label="Удалить"
                danger
                disabled={busyId === img.id}
                onClick={() => {
                  if (window.confirm("Удалить фото?")) void run(img.id, removeProductImageAction(img.id));
                }}
              >
                <Trash2 size={13} />
              </IconBtn>
            </div>
          </div>
        ))}

        <button
          onClick={() => fileRef.current?.click()}
          disabled={uploading}
          className="flex aspect-square flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-line text-mute transition hover:border-clay hover:text-clay-deep disabled:opacity-50"
        >
          {uploading ? <Loader2 size={20} className="animate-spin" /> : <Upload size={20} />}
          <span className="text-xs font-semibold">{uploading ? "Загружаем…" : "Добавить фото"}</span>
        </button>
      </div>

      <input
        ref={fileRef}
        type="file"
        accept="image/jpeg,image/png,image/webp,image/gif"
        multiple
        hidden
        onChange={(e) => void onFiles(e.target.files)}
      />

      {error && <p className="mt-3 rounded-xl bg-clay/10 px-3.5 py-2.5 text-xs font-medium text-clay-deep">{error}</p>}
    </div>
  );
}

function IconBtn({
  children,
  onClick,
  disabled,
  label,
  danger,
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  label: string;
  danger?: boolean;
}) {
  return (
    <button
      aria-label={label}
      title={label}
      onClick={onClick}
      disabled={disabled}
      className={`rounded-full p-1.5 text-white transition disabled:opacity-30 ${
        danger ? "bg-clay-deep/80 hover:bg-clay-deep" : "bg-ink/60 hover:bg-ink"
      }`}
    >
      {children}
    </button>
  );
}
