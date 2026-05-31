#!/usr/bin/env node
import crypto from "node:crypto";

const options = parseArgs(process.argv.slice(2));
const baseUrl = trimTrailingSlash(
  options["base-url"] ?? process.env.BASE_URL ?? process.env.PHANTOM_BASE_URL
);
const channel =
  options.channel ??
  process.env.SLACK_SMOKE_CHANNEL_ID ??
  process.env.SLACK_CHANNEL_ID;
const signingSecret =
  options["signing-secret"] ?? process.env.SLACK_SIGNING_SECRET;
const operatorToken =
  options["operator-token"] ??
  process.env.OPERATOR_BEARER_TOKEN ??
  "local-dev-operator-token";
const botUserId =
  options["bot-user-id"] ??
  process.env.SLACK_SMOKE_BOT_USER_ID ??
  process.env.SLACK_BOT_USER_ID ??
  "B999";
const sourceUserId =
  options["source-user-id"] ??
  process.env.SLACK_SMOKE_USER_ID ??
  "U_CLOUDFLARE_SMOKE";
const timeoutMs = Number(
  options["timeout-ms"] ??
    options.timeoutMs ??
    process.env.SLACK_SMOKE_TIMEOUT_MS ??
    30_000
);
const intervalMs = Number(
  options["interval-ms"] ??
    options.intervalMs ??
    process.env.SLACK_SMOKE_INTERVAL_MS ??
    1_000
);
const text =
  options.text ??
  process.env.SLACK_SMOKE_TEXT ??
  "Cloudflare tunnel live smoke check. Reply with a short confirmation.";

if (!baseUrl) {
  fail("Set BASE_URL or pass --base-url with the public Phantom base URL.");
}
if (!channel) {
  fail("Set SLACK_SMOKE_CHANNEL_ID or pass --channel with a Slack channel id.");
}
if (!signingSecret) {
  fail("Set SLACK_SIGNING_SECRET or pass --signing-secret.");
}
if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
  fail("SLACK_SMOKE_TIMEOUT_MS must be a positive number.");
}
if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
  fail("SLACK_SMOKE_INTERVAL_MS must be a positive number.");
}

const eventId = `EvSmoke${Date.now()}`;
const eventTs = `${Math.floor(Date.now() / 1000)}.000200`;
const body = JSON.stringify({
  type: "event_callback",
  event_id: eventId,
  event: {
    type: "app_mention",
    user: sourceUserId,
    channel,
    text: `<@${botUserId}> ${text}`,
    ts: eventTs,
    thread_ts: eventTs,
  },
});

const eventResponse = await fetch(`${baseUrl}/channels/slack/events`, {
  method: "POST",
  headers: signedHeaders(body, signingSecret),
  body,
});
const accepted = await readJsonResponse(eventResponse, "Slack event request");
console.log(JSON.stringify({ eventStatus: eventResponse.status, accepted }));

if (eventResponse.status !== 202) {
  process.exit(1);
}

const deadline = Date.now() + timeoutMs;
while (Date.now() < deadline) {
  await delay(intervalMs);
  const inboundResponse = await fetch(
    `${baseUrl}/admin/channels/inbound?channelId=slack`,
    {
      headers: { authorization: `Bearer ${operatorToken}` },
    }
  );
  const inbound = await readJsonResponse(
    inboundResponse,
    "Inbound status request"
  );
  if (!inboundResponse.ok) {
    fail(
      `Inbound status request failed (${inboundResponse.status}): ${previewBody(
        JSON.stringify(inbound)
      )}`
    );
  }
  const record = inbound.events?.find(
    (event) => event.providerEventId === eventId
  );
  if (record?.status === "completed" || record?.status === "failed") {
    console.log(
      JSON.stringify({
        inboundStatus: inboundResponse.status,
        record: {
          id: record.id,
          providerEventId: record.providerEventId,
          status: record.status,
          runId: record.runId,
          outputText: record.outputText,
          slackResponseMessageTs: record.slackResponseMessageTs,
        },
      })
    );
    if (record.status === "failed") {
      process.exit(1);
    }
    if (!record.slackResponseMessageTs) {
      fail("Inbound completed without a Slack response message timestamp.");
    }
    process.exit(0);
  }
}

console.log(
  JSON.stringify({ error: "timed out waiting for inbound completion", eventId })
);
process.exit(1);

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

function signedHeaders(body, secret) {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signature =
    "v0=" +
    crypto
      .createHmac("sha256", secret)
      .update(`v0:${timestamp}:${body}`)
      .digest("hex");
  return {
    "content-type": "application/json",
    "x-slack-request-timestamp": timestamp,
    "x-slack-signature": signature,
  };
}

function trimTrailingSlash(value) {
  return value?.replace(/\/+$/, "");
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readJsonResponse(response, label) {
  const responseText = await response.text();
  try {
    return responseText ? JSON.parse(responseText) : null;
  } catch {
    fail(
      `${label} returned non-JSON response (${response.status}): ${previewBody(
        responseText
      )}`
    );
  }
}

function previewBody(value) {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > 500
    ? `${normalized.slice(0, 500)}...`
    : normalized;
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
