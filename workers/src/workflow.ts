import { WorkerEnv, getMaxFollowups, getRetryDays } from "./config";
import {
  deleteVerificationJob,
  getDueRetries,
  getJobById,
  getJobByOrder,
  getOrderTagSnapshot,
  getJobBySessionId,
  getShopAccessToken,
  lockJob,
  markJobStatus,
  recordOpsAlert,
  setJobProcessingError,
  tryInsertProvisioningJob,
  upsertOrderTagSnapshot,
  updateJobWithNewSession
} from "./db";
import {
  createDiditVerificationSession,
  DiditDecisionNotFoundError,
  inspectDiditSessionStatus,
  retrieveDiditDecision
} from "./didit";
import { sendOpsManualReviewEmail, sendSuccessEmail, sendVerificationEmail } from "./email";
import {
  getCustomerEmail,
  getCustomerName,
  getOrderName,
  isOrderCreatedOnOrAfterCutoff,
  ShopifyOrderWebhook,
  shouldSkipFraudVerification,
  wasTriggerTagAdded
} from "./fraud";
import { addOrderTag, captureFirstUncapturedPayment, removeOrderTag, setOrderVerificationMetafields } from "./shopify";

export type QueueJob =
  | { type: "process_shopify_order"; shop: string; order: ShopifyOrderWebhook }
  | { type: "process_didit_decision"; sessionId: string }
  | { type: "process_retry_job"; jobId: number };

export async function handleRiskyOrderEvent(env: WorkerEnv, shop: string, order: ShopifyOrderWebhook) {
  const orderId = String(order.id);
  const previousTags = await getOrderTagSnapshot(env, shop, orderId);
  const currentTags = order.tags ?? "";
  await upsertOrderTagSnapshot(env, shop, orderId, currentTags);

  if (!wasTriggerTagAdded(previousTags, currentTags, env.FRAUD_TRIGGER_TAG)) {
    return { skipped: true, reason: "trigger_tag_not_added" as const };
  }
  if (!isOrderCreatedOnOrAfterCutoff(order)) {
    return { skipped: true, reason: "order_before_cutoff" as const };
  }
  if (shouldSkipFraudVerification(order)) {
    return { skipped: true, reason: "order_not_eligible" as const };
  }

  const orderName = getOrderName(order);
  const email = getCustomerEmail(order);
  if (!email) {
    return { skipped: true, reason: "missing_customer_email" as const };
  }

  const vendorDataBase = buildVendorData(orderName, email);
  const shopAccessToken = await getShopAccessToken(env, shop);
  const existing = await getJobByOrder(env, shop, orderId);

  if (existing) {
    if (existing.status === "provisioning") {
      return { skipped: true, reason: "job_provisioning" as const };
    }
    if (existing.status === "verified") {
      return { skipped: true, reason: "already_verified" as const };
    }

    const previousSession = await inspectDiditSessionStatus(env, existing.diditSessionId);
    if (previousSession.exists && !previousSession.expired) {
      return { skipped: true, reason: "job_exists" as const };
    }

    const diditSession = await createDiditVerificationSession(env, {
      vendorData: vendorDataBase,
      callback: `${env.APP_URL}/webhooks/didit`
    });

    await updateJobWithNewSession(env, {
      id: existing.id,
      vendorDataBase,
      diditSessionId: diditSession.sessionId,
      diditSessionToken: diditSession.sessionToken,
      diditVerificationUrl: diditSession.verificationUrl,
      status: "awaiting_verification",
      followupCount: 0,
      nextAttemptAt: addDaysIso(new Date(), getRetryDays(env))
    });

    if (shopAccessToken) {
      await addOrderTag(env, shop, shopAccessToken, orderId, "didit_verification_pending");
      await setOrderVerificationMetafields(env, {
        shop,
        accessToken: shopAccessToken,
        orderGidOrLegacyId: orderId,
        status: "pending",
        verificationUrl: diditSession.verificationUrl,
        sessionId: diditSession.sessionId
      });
    }

    await sendVerificationEmail({
      env,
      eventKey: `verification:${shop}:${orderId}:${diditSession.sessionId}:0`,
      to: email,
      customerName: getCustomerName(order),
      orderName,
      verificationUrl: diditSession.verificationUrl,
      attemptNumber: 0
    });

    return { skipped: false, jobId: existing.id, replacedExisting: true as const };
  }

  const provisionalJobId = await tryInsertProvisioningJob(env, {
    shop,
    orderId,
    vendorDataBase,
    customerEmail: email,
    customerId: order.customer?.id ? String(order.customer.id) : null
  });
  if (!provisionalJobId) {
    return { skipped: true, reason: "job_exists" as const };
  }

  let diditSession: { sessionId: string; sessionToken: string | null; verificationUrl: string };
  try {
    diditSession = await createDiditVerificationSession(env, {
      vendorData: vendorDataBase,
      callback: `${env.APP_URL}/webhooks/didit`
    });
  } catch (error) {
    await deleteVerificationJob(env, provisionalJobId);
    throw error;
  }

  await updateJobWithNewSession(env, {
    id: provisionalJobId,
    vendorDataBase,
    diditSessionId: diditSession.sessionId,
    diditSessionToken: diditSession.sessionToken,
    diditVerificationUrl: diditSession.verificationUrl,
    status: "awaiting_verification",
    followupCount: 0,
    nextAttemptAt: addDaysIso(new Date(), getRetryDays(env))
  });

  if (shopAccessToken) {
    await addOrderTag(env, shop, shopAccessToken, orderId, "didit_verification_required");
    await addOrderTag(env, shop, shopAccessToken, orderId, "didit_verification_pending");
    await setOrderVerificationMetafields(env, {
      shop,
      accessToken: shopAccessToken,
      orderGidOrLegacyId: orderId,
      status: "pending",
      verificationUrl: diditSession.verificationUrl,
      sessionId: diditSession.sessionId
    });
  }

  await sendVerificationEmail({
    env,
    eventKey: `verification:${shop}:${orderId}:${diditSession.sessionId}:0`,
    to: email,
    customerName: getCustomerName(order),
    orderName,
    verificationUrl: diditSession.verificationUrl,
    attemptNumber: 0
  });

  return { skipped: false, jobId: provisionalJobId };
}

export async function processRetryJob(env: WorkerEnv, jobId: number) {
  const now = new Date();
  const nowIso = now.toISOString();
  const lockUntil = new Date(now.getTime() + 60_000).toISOString();
  const locked = await lockJob(env, jobId, nowIso, lockUntil);
  if (!locked) {
    return { skipped: true, reason: "job_locked" as const };
  }

  const job = await getJobById(env, jobId);
  if (!job || job.status !== "awaiting_verification") {
    return { skipped: true, reason: "job_not_pending" as const };
  }

  try {
    // Reconcile latest decision before sending any follow-up.
    const decisionRecheck = await handleDiditDecisionEvent(env, job.diditSessionId);
    if (decisionRecheck.handled) {
      return { skipped: true, reason: "decision_finalized" as const };
    }
    if (decisionRecheck.reason === "already_verified" || decisionRecheck.reason === "already_manual_review") {
      return { skipped: true, reason: "decision_already_finalized" as const };
    }
    if (decisionRecheck.reason === "decision_not_found") {
      await markJobStatus(env, job.id, "retry_exhausted");
      return { skipped: true, reason: "session_not_found" as const };
    }
    if (decisionRecheck.reason !== "decision_still_pending") {
      return { skipped: true, reason: "decision_recheck_skipped" as const };
    }

    const maxFollowups = getMaxFollowups(env);
    if (job.followupCount >= maxFollowups) {
      await markJobStatus(env, job.id, "retry_exhausted");
      return { skipped: true, reason: "retries_exhausted" as const };
    }

    const diditSession = await createDiditVerificationSession(env, {
      vendorData: job.vendorDataBase ?? buildVendorData(job.orderId, job.customerEmail),
      callback: `${env.APP_URL}/webhooks/didit`
    });

    const nextFollowupCount = job.followupCount + 1;
    const shouldScheduleAnother = nextFollowupCount < maxFollowups;
    const nextAttemptAt = shouldScheduleAnother ? addDaysIso(new Date(), getRetryDays(env)) : null;

    await updateJobWithNewSession(env, {
      id: job.id,
      diditSessionId: diditSession.sessionId,
      diditSessionToken: diditSession.sessionToken,
      diditVerificationUrl: diditSession.verificationUrl,
      followupCount: nextFollowupCount,
      nextAttemptAt
    });

    const shopAccessToken = await getShopAccessToken(env, job.shop);
    if (shopAccessToken) {
      await addOrderTag(env, job.shop, shopAccessToken, job.orderId, "didit_verification_pending");
      await setOrderVerificationMetafields(env, {
        shop: job.shop,
        accessToken: shopAccessToken,
        orderGidOrLegacyId: job.orderId,
        status: "pending",
        verificationUrl: diditSession.verificationUrl,
        sessionId: diditSession.sessionId
      });
    }

    await sendVerificationEmail({
      env,
      eventKey: `verification:${job.shop}:${job.orderId}:${diditSession.sessionId}:${nextFollowupCount}`,
      to: job.customerEmail,
      orderName: job.orderId,
      verificationUrl: diditSession.verificationUrl,
      attemptNumber: nextFollowupCount
    });

    if (!shouldScheduleAnother) {
      await markJobStatus(env, job.id, "retry_exhausted");
    }
    return { skipped: false };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown retry error";
    await setJobProcessingError(env, job.id, message, new Date(Date.now() + 5 * 60_000).toISOString());
    throw error;
  }
}

export async function enqueueRetryForDueJobs(env: WorkerEnv) {
  const dueJobs = await getDueRetries(env, new Date().toISOString());
  for (const job of dueJobs) {
    await env.DIDIT_JOBS.send({
      type: "process_retry_job",
      jobId: job.id
    } as QueueJob);
  }
  return dueJobs.length;
}

export async function handleDiditDecisionEvent(env: WorkerEnv, sessionId: string) {
  const job = await getJobBySessionId(env, sessionId);
  if (!job) {
    return { handled: false, reason: "job_not_found" as const };
  }
  if (job.status === "verified") {
    return { handled: false, reason: "already_verified" as const };
  }

  let decision: any;
  try {
    decision = await retrieveDiditDecision(env, sessionId);
  } catch (error) {
    if (error instanceof DiditDecisionNotFoundError) {
      return { handled: false, reason: "decision_not_found" as const };
    }
    throw error;
  }
  let normalized = parseDiditDecision(decision);
  if (normalized === "manual_review") {
    // Didit decisions can briefly lag after webhook delivery; confirm once before alerting ops.
    await sleep(10_000);
    let decisionAfterDelay: any;
    try {
      decisionAfterDelay = await retrieveDiditDecision(env, sessionId);
    } catch (error) {
      if (error instanceof DiditDecisionNotFoundError) {
        return { handled: false, reason: "decision_not_found" as const };
      }
      throw error;
    }
    normalized = parseDiditDecision(decisionAfterDelay);
  }
  if (normalized === "pending") {
    return { handled: false, reason: "decision_still_pending" as const };
  }

  const accessToken = await getShopAccessToken(env, job.shop);
  if (!accessToken) {
    throw new Error(`No Shopify access token found for shop ${job.shop}`);
  }

  if (normalized === "approved") {
    await markJobStatus(env, job.id, "verified");
    await removeOrderTag(env, job.shop, accessToken, job.orderId, "didit_verification_pending");
    await removeOrderTag(env, job.shop, accessToken, job.orderId, "didit_manual_review");
    await removeOrderTag(env, job.shop, accessToken, job.orderId, "verified");
    await addOrderTag(env, job.shop, accessToken, job.orderId, "didit_successfully_verified");
    await setOrderVerificationMetafields(env, {
      shop: job.shop,
      accessToken,
      orderGidOrLegacyId: job.orderId,
      status: "verified",
      verificationUrl: job.diditVerificationUrl,
      sessionId
    });
    await captureFirstUncapturedPayment(env, job.shop, accessToken, job.orderId);

    await sendSuccessEmail({
      env,
      eventKey: `success:${job.shop}:${job.orderId}:${sessionId}`,
      to: job.customerEmail,
      orderName: job.orderId
    });
    return { handled: true, outcome: "approved" as const };
  }

  if (job.status === "manual_review") {
    return { handled: false, reason: "already_manual_review" as const };
  }

  await markJobStatus(env, job.id, "manual_review");
  await removeOrderTag(env, job.shop, accessToken, job.orderId, "didit_verification_pending");
  await addOrderTag(env, job.shop, accessToken, job.orderId, "didit_manual_review");
  await setOrderVerificationMetafields(env, {
    shop: job.shop,
    accessToken,
    orderGidOrLegacyId: job.orderId,
    status: "manual_review",
    verificationUrl: job.diditVerificationUrl,
    sessionId
  });
  await recordOpsAlert(env, {
    shop: job.shop,
    orderId: job.orderId,
    customerEmail: job.customerEmail,
    diditSessionId: sessionId,
    reason: "manual_review_required"
  });
  await sendOpsManualReviewEmail({
    env,
    eventKey: `manual-review:${job.shop}:${job.orderId}:${sessionId}`,
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
  if (
    candidates.some((value) =>
      [
        "manual_review",
        "manual review",
        "declined",
        "rejected",
        "deny",
        "denied",
        "failed",
        "fail",
        "fraud",
        "risk",
        "review_required",
        "review required"
      ].includes(value)
    )
  ) {
    return "manual_review";
  }
  return "pending";
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

async function sleep(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

