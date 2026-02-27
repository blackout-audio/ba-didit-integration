import { WorkerEnv } from "./config";
import { hasEmailEvent, recordEmailEvent } from "./db";
import { BLACKOUT_LOGO_DATA_URI } from "./logo";

const LOGO_PLACEHOLDER = "__BLACKOUT_LOGO_SRC__";
const LOGO_CID = "blackout-logo";
const LOGO_BASE64 = BLACKOUT_LOGO_DATA_URI.replace(/^data:image\/png;base64,/, "");

interface SendBaseInput {
  eventKey: string;
  to: string;
}

export async function sendVerificationEmail(input: SendBaseInput & {
  env: WorkerEnv;
  customerName?: string | null;
  orderName: string;
  verificationUrl: string;
  attemptNumber: number;
}) {
  const subject =
    input.attemptNumber === 0
      ? `Verification required for your order ${input.orderName}`
      : `Reminder: verification required for order ${input.orderName}`;

  const text = [
    input.attemptNumber > 0
      ? `Reminder ${input.attemptNumber}: please complete verification for order ${input.orderName}.`
      : "",
    "",
    "Our system flagged your order with a risk of fraud. To make sure the payment method used belongs to you, we're asking you to complete the verification using the secure link below:",
    "",
    input.verificationUrl,
    "",
    "This step only takes a minute and helps us protect both you and our community from fraudulent transactions. Once you've finished the verification, we'll proceed with processing your order right away.",
    "",
    "Best regards,",
    "Blackout Audio Team",
    "contact@blackoutaudio.com"
  ].join("\n");
  const html = renderEmailHtml({
    intro:
      "Our system flagged your order with a risk of fraud. To make sure the payment method used belongs to you, we're asking you to complete the verification using the secure link below:",
    verificationUrl: input.verificationUrl,
    body:
      "This step only takes a minute and helps us protect both you and our community from fraudulent transactions. Once you've finished the verification, we'll proceed with processing your order right away.",
    reminder:
      input.attemptNumber > 0
        ? `Reminder ${input.attemptNumber}: please complete verification for order ${input.orderName}.`
        : null
  });

  await sendTransactionalEmail({
    env: input.env,
    eventKey: input.eventKey,
    to: input.to,
    subject,
    text,
    html
  });
}

export async function sendSuccessEmail(input: SendBaseInput & { env: WorkerEnv; orderName: string }) {
  const subject = "Verification complete";
  const text = [
    "Thank you for successfully passing the verification.",
    "",
    "We will now resume processing your order.",
    "",
    "Best regards,",
    "Blackout Audio Team",
    "contact@blackoutaudio.com"
  ].join("\n");
  const html = renderEmailHtml({
    intro: "Thank you for successfully passing the verification.",
    body: "We will now resume processing your order."
  });

  await sendTransactionalEmail({
    env: input.env,
    eventKey: input.eventKey,
    to: input.to,
    subject,
    text,
    html
  });
}

export async function sendOpsManualReviewEmail(input: {
  env: WorkerEnv;
  eventKey: string;
  orderName: string;
  customerEmail: string;
  diditSessionId: string;
}) {
  const subject = `Didit manual review required for ${input.orderName}`;
  const reviewPassword = input.env.DIDIT_REVIEW_PASSWORD?.trim() || "(check current password in secure vault)";
  const reviewUrl = "https://business.didit.me/";
  const reviewLogin = "operations@blackoutaudio.com";
  const text = [
    `Manual review required for order ${input.orderName}.`,
    `Customer email: ${input.customerEmail}`,
    `Didit session id: ${input.diditSessionId}`,
    "",
    "To Review: go to",
    reviewUrl,
    "",
    "log in with",
    `${reviewLogin} and current password. (${reviewPassword} at time of writing)`
  ].join("\n");

  await sendTransactionalEmail({
    env: input.env,
    eventKey: input.eventKey,
    to: input.env.OPS_EMAIL,
    subject,
    text
  });
}

async function sendTransactionalEmail(input: {
  env: WorkerEnv;
  eventKey: string;
  to: string;
  subject: string;
  text: string;
  html?: string;
}) {
  const alreadySent = await hasEmailEvent(input.env, input.eventKey);
  if (alreadySent) {
    return;
  }

  if (input.env.CUSTOMER_EMAIL_PROVIDER === "flow") {
    console.info("Email delegated to Flow (no provider call)", {
      to: input.to,
      subject: input.subject,
      eventKey: input.eventKey
    });
    await recordEmailEvent(input.env, input.eventKey, input.to, input.subject);
    return;
  }

  if (input.env.CUSTOMER_EMAIL_PROVIDER === "gmail") {
    await sendViaGmailApi(input);
  } else {
    await sendViaResend(input);
  }

  await recordEmailEvent(input.env, input.eventKey, input.to, input.subject);
}

async function sendViaResend(input: {
  env: WorkerEnv;
  to: string;
  subject: string;
  text: string;
  html?: string;
}) {
  const apiKey = input.env.RESEND_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("RESEND_API_KEY is missing");
  }
  if (!input.env.MAIL_FROM?.trim()) {
    throw new Error("MAIL_FROM is missing");
  }

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      from: input.env.MAIL_FROM,
      to: [input.to],
      subject: input.subject,
      text: input.text,
      html: input.html?.replace(LOGO_PLACEHOLDER, BLACKOUT_LOGO_DATA_URI)
    })
  });

  if (!response.ok) {
    const details = await response.text();
    throw new Error(`Resend email send failed: ${response.status} ${details}`);
  }
}

async function sendViaGmailApi(input: {
  env: WorkerEnv;
  to: string;
  subject: string;
  text: string;
  html?: string;
}) {
  const clientId = input.env.GMAIL_CLIENT_ID?.trim();
  const clientSecret = input.env.GMAIL_CLIENT_SECRET?.trim();
  const refreshToken = input.env.GMAIL_REFRESH_TOKEN?.trim();
  const gmailUser = input.env.GMAIL_USER?.trim();
  const fromHeader = input.env.GMAIL_FROM?.trim() || input.env.MAIL_FROM?.trim();

  if (!clientId || !clientSecret || !refreshToken || !gmailUser) {
    throw new Error("GMAIL_CLIENT_ID/GMAIL_CLIENT_SECRET/GMAIL_REFRESH_TOKEN/GMAIL_USER are required");
  }
  if (!fromHeader) {
    throw new Error("GMAIL_FROM or MAIL_FROM is required");
  }

  const accessToken = await getGoogleAccessToken(clientId, clientSecret, refreshToken);
  const html = input.html?.replace(LOGO_PLACEHOLDER, `cid:${LOGO_CID}`);
  const rawMime = buildPlainTextMime({
    from: fromHeader,
    to: input.to,
    subject: input.subject,
    text: input.text,
    html,
    inlineImageCid: LOGO_CID,
    inlineImageBase64: LOGO_BASE64
  });

  const response = await fetch(`https://gmail.googleapis.com/gmail/v1/users/${encodeURIComponent(gmailUser)}/messages/send`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      raw: toBase64Url(rawMime)
    })
  });

  if (!response.ok) {
    const details = await response.text();
    throw new Error(`Gmail API send failed: ${response.status} ${details}`);
  }
}

async function getGoogleAccessToken(clientId: string, clientSecret: string, refreshToken: string) {
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token"
    }).toString()
  });

  if (!response.ok) {
    const details = await response.text();
    throw new Error(`Google token refresh failed: ${response.status} ${details}`);
  }

  const payload = (await response.json()) as { access_token?: string };
  if (!payload.access_token) {
    throw new Error("Google token refresh returned no access_token");
  }
  return payload.access_token;
}

function buildPlainTextMime(input: {
  from: string;
  to: string;
  subject: string;
  text: string;
  html?: string;
  inlineImageCid?: string;
  inlineImageBase64?: string;
}) {
  if (input.html?.trim()) {
    const boundary = `bnd_${Math.random().toString(36).slice(2)}_${Date.now()}`;
    const relatedBoundary = `rel_${Math.random().toString(36).slice(2)}_${Date.now()}`;
    const hasInlineImage = Boolean(input.inlineImageCid && input.inlineImageBase64);
    if (hasInlineImage) {
      return [
        `From: ${input.from}`,
        `To: ${input.to}`,
        `Subject: ${input.subject}`,
        "MIME-Version: 1.0",
        `Content-Type: multipart/related; boundary="${relatedBoundary}"`,
        "",
        `--${relatedBoundary}`,
        `Content-Type: multipart/alternative; boundary="${boundary}"`,
        "",
        `--${boundary}`,
        'Content-Type: text/plain; charset="UTF-8"',
        "Content-Transfer-Encoding: 7bit",
        "",
        input.text,
        "",
        `--${boundary}`,
        'Content-Type: text/html; charset="UTF-8"',
        "Content-Transfer-Encoding: 7bit",
        "",
        input.html,
        "",
        `--${boundary}--`,
        "",
        `--${relatedBoundary}`,
        "Content-Type: image/png; name=\"blackout-logo.png\"",
        "Content-Transfer-Encoding: base64",
        `Content-ID: <${input.inlineImageCid}>`,
        "Content-Disposition: inline; filename=\"blackout-logo.png\"",
        "",
        input.inlineImageBase64,
        "",
        `--${relatedBoundary}--`
      ].join("\r\n");
    }

    return [
      `From: ${input.from}`,
      `To: ${input.to}`,
      `Subject: ${input.subject}`,
      "MIME-Version: 1.0",
      `Content-Type: multipart/alternative; boundary="${boundary}"`,
      "",
      `--${boundary}`,
      'Content-Type: text/plain; charset="UTF-8"',
      "Content-Transfer-Encoding: 7bit",
      "",
      input.text,
      "",
      `--${boundary}`,
      'Content-Type: text/html; charset="UTF-8"',
      "Content-Transfer-Encoding: 7bit",
      "",
      input.html,
      "",
      `--${boundary}--`
    ].join("\r\n");
  }

  return [
    `From: ${input.from}`,
    `To: ${input.to}`,
    `Subject: ${input.subject}`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: 7bit",
    "",
    input.text
  ].join("\r\n");
}

function toBase64Url(value: string) {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function renderEmailHtml(input: {
  intro: string;
  body: string;
  verificationUrl?: string;
  reminder?: string | null;
}) {
  const reminderHtml = input.reminder
    ? `<p style="margin:0 0 14px;color:#111827;font-size:15px;line-height:1.6;">${escapeHtml(input.reminder)}</p>`
    : "";
  const linkHtml = input.verificationUrl
    ? `<p style="margin:0 0 16px;"><a href="${escapeAttribute(input.verificationUrl)}" style="color:#2563eb;font-size:16px;line-height:1.6;word-break:break-all;">${escapeHtml(input.verificationUrl)}</a></p>`
    : "";

  return [
    "<!doctype html>",
    '<html><body style="margin:0;padding:0;font-family:Arial,sans-serif;color:#111827;">',
    '<table role="presentation" width="100%" cellspacing="0" cellpadding="0">',
    '<tr><td align="center">',
    '<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:680px;">',
    '<tr><td align="center" style="padding:14px 0 18px;">',
    `<img src="${LOGO_PLACEHOLDER}" alt="Blackout Audio" style="display:block;width:80%;max-width:416px;height:auto;border-radius:14px;" />`,
    "</td></tr>",
    '<tr><td style="font-size:15px;line-height:1.6;color:#111827;">',
    reminderHtml,
    `<p style="margin:0 0 14px;">${escapeHtml(input.intro)}</p>`,
    linkHtml,
    `<p style="margin:0 0 18px;">${escapeHtml(input.body)}</p>`,
    '<p style="margin:0;">Best regards,<br/>Blackout Audio Team<br/>contact@blackoutaudio.com</p>',
    "</td></tr>",
    "</table>",
    "</td></tr>",
    "</table>",
    "</body></html>"
  ].join("");
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeAttribute(value: string) {
  return escapeHtml(value);
}
