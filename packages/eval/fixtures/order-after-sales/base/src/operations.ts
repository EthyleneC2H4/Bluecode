export type OrderStatus = "PENDING" | "PAID" | "SHIPPED" | "CANCELED"
export interface Order { id: string; sku: string; quantity: number; unitPriceCents: number; totalCents: number; status: OrderStatus; refundedQuantity: number; refundedCents: number }
export interface Refund { id: string; orderId: string; quantity: number; amountCents: number }
export interface State {
  prices: Record<string, number>
  stock: Record<string, number>
  orders: Record<string, Order>
  refunds: Record<string, Refund>
  orderKeys: Record<string, { fingerprint: string; result: Order }>
  refundKeys: Record<string, { fingerprint: string; result: Refund }>
  nextOrder: number
  nextRefund: number
}
export interface Result { status: number; body: unknown }

export function createOrder(_state: State, _input: unknown, _idempotencyKey: string | null): Result {
  return { status: 501, body: { error: "Implement T1 in src/operations.ts" } }
}

export function cancelOrder(_state: State, _orderId: string): Result {
  return { status: 501, body: { error: "Implement T2 in src/operations.ts" } }
}

export function refundOrder(_state: State, _orderId: string, _input: unknown, _idempotencyKey: string | null): Result {
  return { status: 501, body: { error: "Implement T3 in src/operations.ts" } }
}
