export interface ShopifyOrderWebhook {
  id: number | string;
  admin_graphql_api_id?: string;
  name?: string;
  email?: string | null;
  tags?: string;
  created_at?: string;
  updated_at?: string;
  cancelled_at?: string | null;
  closed_at?: string | null;
  financial_status?: string | null;
  customer?: {
    id?: number | string;
    first_name?: string | null;
    email?: string | null;
  } | null;
}

export function isOrderFraudRisk(order: ShopifyOrderWebhook, triggerTags: string): boolean {
  const required = getTriggerTags(triggerTags);
  if (required.length === 0) {
    return false;
  }

  const orderTags = getNormalizedOrderTags(order);
  return required.some((tag) => orderTags.includes(tag));
}

/**
 * FRAUD_TRIGGER_TAG holds one or more tags, comma separated, e.g.
 * "nofraud-review,nofraud-fail". Underscores and hyphens are interchangeable.
 */
function getTriggerTags(triggerTags: string): string[] {
  return getNormalizedTagsFromCsv(triggerTags ?? "");
}

export const ORDER_CREATION_CUTOFF_ISO = "2026-02-15T00:00:00.000Z";

export function isOrderCreatedOnOrAfterCutoff(order: ShopifyOrderWebhook): boolean {
  const createdAtMs = Date.parse(order.created_at ?? "");
  const cutoffMs = Date.parse(ORDER_CREATION_CUTOFF_ISO);
  if (!Number.isFinite(createdAtMs) || !Number.isFinite(cutoffMs)) {
    return false;
  }
  return createdAtMs >= cutoffMs;
}

export function wasTriggerTagAdded(
  previousTagsCsv: string | null,
  currentTagsCsv: string | null | undefined,
  triggerTags: string
): boolean {
  const required = getTriggerTags(triggerTags);
  if (required.length === 0) {
    return false;
  }

  // First observed state is used as baseline only.
  if (previousTagsCsv === null) {
    return false;
  }

  const previous = getNormalizedTagsFromCsv(previousTagsCsv);
  const current = getNormalizedTagsFromCsv(currentTagsCsv ?? "");
  return required.some((tag) => !previous.includes(tag) && current.includes(tag));
}

export function shouldSkipFraudVerification(order: ShopifyOrderWebhook): boolean {
  const orderTags = getNormalizedOrderTags(order);
  if (orderTags.includes("didit-successfully-verified") || orderTags.includes("verified")) {
    return true;
  }

  // Orders already canceled/closed/fulfilled should never re-enter verification.
  if (Boolean(order.cancelled_at) || Boolean(order.closed_at)) {
    return true;
  }

  return Boolean(getDeadPaymentReason(order.financial_status));
}

export type VerificationAbortReason =
  | "order_not_found"
  | "order_cancelled"
  | "order_closed"
  | "payment_voided"
  | "payment_refunded"
  | "payment_expired";

export interface OrderVerificationSignals {
  exists?: boolean;
  cancelledAt?: string | null;
  closedAt?: string | null;
  financialStatus?: string | null;
}

/**
 * Single source of truth for "this order must no longer receive verification emails".
 * Accepts either webhook payload fields or Admin API order fields.
 */
export function getVerificationAbortReason(signals: OrderVerificationSignals): VerificationAbortReason | null {
  if (signals.exists === false) {
    return "order_not_found";
  }
  if (signals.cancelledAt) {
    return "order_cancelled";
  }
  if (signals.closedAt) {
    return "order_closed";
  }
  return getDeadPaymentReason(signals.financialStatus);
}

export function getOrderVerificationSignals(order: ShopifyOrderWebhook): OrderVerificationSignals {
  return {
    cancelledAt: order.cancelled_at ?? null,
    closedAt: order.closed_at ?? null,
    financialStatus: order.financial_status ?? null
  };
}

/**
 * A voided authorization, full refund, or expired authorization means the money
 * is gone for good, so verification can no longer change the order's outcome.
 * Partial refunds are deliberately excluded: the remaining balance may still
 * be pending verification.
 */
function getDeadPaymentReason(
  financialStatus: string | null | undefined
): Extract<VerificationAbortReason, "payment_voided" | "payment_refunded" | "payment_expired"> | null {
  const status = String(financialStatus ?? "").trim().toLowerCase();
  if (status === "voided") {
    return "payment_voided";
  }
  if (status === "refunded") {
    return "payment_refunded";
  }
  if (status === "expired") {
    return "payment_expired";
  }
  return null;
}

function getNormalizedOrderTags(order: ShopifyOrderWebhook): string[] {
  return getNormalizedTagsFromCsv(order.tags ?? "");
}

function getNormalizedTagsFromCsv(tagsCsv: string): string[] {
  return tagsCsv.split(",").map(normalizeTag).filter(Boolean);
}

function normalizeTag(tag: string) {
  return tag.trim().toLowerCase().replace(/[_\s]+/g, "-");
}

export function getCustomerEmail(order: ShopifyOrderWebhook): string | null {
  return order.email ?? order.customer?.email ?? null;
}

export function getCustomerName(order: ShopifyOrderWebhook): string | null {
  return order.customer?.first_name ?? null;
}

export function getOrderName(order: ShopifyOrderWebhook): string {
  return order.name ?? `#${order.id}`;
}
