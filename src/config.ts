import dotenv from "dotenv";
import { z } from "zod";

dotenv.config();

const envSchema = z.object({
  NODE_ENV: z.string().default("development"),
  PORT: z.coerce.number().default(3000),
  APP_URL: z.string().url(),
  SQLITE_PATH: z.string().default("./data.sqlite"),
  SHOPIFY_API_KEY: z.string().min(1),
  SHOPIFY_API_SECRET: z.string().min(1),
  SHOPIFY_SCOPES: z.string().default("read_orders,write_orders,read_customers,write_customers"),
  SHOPIFY_WEBHOOK_PATH: z.string().default("/webhooks/shopify/orders-updated"),
  CUSTOMER_EMAIL_PROVIDER: z.enum(["flow", "shopify", "smtp"]).default("flow"),
  FLOW_METAFIELD_NAMESPACE: z.string().default("didit"),
  FRAUD_TRIGGER_TAG: z.string().default("nofraud-review"),
  DIDIT_AUTH_BASE_URL: z.string().url().default("https://apx.didit.me"),
  DIDIT_VERIFY_BASE_URL: z.string().url().default("https://verification.didit.me"),
  DIDIT_APP_ID: z.string().default(""),
  DIDIT_API_KEY: z.string().default(""),
  DIDIT_CLIENT_ID: z.string().default(""),
  DIDIT_CLIENT_SECRET: z.string().default(""),
  DIDIT_WEBHOOK_SECRET: z.string().min(1),
  DIDIT_FEATURES: z.string().default("OCR + NFC + FACE"),
  MAIL_HOST: z.string().default(""),
  MAIL_PORT: z.coerce.number().default(587),
  MAIL_SECURE: z.preprocess((value) => value === "true", z.boolean()).default(false),
  MAIL_USER: z.string().default(""),
  MAIL_PASS: z.string().default(""),
  MAIL_FROM: z.string().email(),
  OPS_EMAIL: z.string().email().default("operations@blackoutaudio.com"),
  RETRY_DAYS: z.coerce.number().default(7),
  MAX_FOLLOWUPS: z.coerce.number().default(2)
}).superRefine((value, ctx) => {
  const hasDiditApiKey = value.DIDIT_API_KEY.trim().length > 0;
  const hasDiditClientPair =
    value.DIDIT_CLIENT_ID.trim().length > 0 && value.DIDIT_CLIENT_SECRET.trim().length > 0;

  if (!hasDiditApiKey && !hasDiditClientPair) {
    ctx.addIssue({
      code: "custom",
      path: ["DIDIT_API_KEY"],
      message: "Set DIDIT_API_KEY or DIDIT_CLIENT_ID + DIDIT_CLIENT_SECRET."
    });
  }
});

export const env = envSchema.parse(process.env);
