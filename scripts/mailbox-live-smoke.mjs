#!/usr/bin/env node
import { createRequire } from "node:module";
import { ImapFlow } from "imapflow";

const require = createRequire(import.meta.url);
const nodemailer = require("nodemailer");

const options = parseArgs(process.argv.slice(2));
const mailbox = options.mailbox ?? process.env.EMAIL_SMOKE_MAILBOX ?? "INBOX";
const toAddress = options.to ?? process.env.EMAIL_SMOKE_TO_ADDRESS;
const timeoutMs = positiveInteger(
  options["timeout-ms"] ?? process.env.EMAIL_SMOKE_TIMEOUT_MS,
  10_000,
  "EMAIL_SMOKE_TIMEOUT_MS"
);

const requiredCredentialVars = [
  "EMAIL_IMAP_HOST",
  "EMAIL_IMAP_USERNAME",
  "EMAIL_IMAP_PASSWORD",
  "EMAIL_SMTP_HOST",
  "EMAIL_SMTP_USERNAME",
  "EMAIL_SMTP_PASSWORD",
  "EMAIL_FROM_ADDRESS",
];
const missingCredentials = requiredCredentialVars.filter(
  (name) => !hasValue(process.env[name])
);

if (missingCredentials.length > 0) {
  emit({
    status: "skipped",
    reason: "missing_credentials",
    missing: missingCredentials,
  });
  process.exit(0);
}

if (!hasValue(toAddress)) {
  emit({
    status: "skipped",
    reason: "missing_recipient",
    missing: ["EMAIL_SMOKE_TO_ADDRESS"],
    message:
      "Set EMAIL_SMOKE_TO_ADDRESS or pass --to with a non-runtime mailbox before sending a live SMTP probe.",
  });
  process.exit(0);
}

const startedAt = new Date().toISOString();
try {
  const imap = await verifyImap({ mailbox, timeoutMs });
  const smtp = await sendSmtpProbe({ toAddress, timeoutMs });
  emit({
    status: "passed",
    startedAt,
    completedAt: new Date().toISOString(),
    imap,
    smtp,
  });
} catch (error) {
  emit({
    status: "failed",
    startedAt,
    completedAt: new Date().toISOString(),
    error: error instanceof Error ? error.message : String(error),
  });
  process.exit(1);
}

async function verifyImap(input) {
  const client = new ImapFlow({
    host: requiredEnv("EMAIL_IMAP_HOST"),
    port: positiveInteger(process.env.EMAIL_IMAP_PORT, 993, "EMAIL_IMAP_PORT"),
    secure: booleanEnv(process.env.EMAIL_IMAP_TLS, true),
    auth: {
      user: requiredEnv("EMAIL_IMAP_USERNAME"),
      pass: requiredEnv("EMAIL_IMAP_PASSWORD"),
    },
    connectionTimeout: input.timeoutMs,
    greetingTimeout: input.timeoutMs,
    socketTimeout: input.timeoutMs,
    logger: false,
  });
  try {
    await client.connect();
    const status = await client.status(input.mailbox, {
      messages: true,
      unseen: true,
      uidNext: true,
    });
    return {
      mailbox: input.mailbox,
      messages: numberOrNull(status.messages),
      unseen: numberOrNull(status.unseen),
      uidNext: numberOrNull(status.uidNext),
    };
  } finally {
    await client.logout().catch(() => undefined);
  }
}

async function sendSmtpProbe(input) {
  const transporter = nodemailer.createTransport({
    host: requiredEnv("EMAIL_SMTP_HOST"),
    port: positiveInteger(process.env.EMAIL_SMTP_PORT, 587, "EMAIL_SMTP_PORT"),
    secure: booleanEnv(process.env.EMAIL_SMTP_TLS, true),
    auth: {
      user: requiredEnv("EMAIL_SMTP_USERNAME"),
      pass: requiredEnv("EMAIL_SMTP_PASSWORD"),
    },
    connectionTimeout: input.timeoutMs,
    greetingTimeout: input.timeoutMs,
    socketTimeout: input.timeoutMs,
  });
  try {
    const sentAt = new Date().toISOString();
    const result = await transporter.sendMail({
      from: formatFrom(
        process.env.EMAIL_FROM_NAME ?? "Codex Phantom",
        requiredEnv("EMAIL_FROM_ADDRESS")
      ),
      to: input.toAddress,
      subject: `Codex Phantom mailbox live smoke ${sentAt}`,
      text: [
        "Codex Phantom mailbox live smoke.",
        `Sent at: ${sentAt}`,
        "This message verifies SMTP submission for the configured runtime mailbox.",
      ].join("\n"),
    });
    return {
      to: input.toAddress,
      acceptedCount: Array.isArray(result.accepted) ? result.accepted.length : 0,
      rejectedCount: Array.isArray(result.rejected) ? result.rejected.length : 0,
      response: typeof result.response === "string" ? result.response : null,
      messageId: typeof result.messageId === "string" ? result.messageId : null,
    };
  } finally {
    transporter.close?.();
  }
}

function parseArgs(args) {
  const parsed = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith("--")) {
      continue;
    }
    const [key, inlineValue] = arg.slice(2).split("=", 2);
    if (inlineValue !== undefined) {
      parsed[key] = inlineValue;
      continue;
    }
    parsed[key] = args[index + 1];
    index += 1;
  }
  return parsed;
}

function emit(value) {
  console.log(JSON.stringify(value));
}

function requiredEnv(name) {
  const value = process.env[name];
  if (!hasValue(value)) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function hasValue(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function booleanEnv(value, defaultValue) {
  if (!hasValue(value)) {
    return defaultValue;
  }
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  throw new Error(`Boolean environment value must be true or false`);
}

function positiveInteger(value, defaultValue, name) {
  if (!hasValue(value)) {
    return defaultValue;
  }
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return number;
}

function numberOrNull(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function formatFrom(name, address) {
  return `${name.replace(/[<>]/g, "").trim()} <${address}>`;
}
