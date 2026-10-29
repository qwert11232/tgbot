import { escapeHtml } from "@/lib/notify";
import { formatDate, formatPrice, statusLabel } from "@/lib/format";
import type { OrderStatus, StaffRole } from "@/db/schema";
import type { OrderDetails, OrderRow, ProductRow, Staff } from "./service";
import { botCall } from "@/lib/telegram-bot";

/**
 * Тексты и клавиатуры админ-бота. Всё, что приходит от пользователя (имена,
 * адреса), проходит через escapeHtml — parse_mode=HTML иначе ломается.
 */

export type Keyboard = { inline_keyboard: { text: string; callback_data: string }[][] };

export async function sendScreen(chatId: number, text: string, keyboard?: Keyboard): Promise<void> {
  await botCall("sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    ...(keyboard ? { reply_markup: keyboard } : {}),
  });
}

/** Перерисовка экрана по нажатию кнопки: правит сообщение, а не плодит новые. */
export async function editScreen(
  chatId: number,
  messageId: number | undefined,
  text: string,
  keyboard?: Keyboard,
): Promise<void> {
  if (messageId) {
    const ok = await botCall("editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
      ...(keyboard ? { reply_markup: keyboard } : {}),
    });
    if (ok) return;
  }
  await sendScreen(chatId, text, keyboard);
}

export async function answerCallback(id: string, text?: string): Promise<void> {
  await botCall("answerCallbackQuery", { callback_query_id: id, ...(text ? { text } : {}) });
}

/* ---------------------------------- экраны --------------------------------- */

export function mainMenuText(staff: Staff): string {
  return [
    "<b>ГОРН · панель управления</b>",
    "",
    `Вы вошли как <b>${escapeHtml(staff.name || "сотрудник")}</b> (${staff.role === "owner" ? "владелец" : "менеджер"}).`,
    "",
    "• <b>Заказы</b> — статусы, детали, поиск по номеру",
    "• <b>Товары</b> — цены, остатки, фото, скрытие из каталога",
    staff.role === "owner" ? "• <b>Сотрудники</b> — доступ и роли" : "• <b>Отчёт</b> — выручка и топ товаров",
    "",
    "Команды: /orders /products /report /help",
  ].join("\n");
}

export function mainMenuKeyboard(staff: Staff): Keyboard {
  const rows: Keyboard["inline_keyboard"] = [
    [{ text: "📦 Заказы", callback_data: "o:list:all:1" }],
    [{ text: "🛍 Товары", callback_data: "p:list:1" }],
    [{ text: "📊 Отчёт", callback_data: "r:report" }],
  ];
  if (staff.role === "owner") rows.push([{ text: "👥 Сотрудники", callback_data: "s:list" }]);
  return { inline_keyboard: rows };
}

const STATUS_FILTERS: { key: string; label: string }[] = [
  { key: "all", label: "Все" },
  { key: "pending_payment", label: "Ждут оплаты" },
  { key: "paid", label: "Оплачены" },
  { key: "processing", label: "В сборке" },
  { key: "shipped", label: "Отправлены" },
];

export function ordersText(rows: OrderRow[], total: number, page: number, pageSize: number): string {
  if (rows.length === 0) return "<b>Заказы</b>\n\nПока пусто.";
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const lines = rows.map(
    (o) =>
      `#${o.orderNumber} · ${statusLabel(o.status)} · ${formatPrice(o.totalMinor)}\n<i>${escapeHtml(o.customerName)} · ${formatDate(o.createdAt)}</i>`,
  );
  return [`<b>Заказы</b> — всего ${total}, стр. ${page}/${pages}`, "", ...lines].join("\n");
}

export function ordersKeyboard(rows: OrderRow[], page: number, pageSize: number, total: number, filter: string): Keyboard {
  const kb: Keyboard["inline_keyboard"] = rows.map((o) => [
    { text: `#${o.orderNumber} · ${statusLabel(o.status)} · ${formatPrice(o.totalMinor)}`, callback_data: `o:card:${o.id}` },
  ]);

  const filterRow = STATUS_FILTERS.map((f) => ({
    text: f.key === filter ? `· ${f.label} ·` : f.label,
    callback_data: `o:list:${f.key}:1`,
  }));
  kb.push(filterRow.slice(0, 3));
  if (filterRow.length > 3) kb.push(filterRow.slice(3));

  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (pages > 1) {
    const nav: Keyboard["inline_keyboard"][number] = [];
    if (page > 1) nav.push({ text: "←", callback_data: `o:list:${filter}:${page - 1}` });
    nav.push({ text: `${page}/${pages}`, callback_data: `o:list:${filter}:${page}` });
    if (page < pages) nav.push({ text: "→", callback_data: `o:list:${filter}:${page + 1}` });
    kb.push(nav);
  }
  kb.push([{ text: "🏠 Меню", callback_data: "m:home" }]);
  return { inline_keyboard: kb };
}

export function orderText(order: OrderDetails): string {
  const items = order.items
    .map((i) => `• ${escapeHtml(i.name)} — ${i.qty} × ${formatPrice(i.priceMinor)}`)
    .join("\n");
  const lines = [
    `<b>Заказ #${order.orderNumber}</b>`,
    `Статус: <b>${statusLabel(order.status)}</b>`,
    `Сумма: <b>${formatPrice(order.totalMinor)}</b>`,
    `Создан: ${formatDate(order.createdAt)}${order.paidAt ? `\nОплачен: ${formatDate(order.paidAt)}` : ""}`,
    "",
    `<b>Покупатель:</b> ${escapeHtml(order.customerName)}`,
    `Телефон: ${escapeHtml(order.phone)}`,
    order.address ? `Адрес: ${escapeHtml(order.address)}` : "Адрес: —",
    order.comment ? `Комментарий: ${escapeHtml(order.comment)}` : "",
    "",
    items ? `<b>Состав:</b>\n${items}` : "",
  ];
  return lines.filter((l) => l !== "").join("\n");
}

export function orderKeyboard(order: OrderDetails, next: OrderStatus[]): Keyboard {
  const kb: Keyboard["inline_keyboard"] = next.map((s) => [
    { text: statusButton(s), callback_data: `o:set:${order.id}:${s}` },
  ]);
  if (order.buyerTelegramId) {
    kb.push([{ text: "✉️ Написать покупателю", callback_data: `o:msg:${order.id}` }]);
  }
  kb.push([{ text: "← К заказам", callback_data: "o:list:all:1" }]);
  return { inline_keyboard: kb };
}

function statusButton(status: OrderStatus): string {
  switch (status) {
    case "paid":
      return "✅ Отметить оплаченным";
    case "processing":
      return "🧵 В сборку";
    case "shipped":
      return "📦 Отправлен";
    case "delivered":
      return "🏁 Доставлен";
    case "cancelled":
      return "❌ Отменить (вернуть остатки)";
    default:
      return `→ ${statusLabel(status)}`;
  }
}

export function productsText(rows: ProductRow[], total: number, page: number, pageSize: number): string {
  if (rows.length === 0) return "<b>Товары</b>\n\nКаталог пуст. Добавьте первый товар кнопкой ниже.";
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const lines = rows.map(
    (p) => `${p.isActive ? "🟢" : "⚪️"} ${escapeHtml(p.name)}\n   ${formatPrice(p.priceMinor)} · остаток ${p.stock}`,
  );
  return [`<b>Товары</b> — всего ${total}, стр. ${page}/${pages}`, "", ...lines].join("\n");
}

export function productsKeyboard(rows: ProductRow[], page: number, pageSize: number, total: number): Keyboard {
  const kb: Keyboard["inline_keyboard"] = rows.map((p) => [
    { text: `${p.isActive ? "🟢" : "⚪️"} ${truncate(p.name, 40)}`, callback_data: `p:card:${p.id}` },
  ]);
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (pages > 1) {
    const nav: Keyboard["inline_keyboard"][number] = [];
    if (page > 1) nav.push({ text: "←", callback_data: `p:list:${page - 1}` });
    nav.push({ text: `${page}/${pages}`, callback_data: `p:list:${page}` });
    if (page < pages) nav.push({ text: "→", callback_data: `p:list:${page + 1}` });
    kb.push(nav);
  }
  kb.push([{ text: "➕ Новый товар", callback_data: "p:new" }]);
  kb.push([{ text: "🏠 Меню", callback_data: "m:home" }]);
  return { inline_keyboard: kb };
}

export function productText(p: ProductRow): string {
  return [
    `<b>${escapeHtml(p.name)}</b>`,
    `Статус: ${p.isActive ? "в каталоге" : "скрыт"}`,
    `Цена: <b>${formatPrice(p.priceMinor)}</b>`,
    `Остаток: <b>${p.stock}</b>${p.stock === 0 ? " (нет в наличии)" : ""}`,
    `Фото: ${p.imageUrl ? "есть" : "нет"}`,
    "",
    "Измените параметр кнопкой ниже.",
  ].join("\n");
}

export function productKeyboard(p: ProductRow): Keyboard {
  return {
    inline_keyboard: [
      [
        { text: "💰 Цена", callback_data: `p:price:${p.id}` },
        { text: "📦 Остаток", callback_data: `p:stock:${p.id}` },
      ],
      [{ text: "🖼 Загрузить фото", callback_data: `p:photo:${p.id}` }],
      [{ text: p.isActive ? "🙈 Скрыть из каталога" : "👁 Показать в каталоге", callback_data: `p:toggle:${p.id}` }],
      [{ text: "← К товарам", callback_data: "p:list:1" }],
    ],
  };
}

export function staffText(rows: Staff[], selfId: string): string {
  const lines = rows.map(
    (s) =>
      `${s.id === selfId ? "⭐️" : "•"} ${escapeHtml(s.name || "без имени")} · ${s.role === "owner" ? "владелец" : "менеджер"} · ${s.isActive ? "активен" : "отключён"}${s.notifications ? "" : " · 🔕"}\n   <code>${s.telegramId}</code>`,
  );
  return [`<b>Сотрудники</b> — ${rows.length}`, "", ...lines].join("\n");
}

export function staffKeyboard(rows: Staff[], selfId: string): Keyboard {
  const kb: Keyboard["inline_keyboard"] = rows.map((s) => [
    {
      text: `${s.isActive ? "🚫 Отключить" : "✅ Включить"} ${truncate(s.name || String(s.telegramId), 24)}`,
      callback_data: `s:toggle:${s.id}`,
    },
    ...(s.isActive
      ? [{ text: s.role === "owner" ? "→ менеджер" : "→ владелец", callback_data: `s:role:${s.id}` }]
      : []),
  ]);
  void selfId;
  kb.push([{ text: "➕ Добавить сотрудника", callback_data: "s:add" }]);
  kb.push([{ text: "🏠 Меню", callback_data: "m:home" }]);
  return { inline_keyboard: kb };
}

export function reportText(r: {
  todayMinor: number;
  todayOrders: number;
  weekMinor: number;
  weekOrders: number;
  averageMinor: number;
  topProducts: { name: string; qty: number; revenueMinor: number }[];
}): string {
  const top = r.topProducts.length
    ? r.topProducts.map((t, i) => `${i + 1}. ${escapeHtml(t.name)} — ${t.qty} шт · ${formatPrice(t.revenueMinor)}`).join("\n")
    : "пока нет продаж";
  return [
    "<b>Отчёт</b>",
    "",
    `Сегодня: <b>${formatPrice(r.todayMinor)}</b> · заказов ${r.todayOrders}`,
    `7 дней: <b>${formatPrice(r.weekMinor)}</b> · заказов ${r.weekOrders}`,
    `Средний чек: ${formatPrice(r.averageMinor)}`,
    "",
    "<b>Топ товаров за неделю:</b>",
    top,
  ].join("\n");
}

export function helpText(): string {
  return [
    "<b>Команды</b>",
    "/admin — панель управления",
    "/orders — заказы",
    "/products — товары",
    "/report — выручка и топ товаров",
    "/staff — сотрудники (владелец)",
    "/id — мой Telegram ID",
    "",
    "Поиск заказа: отправьте номер, например <code>152</code>.",
  ].join("\n");
}

export function truncate(text: string, max: number): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length <= max ? clean : `${clean.slice(0, max - 1)}…`;
}
