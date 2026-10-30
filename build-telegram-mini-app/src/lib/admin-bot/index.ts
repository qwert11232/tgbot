import { escapeHtml } from "@/lib/notify";
import { statusLabel } from "@/lib/format";
import type { OrderStatus } from "@/db/schema";
import { getFileUrl, sendMessage } from "@/lib/telegram-bot";
import {
  AdminError,
  addStaff,
  allowedNextStatuses,
  createProduct,
  ensureOwnerFromEnv,
  findOrderByNumber,
  findStaff,
  getOrder,
  getProduct,
  listOrders,
  listProducts,
  listStaff,
  revenueReport,
  setProductImage,
  setProductPrice,
  setProductStock,
  setStaffActive,
  toggleProductActive,
  updateOrderStatus,
  type Staff,
} from "./service";
import { clearState, getState, parseCount, parseRubToMinor, setState } from "./state";
import {
  answerCallback,
  editScreen,
  helpText,
  mainMenuKeyboard,
  mainMenuText,
  orderKeyboard,
  orderText,
  ordersKeyboard,
  ordersText,
  productKeyboard,
  productText,
  productsKeyboard,
  productsText,
  reportText,
  sendScreen,
  staffKeyboard,
  staffText,
} from "./ui";

/**
 * Админка в Telegram. Единственная точка входа — `handleAdminBotUpdate`,
 * её вызывает вебхук. Пользователь идентифицируется по from.id, доступ — по
 * таблице staff_users (роли owner/manager). Никаких паролей и cookie.
 */

interface TgUser {
  id: number;
  first_name?: string;
  username?: string;
}

export interface AdminUpdate {
  message?: {
    message_id: number;
    chat: { id: number };
    from?: TgUser;
    text?: string;
    photo?: { file_id: string }[];
  };
  callback_query?: {
    id: string;
    from: TgUser;
    data?: string;
    message?: { message_id: number; chat: { id: number } };
  };
}

const COMMANDS = ["/admin", "/orders", "/products", "/report", "/staff", "/help", "/id"];

/** Сотрудник или null. Первичный владелец из ADMIN_TELEGRAM_ID чинится сам. */
async function resolveStaff(telegramId: number): Promise<Staff | null> {
  const found = await findStaff(telegramId);
  if (found) return found;
  const ownerId = Number((process.env.ADMIN_TELEGRAM_ID ?? "").trim());
  if (Number.isFinite(ownerId) && ownerId === telegramId) return ensureOwnerFromEnv();
  return null;
}

/**
 * Возвращает true, если апдейт обработан админ-ботом (тогда вебхук не должен
 * обрабатывать его как покупательский).
 */
export async function handleAdminBotUpdate(update: AdminUpdate): Promise<boolean> {
  try {
    if (update.callback_query) return await handleCallback(update.callback_query);
    if (update.message) return await handleMessage(update.message);
    return false;
  } catch (err) {
    console.error("[admin-bot] update failed:", err);
    const chatId = update.message?.chat.id ?? update.callback_query?.message?.chat.id;
    if (chatId) {
      const text = err instanceof AdminError ? err.message : "Не удалось выполнить действие. Попробуйте ещё раз.";
      await sendScreen(chatId, `⚠️ ${escapeHtml(text)}`).catch(() => undefined);
    }
    return true;
  }
}

/* --------------------------------- сообщения -------------------------------- */

async function handleMessage(message: NonNullable<AdminUpdate["message"]>): Promise<boolean> {
  const chatId = message.chat.id;
  const fromId = message.from?.id ?? chatId;
  const text = (message.text ?? "").trim();
  const command = text.split(/\s+/)[0].toLowerCase().split("@")[0];

  // /id доступен всем — так сотрудник узнаёт свой ID, чтобы попросить доступ.
  if (command === "/id") {
    await sendScreen(chatId, `Ваш Telegram ID: <code>${fromId}</code>`);
    return true;
  }

  if (!COMMANDS.includes(command)) {
    const staff = await resolveStaff(fromId);
    if (!staff) return false; // обычные сообщения покупателя — не наше дело

    // Фото: единственный сценарий — загрузка изображения товара.
    if (message.photo?.length) {
      const state = await getState(chatId);
      if (state?.state === "product_photo") {
        await handleProductPhoto(staff, chatId, message.photo, String(state.payload.productId ?? ""));
        return true;
      }
      await sendScreen(chatId, "Чтобы загрузить фото, откройте товар → «Загрузить фото».");
      return true;
    }

    // Ввод в рамках начатого диалога (цена, остаток, имя и т.п.).
    const state = await getState(chatId);
    if (state) {
      await handleStateInput(staff, chatId, state, text, message.message_id);
      return true;
    }

    // Поиск заказа по номеру — просто отправьте число.
    if (/^\d{1,9}$/.test(text)) {
      const order = await findOrderByNumber(Number(text));
      if (order) {
        await sendScreen(chatId, orderText(order), orderKeyboard(order, allowedNextStatuses(order.status)));
      } else {
        await sendScreen(chatId, `Заказ #${escapeHtml(text)} не найден.`);
      }
      return true;
    }

    // Произвольный текст без состояния — подсказка.
    await sendScreen(chatId, "Не понял. Откройте /admin или /help.", mainMenuKeyboard(staff));
    return true;
  }

  // Команды панели — только сотрудникам.
  const staff = await resolveStaff(fromId);
  if (!staff) {
    await sendScreen(
      chatId,
      [
        "⛔️ <b>Нет доступа к панели управления.</b>",
        "",
        `Ваш Telegram ID: <code>${fromId}</code>`,
        "Передайте его владельцу магазина — он добавит вас в сотрудники.",
      ].join("\n"),
    );
    return true;
  }

  switch (command) {
    case "/admin":
      await sendScreen(chatId, mainMenuText(staff), mainMenuKeyboard(staff));
      return true;
    case "/orders":
      await showOrders(staff, chatId, undefined, "all", 1);
      return true;
    case "/products":
      await showProducts(staff, chatId, undefined, 1);
      return true;
    case "/staff":
      await showStaff(staff, chatId, undefined);
      return true;
    case "/report":
      await editScreen(chatId, undefined, reportText(await revenueReport()), {
        inline_keyboard: [[{ text: "🏠 Меню", callback_data: "m:home" }]],
      });
      return true;
    case "/help":
      await sendScreen(chatId, helpText());
      return true;
    default:
      return false;
  }
}

/* ---------------------------------- кнопки ---------------------------------- */

async function handleCallback(cb: NonNullable<AdminUpdate["callback_query"]>): Promise<boolean> {
  const data = cb.data ?? "";
  if (!/^[ompsr]:/.test(data)) return false;

  const chatId = cb.message?.chat.id;
  const messageId = cb.message?.message_id;
  if (!chatId) {
    await answerCallback(cb.id);
    return true;
  }

  const staff = await resolveStaff(cb.from.id);
  if (!staff) {
    await answerCallback(cb.id, "Нет доступа");
    return true;
  }
  if (data.startsWith("s:") && staff.role !== "owner") {
    await answerCallback(cb.id, "Только владелец может управлять сотрудниками");
    return true;
  }

  const [scope, action, arg1, arg2] = data.split(":");

  try {
    if (scope === "m" && action === "home") {
      await editScreen(chatId, messageId, mainMenuText(staff), mainMenuKeyboard(staff));
      await answerCallback(cb.id);
      return true;
    }

    if (scope === "r" && action === "report") {
      await editScreen(chatId, messageId, reportText(await revenueReport()), {
        inline_keyboard: [[{ text: "🏠 Меню", callback_data: "m:home" }]],
      });
      await answerCallback(cb.id);
      return true;
    }

    if (scope === "o") {
      await handleOrderCallback(staff, chatId, messageId, cb.id, action, arg1, arg2);
      return true;
    }
    if (scope === "p") {
      await handleProductCallback(staff, chatId, messageId, cb.id, action, arg1);
      return true;
    }
    if (scope === "s") {
      await handleStaffCallback(staff, chatId, messageId, cb.id, action, arg1);
      return true;
    }
    await answerCallback(cb.id);
    return true;
  } catch (err) {
    const text = err instanceof AdminError ? err.message : "Ошибка выполнения";
    if (!(err instanceof AdminError)) console.error("[admin-bot] callback failed:", err);
    await answerCallback(cb.id, text);
    return true;
  }
}

/* ---------------------------------- заказы ---------------------------------- */

async function showOrders(
  staff: Staff,
  chatId: number,
  messageId: number | undefined,
  filter: string,
  page: number,
): Promise<void> {
  void staff;
  const status = filter !== "all" && filter ? (filter as OrderStatus) : undefined;
  const { rows, total, page: safePage, pageSize } = await listOrders({ status, page });
  await editScreen(chatId, messageId, ordersText(rows, total, safePage, pageSize), ordersKeyboard(rows, safePage, pageSize, total, filter));
}

async function handleOrderCallback(
  staff: Staff,
  chatId: number,
  messageId: number | undefined,
  cbId: string,
  action: string,
  arg1?: string,
  arg2?: string,
): Promise<void> {
  if (action === "list") {
    await showOrders(staff, chatId, messageId, arg1 || "all", Number(arg2) || 1);
    await answerCallback(cbId);
    return;
  }

  if (action === "card" && arg1) {
    const order = await getOrder(arg1);
    if (!order) throw new AdminError("Заказ не найден", 404);
    await editScreen(chatId, messageId, orderText(order), orderKeyboard(order, allowedNextStatuses(order.status)));
    await answerCallback(cbId);
    return;
  }

  if (action === "set" && arg1 && arg2) {
    const result = await updateOrderStatus(arg1, arg2 as OrderStatus);
    const order = await getOrder(arg1);
    if (order) {
      await editScreen(chatId, messageId, orderText(order), orderKeyboard(order, allowedNextStatuses(order.status)));
    }
    await answerCallback(cbId, `Заказ #${result.orderNumber}: ${statusLabel(result.status)}`);
    return;
  }

  if (action === "msg" && arg1) {
    const order = await getOrder(arg1);
    if (!order) throw new AdminError("Заказ не найден", 404);
    await setState(chatId, staff.id, "order_message", { orderId: order.id, buyerId: order.buyerTelegramId });
    await sendScreen(
      chatId,
      `Напишите сообщение для покупателя заказа #${order.orderNumber}. Оно уйдёт от имени бота.\n\n/cancel — отменить.`,
    );
    await answerCallback(cbId);
    return;
  }

  await answerCallback(cbId);
}

/* ---------------------------------- товары ---------------------------------- */

async function showProducts(staff: Staff, chatId: number, messageId: number | undefined, page: number): Promise<void> {
  void staff;
  const { rows, total, page: safePage, pageSize } = await listProducts(page);
  await editScreen(chatId, messageId, productsText(rows, total, safePage, pageSize), productsKeyboard(rows, safePage, pageSize, total));
}

async function handleProductCallback(
  staff: Staff,
  chatId: number,
  messageId: number | undefined,
  cbId: string,
  action: string,
  arg1?: string,
): Promise<void> {
  if (action === "list") {
    await showProducts(staff, chatId, messageId, Number(arg1) || 1);
    await answerCallback(cbId);
    return;
  }

  if (action === "new") {
    await setState(chatId, staff.id, "product_new_name", {});
    await editScreen(chatId, messageId, "Новый товар.\n\nШаг 1/2: отправьте название.\n\n/cancel — отменить.");
    await answerCallback(cbId);
    return;
  }

  if (action === "card" && arg1) {
    const product = await getProduct(arg1);
    if (!product) throw new AdminError("Товар не найден", 404);
    await editScreen(chatId, messageId, productText(product), productKeyboard(product));
    await answerCallback(cbId);
    return;
  }

  if (action === "toggle" && arg1) {
    const product = await toggleProductActive(arg1);
    await editScreen(chatId, messageId, productText(product), productKeyboard(product));
    await answerCallback(cbId, product.isActive ? "Товар показан в каталоге" : "Товар скрыт");
    return;
  }

  if (action === "price" && arg1) {
    const product = await getProduct(arg1);
    if (!product) throw new AdminError("Товар не найден", 404);
    await setState(chatId, staff.id, "product_price", { productId: product.id });
    await editScreen(
      chatId,
      messageId,
      `Новая цена для «${escapeHtml(product.name)}».\nОтправьте сумму в рублях, например <code>1890</code> или <code>1890,50</code>.\n\n/cancel — отменить.`,
    );
    await answerCallback(cbId);
    return;
  }

  if (action === "stock" && arg1) {
    const product = await getProduct(arg1);
    if (!product) throw new AdminError("Товар не найден", 404);
    await setState(chatId, staff.id, "product_stock", { productId: product.id });
    await editScreen(
      chatId,
      messageId,
      `Новый остаток для «${escapeHtml(product.name)}» (сейчас ${product.stock}).\nОтправьте целое число.\n\n/cancel — отменить.`,
    );
    await answerCallback(cbId);
    return;
  }

  if (action === "photo" && arg1) {
    const product = await getProduct(arg1);
    if (!product) throw new AdminError("Товар не найден", 404);
    await setState(chatId, staff.id, "product_photo", { productId: product.id });
    await editScreen(
      chatId,
      messageId,
      `Пришлите фото для «${escapeHtml(product.name)}» одним изображением (до 5 МБ).\nОно станет главным в каталоге.\n\n/cancel — отменить.`,
    );
    await answerCallback(cbId);
    return;
  }

  await answerCallback(cbId);
}

async function handleProductPhoto(
  staff: Staff,
  chatId: number,
  photos: { file_id: string }[],
  productId: string,
): Promise<void> {
  void staff;
  const best = photos[photos.length - 1];
  const url = await getFileUrl(best.file_id);
  if (!url) {
    await sendScreen(chatId, "Не удалось получить файл из Telegram. Попробуйте ещё раз.");
    return;
  }
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) {
    await sendScreen(chatId, "Не удалось скачать фото из Telegram (код " + res.status + ").");
    return;
  }
  const buf = Buffer.from(await res.arrayBuffer());
  const product = await setProductImage(productId, buf);
  await clearState(chatId);
  await sendScreen(chatId, `✅ Фото обновлено.\n\n${productText(product)}`, productKeyboard(product));
}

/* -------------------------------- сотрудники -------------------------------- */

async function showStaff(staff: Staff, chatId: number, messageId: number | undefined): Promise<void> {
  if (staff.role !== "owner") throw new AdminError("Раздел доступен только владельцу", 403);
  const rows = await listStaff();
  await editScreen(chatId, messageId, staffText(rows, staff.id), staffKeyboard(rows, staff.id));
}

async function handleStaffCallback(
  staff: Staff,
  chatId: number,
  messageId: number | undefined,
  cbId: string,
  action: string,
  arg1?: string,
): Promise<void> {
  if (action === "list") {
    await showStaff(staff, chatId, messageId);
    await answerCallback(cbId);
    return;
  }

  if (action === "add") {
    await setState(chatId, staff.id, "staff_add_id", {});
    await editScreen(
      chatId,
      messageId,
      [
        "Добавление сотрудника.",
        "",
        "Шаг 1/2: отправьте его <b>Telegram ID</b> (число).",
        "Сотрудник может узнать свой ID командой /id в этом боте.",
        "",
        "/cancel — отменить.",
      ].join("\n"),
    );
    await answerCallback(cbId);
    return;
  }

  if (action === "toggle" && arg1) {
    const rows = await listStaff();
    const target = rows.find((s) => s.id === arg1);
    if (!target) throw new AdminError("Сотрудник не найден", 404);
    if (target.id === staff.id) throw new AdminError("Нельзя отключить самого себя");
    const updated = await setStaffActive(arg1, !target.isActive);
    const refreshed = await listStaff();
    await editScreen(chatId, messageId, staffText(refreshed, staff.id), staffKeyboard(refreshed, staff.id));
    await answerCallback(cbId, updated.isActive ? "Доступ включён" : "Доступ отключён");
    return;
  }

  if (action === "role" && arg1) {
    const rows = await listStaff();
    const target = rows.find((s) => s.id === arg1);
    if (!target) throw new AdminError("Сотрудник не найден", 404);
    if (target.role === "owner") {
      throw new AdminError("Понизить владельца нельзя — сначала назначьте другого владельца");
    }
    const updated = await addStaff({ telegramId: target.telegramId, role: "owner", name: target.name });
    const refreshed = await listStaff();
    await editScreen(chatId, messageId, staffText(refreshed, staff.id), staffKeyboard(refreshed, staff.id));
    await answerCallback(cbId, `${updated.name || updated.telegramId} — владелец`);
    return;
  }

  await answerCallback(cbId);
}

/* ----------------------------- ввод в диалогах ----------------------------- */

async function handleStateInput(
  staff: Staff,
  chatId: number,
  state: { state: string; payload: Record<string, unknown> },
  text: string,
  messageId: number,
): Promise<void> {
  void messageId;

  if (text === "/cancel") {
    await clearState(chatId);
    await sendScreen(chatId, "Отменено.", mainMenuKeyboard(staff));
    return;
  }

  const productId = typeof state.payload.productId === "string" ? state.payload.productId : "";

  switch (state.state) {
    case "product_price": {
      const minor = parseRubToMinor(text);
      if (minor === null) throw new AdminError("Не понял цену. Пришлите число, например 1890");
      const product = await setProductPrice(productId, minor);
      await clearState(chatId);
      await sendScreen(chatId, `✅ Цена обновлена.\n\n${productText(product)}`, productKeyboard(product));
      return;
    }

    case "product_stock": {
      const count = parseCount(text);
      if (count === null) throw new AdminError("Не понял остаток. Пришлите целое число, например 12");
      const product = await setProductStock(productId, count);
      await clearState(chatId);
      await sendScreen(chatId, `✅ Остаток обновлён.\n\n${productText(product)}`, productKeyboard(product));
      return;
    }

    case "product_new_name": {
      const name = text.trim();
      if (name.length < 2) throw new AdminError("Название слишком короткое");
      await setState(chatId, staff.id, "product_new_price", { name });
      await sendScreen(chatId, "Шаг 2/2: отправьте цену в рублях, например 1890.\n\n/cancel — отменить.");
      return;
    }

    case "product_new_price": {
      const minor = parseRubToMinor(text);
      if (minor === null) throw new AdminError("Не понял цену. Пришлите число, например 1890");
      const product = await createProduct({ name: String(state.payload.name ?? "Товар"), priceMinor: minor });
      await clearState(chatId);
      await sendScreen(
        chatId,
        `✅ Товар создан.\n\n${productText(product)}\n\nДобавьте фото и остаток кнопками ниже.`,
        productKeyboard(product),
      );
      return;
    }

    case "product_photo": {
      await sendScreen(chatId, "Жду именно фото (изображение), а не текст. Или /cancel.");
      return;
    }

    case "staff_add_id": {
      const id = parseCount(text);
      if (id === null || id <= 0) throw new AdminError("Telegram ID — это число. Узнать: команда /id у сотрудника");
      await setState(chatId, staff.id, "staff_add_name", { telegramId: id });
      await sendScreen(chatId, "Шаг 2/2: отправьте имя сотрудника (или «-», чтобы без имени).\n\n/cancel — отменить.");
      return;
    }

    case "staff_add_name": {
      if (staff.role !== "owner") throw new AdminError("Раздел доступен только владельцу", 403);
      const telegramId = Number(state.payload.telegramId ?? 0);
      const name = text.trim() === "-" ? "" : text.trim();
      const created = await addStaff({ telegramId, name, role: "manager" });
      await clearState(chatId);
      const rows = await listStaff();
      await sendScreen(
        chatId,
        `✅ Сотрудник добавлен: ${escapeHtml(created.name || String(created.telegramId))} (менеджер).\nОн получит доступ, открыв /admin в боте.`,
        staffKeyboard(rows, staff.id),
      );
      return;
    }

    case "order_message": {
      const buyerId = Number(state.payload.buyerId ?? 0);
      if (!buyerId) throw new AdminError("У заказа нет Telegram-покупателя", 404);
      await sendMessage(buyerId, `<b>Сообщение от магазина:</b>\n${escapeHtml(text)}`);
      await clearState(chatId);
      await sendScreen(chatId, "✅ Сообщение отправлено покупателю.", mainMenuKeyboard(staff));
      return;
    }

    default:
      await clearState(chatId);
      await sendScreen(chatId, "Состояние сброшено. Откройте /admin.", mainMenuKeyboard(staff));
  }
}
