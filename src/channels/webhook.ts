import { createHmac, timingSafeEqual } from "node:crypto";
import type { SubagentRequest } from "../orchestration/types.ts";

export type WebhookPayload = {
  conversationId: string;
  message: string;
  subagents?: SubagentRequest[];
};

const MAX_WEBHOOK_CLOCK_SKEW_MS = 5 * 60 * 1000;

export function validateWebhookSecret(
  request: Request,
  expected: string,
  rawBody: string,
  now = Date.now()
): boolean {
  const timestamp = request.headers.get("x-channel-timestamp");
  const signature = request.headers.get("x-channel-signature");
  if (!timestamp || !signature?.startsWith("sha256=")) {
    return false;
  }

  const timestampMs = Number(timestamp) * 1000;
  if (!Number.isFinite(timestampMs) || Math.abs(now - timestampMs) > MAX_WEBHOOK_CLOCK_SKEW_MS) {
    return false;
  }

  const expectedSignature = `sha256=${createHmac("sha256", expected).update(`${timestamp}.${rawBody}`).digest("hex")}`;
  const expectedBuffer = Buffer.from(expectedSignature);
  const actualBuffer = Buffer.from(signature);
  return expectedBuffer.length === actualBuffer.length && timingSafeEqual(expectedBuffer, actualBuffer);
}
