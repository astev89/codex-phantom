import type { AgentRunEvent } from "../agent/types.ts";
import type { JsonValue } from "../shared/types.ts";

export type ChatWireEventType =
  | "request.started"
  | "agent.event"
  | "assignment.created"
  | "run.completed"
  | "request.completed"
  | "request.failed";

export type ChatWireEvent = {
  version: 1;
  type: ChatWireEventType;
  requestId: string;
  sessionId?: string;
  runId?: string;
  sequence: number;
  createdAt: string;
  payload: JsonValue;
  rawEvent?: AgentRunEvent;
};

export class ChatWireEventBuilder {
  private readonly requestId: string;
  private sequence = 0;

  constructor(requestId: string) {
    this.requestId = requestId;
  }

  build(
    type: ChatWireEventType,
    payload: JsonValue,
    options: {
      sessionId?: string;
      runId?: string;
      rawEvent?: AgentRunEvent;
    } = {}
  ): ChatWireEvent {
    this.sequence += 1;
    return {
      version: 1,
      type,
      requestId: this.requestId,
      sessionId: options.sessionId,
      runId: options.runId,
      sequence: this.sequence,
      createdAt: new Date().toISOString(),
      payload,
      rawEvent: options.rawEvent,
    };
  }
}

export function formatSseEvent(event: ChatWireEvent): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}
