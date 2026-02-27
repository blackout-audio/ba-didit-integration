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
  customer?: {
    id?: number | string;
    first_name?: string | null;
    email?: string | null;
  } | null;
}

export function isOrderFraudRisk(order: ShopifyOrderWebhook, triggerTag: string): boolean {
  const requiredTag = normalizeTag(triggerTag);
  if (!requiredTag) {
    return false;
  }

  const orderTags = getNormalizedOrderTags(order);
  return orderTags.includes(requiredTag);
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
  triggerTag: string
): boolean {
  const requiredTag = normalizeTag(triggerTag);
  if (!requiredTag) {
    return false;
  }

  // First observed state is used as baseline only.
  if (previousTagsCsv === null) {
    return false;
  }

  const previous = getNormalizedTagsFromCsv(previousTagsCsv);
  const current = getNormalizedTagsFromCsv(currentTagsCsv ?? "");
  return !previous.includes(requiredTag) && current.includes(requiredTag);
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

  return false;
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
