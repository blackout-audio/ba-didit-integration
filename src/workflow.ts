import { env } from "./config.js";
import {
  getDueRetries,
  getJobByOrder,
  getJobBySessionId,
  getShopAccessToken,
  insertVerificationJob,
  markJobStatus,
  updateJobWithNewSession
} from "./db.js";
import {
  sendManualReviewOpsEmail,
  sendVerificationEmail,
  sendVerificationSuccessEmail
} from "./email.js";
import {
  createDiditVerificationSession,
  inspectDiditSessionStatus,
  retrieveDiditDecision
} from "./didit.js";
import {
  getCustomerEmail,
  getCustomerName,
  getOrderName,
  isOrderFraudRisk,
  ShopifyOrderWebhook
} from "./fraud.js";
import { addOrderTag, sendOrderInvoiceEmail, setOrderVerificationMetafields } from "./shopify.js";

export async function handleRiskyOrder(shop: string, order: ShopifyOrderWebhook) {
  if (!isOrderFraudRisk(order, env.FRAUD_TRIGGER_TAG)) {
    return { skipped: true, reason: "order_not_risky" as const };
  }

  const orderId = String(order.id);
  const orderName = getOrderName(order);
  const email = getCustomerEmail(order);
  if (!email) {
    return { skipped: true, reason: "missing_customer_email" as const };
  }

  const existing = await getJobByOrder(shop, orderId);
  const vendorDataBase = buildVendorData(orderName, email);
  const shopAccessToken = await getShopAccessToken(shop);
  if (existing) {
    if (existing.status === "verified") {
      return { skipped: true, reason: "already_verified" as const };
    }

    const previousSession = await inspectDiditSessionStatus(existing.diditSessionId);
    if (previousSession.exists && !previousSession.expired) {
      return { skipped: true, reason: "job_exists" as const };
    }

    const diditSession = await createDiditVerificationSession({
      vendorData: vendorDataBase,
      callback: `${env.APP_URL}/didit/callback?shop=${encodeURIComponent(shop)}&orderId=${encodeURIComponent(orderId)}`
    });

    await updateJobWithNewSession({
      id: existing.id,
      vendorDataBase,
      diditSessionId: diditSession.sessionId,
      diditSessionToken: diditSession.sessionToken,
      diditVerificationUrl: diditSession.verificationUrl,
      status: "awaiting_verification",
      followupCount: 0,
      nextAttemptAt: addDaysIso(new Date(), env.RETRY_DAYS)
    });
    if (shopAccessToken) {
      await addOrderTag(shop, shopAccessToken, orderId, "didit_verification_pending");
      await setOrderVerificationMetafields({
        shop,
        accessToken: shopAccessToken,
        orderGidOrLegacyId: orderId,
        status: "pending",
        verificationUrl: diditSession.verificationUrl,
        sessionId: diditSession.sessionId
      });
    }

    await sendVerificationEmailWithProvider({
      shop,
      accessToken: shopAccessToken,
      orderId,
      to: email,
      customerName: getCustomerName(order),
      orderName,
      verificationUrl: diditSession.verificationUrl,
      attemptNumber: 0
    });

    return { skipped: false, jobId: existing.id, replacedExisting: true as const };
  }

  const diditSession = await createDiditVerificationSession({
    vendorData: vendorDataBase,
    callback: `${env.APP_URL}/didit/callback?shop=${encodeURIComponent(shop)}&orderId=${encodeURIComponent(orderId)}`
  });

  const nextAttemptAt = addDaysIso(new Date(), env.RETRY_DAYS);
  const jobId = await insertVerificationJob({
    shop,
    orderId,
    vendorDataBase,
    customerEmail: email,
    customerId: order.customer?.id ? String(order.customer.id) : null,
    diditSessionId: diditSession.sessionId,
    diditSessionToken: diditSession.sessionToken,
    diditVerificationUrl: diditSession.verificationUrl,
    nextAttemptAt
  });
  if (shopAccessToken) {
    await addOrderTag(shop, shopAccessToken, orderId, "didit_verification_required");
    await addOrderTag(shop, shopAccessToken, orderId, "didit_verification_pending");
    await setOrderVerificationMetafields({
      shop,
      accessToken: shopAccessToken,
      orderGidOrLegacyId: orderId,
      status: "pending",
      verificationUrl: diditSession.verificationUrl,
      sessionId: diditSession.sessionId
    });
  }

  await sendVerificationEmailWithProvider({
    shop,
    accessToken: shopAccessToken,
    orderId,
    to: email,
    customerName: getCustomerName(order),
    orderName,
    verificationUrl: diditSession.verificationUrl,
    attemptNumber: 0
  });

  return { skipped: false, jobId };
}

export async function processRetryQueue() {
  const dueJobs = await getDueRetries(new Date().toISOString());
  for (const job of dueJobs) {
    if (job.followupCount >= env.MAX_FOLLOWUPS) {
      await markJobStatus(job.id, "retry_exhausted");
      continue;
    }

    const diditSession = await createDiditVerificationSession({
      vendorData: job.vendorDataBase ?? buildVendorData(job.orderId, job.customerEmail),
      callback: `${env.APP_URL}/didit/callback?shop=${encodeURIComponent(job.shop)}&orderId=${encodeURIComponent(job.orderId)}`
    });

    const nextFollowupCount = job.followupCount + 1;
    const shouldScheduleAnother = nextFollowupCount < env.MAX_FOLLOWUPS;
    const nextAttemptAt = shouldScheduleAnother ? addDaysIso(new Date(), env.RETRY_DAYS) : null;

    await updateJobWithNewSession({
      id: job.id,
      diditSessionId: diditSession.sessionId,
      diditSessionToken: diditSession.sessionToken,
      diditVerificationUrl: diditSession.verificationUrl,
      followupCount: nextFollowupCount,
      nextAttemptAt
    });

    const shopAccessToken = await getShopAccessToken(job.shop);
    if (shopAccessToken) {
      await addOrderTag(job.shop, shopAccessToken, job.orderId, "didit_verification_pending");
      await setOrderVerificationMetafields({
        shop: job.shop,
        accessToken: shopAccessToken,
        orderGidOrLegacyId: job.orderId,
        status: "pending",
        verificationUrl: diditSession.verificationUrl,
        sessionId: diditSession.sessionId
      });
    }
    await sendVerificationEmailWithProvider({
      shop: job.shop,
      accessToken: shopAccessToken,
      orderId: job.orderId,
      to: job.customerEmail,
      orderName: job.orderId,
      verificationUrl: diditSession.verificationUrl,
      attemptNumber: nextFollowupCount
    });

    if (!shouldScheduleAnother) {
      await markJobStatus(job.id, "retry_exhausted");
    }
  }
}

export async function handleDiditDecisionUpdate(sessionId: string) {
  const job = await getJobBySessionId(sessionId);
  if (!job || job.status !== "awaiting_verification") {
    return { handled: false, reason: "job_not_found_or_not_pending" as const };
  }

  const decision = await retrieveDiditDecision(sessionId);
  const normalized = parseDiditDecision(decision);
  if (normalized === "pending") {
    return { handled: false, reason: "decision_still_pending" as const };
  }

  const accessToken = await getShopAccessToken(job.shop);
  if (!accessToken) {
    throw new Error(`No Shopify access token found for shop ${job.shop}`);
  }

  const orderGid = `gid://shopify/Order/${job.orderId}`;
  if (normalized === "approved") {
    await markJobStatus(job.id, "verified");
    await addOrderTag(job.shop, accessToken, orderGid, "verified");
    await addOrderTag(job.shop, accessToken, orderGid, "didit_verified");
    await setOrderVerificationMetafields({
      shop: job.shop,
      accessToken,
      orderGidOrLegacyId: job.orderId,
      status: "verified",
      verificationUrl: job.diditVerificationUrl,
      sessionId
    });
    await sendVerificationSuccessEmailWithProvider({
      shop: job.shop,
      accessToken,
      orderId: job.orderId,
      to: job.customerEmail,
      orderName: job.orderId
    });
    return { handled: true, outcome: "approved" as const };
  }

  await markJobStatus(job.id, "manual_review");
  await addOrderTag(job.shop, accessToken, orderGid, "didit_manual_review");
  await setOrderVerificationMetafields({
    shop: job.shop,
    accessToken,
    orderGidOrLegacyId: job.orderId,
    status: "manual_review",
    verificationUrl: job.diditVerificationUrl,
    sessionId
  });
  await sendManualReviewOpsEmail({
    shop: job.shop,
    orderName: job.orderId,
    customerEmail: job.customerEmail,
    diditSessionId: sessionId
  });
  return { handled: true, outcome: "manual_review" as const };
}

function parseDiditDecision(decisionPayload: any): "approved" | "manual_review" | "pending" {
  const candidates = [
    decisionPayload?.decision,
    decisionPayload?.status,
    decisionPayload?.result,
    decisionPayload?.result?.decision,
    decisionPayload?.summary?.decision,
    decisionPayload?.summary?.status
  ]
    .filter(Boolean)
    .map((value) => String(value).toLowerCase());

  if (candidates.some((value) => ["approved", "pass", "passed", "verified", "accept"].includes(value))) {
    return "approved";
  }

  if (candidates.some((value) => ["pending", "in_progress", "processing", "not started"].includes(value))) {
    return "pending";
  }

  return "manual_review";
}

function addDaysIso(date: Date, days: number) {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + days);
  return next.toISOString();
}

function buildVendorData(orderNumber: string, customerEmail: string | null) {
  const normalizedOrder = orderNumber.trim();
  const normalizedEmail = customerEmail?.trim() ?? "";
  return normalizedEmail ? `${normalizedOrder} | ${normalizedEmail}` : normalizedOrder;
}

async function sendVerificationEmailWithProvider(input: {
  shop: string;
  accessToken: string | null;
  orderId: string;
  to: string;
  customerName?: string | null;
  orderName: string;
  verificationUrl: string;
  attemptNumber: number;
}) {
  if (env.CUSTOMER_EMAIL_PROVIDER === "flow") {
    console.info("Customer verification email delegated to Shopify Flow", {
      shop: input.shop,
      orderId: input.orderId,
      to: input.to
    });
    return;
  }

  if (env.CUSTOMER_EMAIL_PROVIDER === "shopify" && !input.accessToken) {
    console.warn("Shopify customer email skipped: missing shop access token, falling back to SMTP");
  }

  if (env.CUSTOMER_EMAIL_PROVIDER === "shopify" && input.accessToken) {
    const subject =
      input.attemptNumber === 0
        ? `Action required: Verify order ${input.orderName}`
        : `Reminder ${input.attemptNumber}: Verify order ${input.orderName}`;
    const customMessage = [
      `Hi ${input.customerName?.trim() || "there"},`,
      `We flagged your order ${input.orderName} for additional verification.`,
      `Please complete your secure verification here: ${input.verificationUrl}`,
      "If you do not complete this check, we may be unable to process your order.",
      "Thank you, Blackout Audio Team"
    ].join("\n\n");

    try {
      await sendOrderInvoiceEmail({
        shop: input.shop,
        accessToken: input.accessToken,
        orderGidOrLegacyId: input.orderId,
        to: input.to,
        subject,
        customMessage
      });
      return;
    } catch (error) {
      console.error("Shopify customer email send failed, falling back to SMTP", error);
    }
  }

  await sendVerificationEmail({
    to: input.to,
    customerName: input.customerName,
    orderName: input.orderName,
    verificationUrl: input.verificationUrl,
    attemptNumber: input.attemptNumber
  });
}

async function sendVerificationSuccessEmailWithProvider(input: {
  shop: string;
  accessToken: string | null;
  orderId: string;
  to: string;
  orderName: string;
}) {
  if (env.CUSTOMER_EMAIL_PROVIDER === "flow") {
    console.info("Customer success email delegated to Shopify Flow", {
      shop: input.shop,
      orderId: input.orderId,
      to: input.to
    });
    return;
  }

  if (env.CUSTOMER_EMAIL_PROVIDER === "shopify" && !input.accessToken) {
    console.warn("Shopify success email skipped: missing shop access token, falling back to SMTP");
  }

  if (env.CUSTOMER_EMAIL_PROVIDER === "shopify" && input.accessToken) {
    const customMessage = [
      `Thank you for completing verification for order ${input.orderName}.`,
      "We have approved your check and will proceed with your order.",
      "Blackout Audio Team"
    ].join("\n\n");

    try {
      await sendOrderInvoiceEmail({
        shop: input.shop,
        accessToken: input.accessToken,
        orderGidOrLegacyId: input.orderId,
        to: input.to,
        subject: `Verification complete for order ${input.orderName}`,
        customMessage
      });
      return;
    } catch (error) {
      console.error("Shopify success email send failed, falling back to SMTP", error);
    }
  }

  await sendVerificationSuccessEmail({
    to: input.to,
    orderName: input.orderName
  });
}
