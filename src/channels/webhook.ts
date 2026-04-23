import type { SubagentRequest } from "../orchestration/types.ts";

export type WebhookPayload = {
  conversationId: string;
  message: string;
  subagents?: SubagentRequest[];
};

export function validateWebhookSecret(request: Request, expected: string): boolean {
  return request.headers.get("x-channel-secret") === expected;
}
