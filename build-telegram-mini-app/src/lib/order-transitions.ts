import type { OrderStatus } from "@/db/schema";

/** Допустимые переходы статусов заказа (направленный граф) — общий для actions и UI. */
export const ORDER_TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  pending_payment: ["paid", "cancelled"],
  paid: ["processing", "cancelled"],
  processing: ["shipped", "cancelled"],
  shipped: ["delivered"],
  delivered: [],
  cancelled: [],
};

/** Статусы, из которых отмена требует возврата остатков на склад. */
export const RESTOCK_ON_CANCEL_FROM: OrderStatus[] = ["pending_payment", "paid", "processing"];
