export interface WorkerEnv {
  DIDIT_DB: D1Database;
  DIDIT_JOBS: Queue;
  APP_URL: string;
  SHOPIFY_API_KEY: string;
  SHOPIFY_API_SECRET: string;
  SHOPIFY_SCOPES: string;
  SHOPIFY_WEBHOOK_PATH: string;
  CUSTOMER_EMAIL_PROVIDER: "flow" | "resend" | "gmail";
  FLOW_METAFIELD_NAMESPACE: string;
  FRAUD_TRIGGER_TAG: string;
  DIDIT_AUTH_BASE_URL: string;
  DIDIT_VERIFY_BASE_URL: string;
  DIDIT_APP_ID: string;
  DIDIT_API_KEY: string;
  DIDIT_CLIENT_ID: string;
  DIDIT_CLIENT_SECRET: string;
  DIDIT_WEBHOOK_SECRET: string;
  DIDIT_FEATURES: string;
  OPS_EMAIL: string;
  MAIL_FROM: string;
  RESEND_API_KEY?: string;
  GMAIL_CLIENT_ID?: string;
  GMAIL_CLIENT_SECRET?: string;
  GMAIL_REFRESH_TOKEN?: string;
  GMAIL_USER?: string;
  GMAIL_FROM?: string;
  DIDIT_REVIEW_PASSWORD?: string;
  RETRY_DAYS: string;
  MAX_FOLLOWUPS: string;
  OPS_ALERT_TOKEN?: string;
}

export function getRetryDays(env: WorkerEnv): number {
  const parsed = Number(env.RETRY_DAYS || "7");
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 7;
}

export function getMaxFollowups(env: WorkerEnv): number {
  const parsed = Number(env.MAX_FOLLOWUPS || "2");
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 2;
}
