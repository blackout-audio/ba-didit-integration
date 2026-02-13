export interface ShopifyOrderWebhook {
  id: number | string;
  admin_graphql_api_id?: string;
  name?: string;
  email?: string | null;
  tags?: string;
  customer?: {
    id?: number | string;
    first_name?: string | null;
    email?: string | null;
  } | null;
  risks?: Array<{
    recommendation?: string | null;
    score?: string | number | null;
    display?: boolean | null;
    cause_cancel?: boolean | null;
  }>;
}

export function isOrderFraudRisk(order: ShopifyOrderWebhook, triggerTag: string): boolean {
  const requiredTag = normalizeTag(triggerTag);
  if (!requiredTag) {
    return false;
  }

  const orderTags = (order.tags ?? "")
    .split(",")
    .map(normalizeTag)
    .filter(Boolean);

  return orderTags.includes(requiredTag);
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
