import nodemailer from "nodemailer";
import { env } from "./config.js";

const mailEnabled = Boolean(env.MAIL_HOST && env.MAIL_USER && env.MAIL_PASS);
const transporter = mailEnabled
  ? nodemailer.createTransport({
      host: env.MAIL_HOST,
      port: env.MAIL_PORT,
      secure: env.MAIL_SECURE,
      auth: {
        user: env.MAIL_USER,
        pass: env.MAIL_PASS
      }
    })
  : null;

export async function sendVerificationEmail(input: {
  to: string;
  customerName?: string | null;
  orderName: string;
  verificationUrl: string;
  attemptNumber: number;
}) {
  const greetingName = input.customerName?.trim() || "there";
  const subject =
    input.attemptNumber === 0
      ? `Action required: Verify order ${input.orderName}`
      : `Reminder ${input.attemptNumber}: Verify order ${input.orderName}`;

  const html = `
    <p>Hi ${escapeHtml(greetingName)},</p>
    <p>We flagged your order ${escapeHtml(input.orderName)} for additional verification.</p>
    <p>Please complete your secure verification here:</p>
    <p><a href="${input.verificationUrl}">${input.verificationUrl}</a></p>
    <p>If you do not complete this check, we may be unable to process your order.</p>
    <p>Thank you,<br/>Blackout Audio Team</p>
  `;

  await sendMail({
    from: env.MAIL_FROM,
    to: input.to,
    subject,
    html
  });
}

export async function sendVerificationSuccessEmail(input: {
  to: string;
  customerName?: string | null;
  orderName: string;
}) {
  const greetingName = input.customerName?.trim() || "there";
  const html = `
    <p>Hi ${escapeHtml(greetingName)},</p>
    <p>Thank you for completing verification for order ${escapeHtml(input.orderName)}.</p>
    <p>We have approved your check and will proceed with your order.</p>
    <p>Blackout Audio Team</p>
  `;

  await sendMail({
    from: env.MAIL_FROM,
    to: input.to,
    subject: `Verification complete for order ${input.orderName}`,
    html
  });
}

export async function sendManualReviewOpsEmail(input: {
  orderName: string;
  shop: string;
  diditSessionId: string;
  customerEmail: string;
}) {
  const html = `
    <p>Didit verification requires manual review.</p>
    <ul>
      <li>Shop: ${escapeHtml(input.shop)}</li>
      <li>Order: ${escapeHtml(input.orderName)}</li>
      <li>Customer: ${escapeHtml(input.customerEmail)}</li>
      <li>Didit session: ${escapeHtml(input.diditSessionId)}</li>
    </ul>
  `;

  await sendMail({
    from: env.MAIL_FROM,
    to: env.OPS_EMAIL,
    subject: `Manual review required: ${input.orderName}`,
    html
  });
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

async function sendMail(message: {
  from: string;
  to: string;
  subject: string;
  html: string;
}) {
  if (!transporter) {
    console.warn(`Email skipped (SMTP not configured): ${message.subject} -> ${message.to}`);
    return;
  }
  await transporter.sendMail(message);
}
