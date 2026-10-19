import Link from "next/link";
import { and, desc, eq, ilike, inArray, sql, type SQL } from "drizzle-orm";
import { db } from "@/db";
import { categories, productImages, products } from "@/db/schema";
import { requireAdmin } from "@/lib/admin-session";
import { formatPrice } from "@/lib/format";
import { Plus, Search } from "lucide-react";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 20;

export default async function AdminProductsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; page?: string; active?: string }>;
}) {
  await requireAdmin(); // уровень 3: проверка на каждой странице
  const sp = await searchParams;
  const q = (sp.q ?? "").trim().slice(0, 80);
  const page = Math.max(1, Number(sp.page) || 1);

  const conditions: SQL[] = [];
  if (q) conditions.push(ilike(products.name, `%${q}%`));
  if (sp.active === "1") conditions.push(eq(products.isActive, true));
  if (sp.active === "0") conditions.push(eq(products.isActive, false));
  const where = conditions.length ? and(...conditions) : undefined;

  const countRows = await db.select({ count: sql<string>`count(*)` }).from(products).where(where);
  const total = Number(countRows[0]?.count ?? 0);

  const rows = await db
    .select()
    .from(products)
    .where(where)
    .orderBy(desc(products.createdAt))
    .limit(PAGE_SIZE)
    .offset((page - 1) * PAGE_SIZE);

  const ids = rows.map((p) => p.id);
  const images = ids.length
    ? await db
        .select()
        .from(productImages)
        .where(and(inArray(productImages.productId, ids), eq(productImages.isPrimary, true)))
    : [];
  const imageByProduct = new Map(images.map((i) => [i.productId, i.url]));

  const cats = await db.select().from(categories);
  const catById = new Map(cats.map((c) => [c.id, c.name]));

  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="font-display text-3xl text-ink">Товары</h1>
        <Link
          href="/admin/products/new"
          className="inline-flex items-center gap-1.5 rounded-full bg-clay px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-clay-deep"
        >
          <Plus size={16} /> Новый товар
        </Link>
      </div>

      <form method="get" className="mt-5 flex flex-wrap gap-2">
        <label className="flex min-w-56 flex-1 items-center gap-2 rounded-full border border-line bg-white px-4 py-2.5">
          <Search size={15} className="text-mute" />
          <input
            name="q"
            defaultValue={q}
            placeholder="Поиск по названию"
            className="w-full bg-transparent text-sm outline-none placeholder:text-mute"
          />
        </label>
        <select name="active" defaultValue={sp.active ?? ""} className="rounded-full border border-line bg-white px-4 py-2.5 text-sm">
          <option value="">Все</option>
          <option value="1">Активные</option>
          <option value="0">Скрытые</option>
        </select>
        <button className="rounded-full bg-ink px-5 py-2.5 text-sm font-semibold text-paper">Найти</button>
      </form>

      <p className="mt-4 text-xs text-mute">Найдено: {total}</p>

      <div className="card-shadow mt-3 overflow-hidden rounded-2xl bg-white/70">
        {rows.length === 0 ? (
          <p className="px-5 py-8 text-sm text-mute">Товаров не найдено.</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line text-left text-xs text-mute">
                <th className="px-5 py-3 font-medium">Товар</th>
                <th className="hidden px-5 py-3 font-medium md:table-cell">Категория</th>
                <th className="px-5 py-3 font-medium">Цена</th>
                <th className="px-5 py-3 font-medium">Остаток</th>
                <th className="hidden px-5 py-3 font-medium sm:table-cell">Статус</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((p) => (
                <tr key={p.id} className="border-b border-line/60 last:border-0 hover:bg-cream/50">
                  <td className="px-5 py-3">
                    <Link href={`/admin/products/${p.id}`} className="flex items-center gap-3">
                      {imageByProduct.get(p.id) ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={imageByProduct.get(p.id)}
                          alt=""
                          className="h-10 w-10 rounded-lg bg-cream object-cover"
                        />
                      ) : (
                        <span className="h-10 w-10 rounded-lg bg-cream" />
                      )}
                      <span className="font-medium text-ink hover:underline">{p.name}</span>
                    </Link>
                  </td>
                  <td className="hidden px-5 py-3 text-mute md:table-cell">
                    {p.categoryId ? (catById.get(p.categoryId) ?? "—") : "—"}
                  </td>
                  <td className="px-5 py-3 font-medium">{formatPrice(p.priceMinor)}</td>
                  <td className={`px-5 py-3 font-medium ${p.stock <= 3 ? "text-clay-deep" : ""}`}>{p.stock} шт.</td>
                  <td className="hidden px-5 py-3 sm:table-cell">
                    <span
                      className={`rounded-full px-2.5 py-1 text-[11px] font-semibold ${
                        p.isActive ? "bg-emerald-100 text-emerald-800" : "bg-stone-200 text-stone-500"
                      }`}
                    >
                      {p.isActive ? "Активен" : "Скрыт"}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {pageCount > 1 && (
        <div className="mt-5 flex gap-2">
          {Array.from({ length: pageCount }, (_, i) => i + 1).map((p) => (
            <Link
              key={p}
              href={`/admin/products?q=${encodeURIComponent(q)}&active=${sp.active ?? ""}&page=${p}`}
              className={`rounded-full px-4 py-2 text-sm font-semibold ${
                p === page ? "bg-ink text-paper" : "border border-line bg-white text-ink"
              }`}
            >
              {p}
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
