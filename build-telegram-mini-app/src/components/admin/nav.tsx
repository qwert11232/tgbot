"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ClipboardList, Gauge, Package, Users } from "lucide-react";
import type { StaffRole } from "@/db/schema";

const ITEMS = [
  { href: "/admin", label: "Панель", icon: Gauge },
  { href: "/admin/products", label: "Товары", icon: Package },
  { href: "/admin/orders", label: "Заказы", icon: ClipboardList },
  { href: "/admin/staff", label: "Сотрудники", icon: Users, ownerOnly: true },
] as const;

export function AdminNav({ role }: { role: StaffRole }) {
  const pathname = usePathname();
  return (
    <nav className="flex gap-1 overflow-x-auto px-3 py-2 lg:flex-col lg:px-3 lg:py-0">
      {ITEMS.filter((i) => !("ownerOnly" in i && i.ownerOnly) || role === "owner").map((item) => {
        const active = item.href === "/admin" ? pathname === "/admin" : pathname.startsWith(item.href);
        const Icon = item.icon;
        return (
          <Link
            key={item.href}
            href={item.href}
            className={`flex shrink-0 items-center gap-2.5 rounded-xl px-3.5 py-2.5 text-sm font-medium transition ${
              active ? "bg-ink text-paper" : "text-ink/70 hover:bg-cream hover:text-ink"
            }`}
          >
            <Icon size={17} />
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
