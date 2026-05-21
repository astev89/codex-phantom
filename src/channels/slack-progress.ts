import type { AgentRunEvent } from "../agent/types.ts";
import type {
  InboundChannelEventStore,
  InboundResponseTarget,
} from "./inbound.ts";
import type { SlackChannel } from "./slack.ts";

type SlackThreadTarget = Extract<
  InboundResponseTarget,
  { type: "slack_thread" }
>;

const QUEUED_REACTION = "hourglass";
const RUNNING_REACTION = "hourglass_flowing_sand";
const COMPLETED_REACTION = "white_check_mark";
const FAILED_REACTION = "x";

export class SlackProgressReporter {
  private readonly slack: SlackChannel;
  private readonly store: InboundChannelEventStore;
  private readonly recordId: string;
  private readonly target: SlackThreadTarget;
  private progressMessageTs?: string;
  private activeReaction?: string;
  private lastUpdateAt = 0;

  constructor(input: {
    slack: SlackChannel;
    store: InboundChannelEventStore;
    recordId: string;
    target: SlackThreadTarget;
  }) {
    this.slack = input.slack;
    this.store = input.store;
    this.recordId = input.recordId;
    this.target = input.target;
  }

  async queued(): Promise<void> {
    await this.recordSideEffect("queued", "Queued Slack run", async () => {
      const posted = await this.slack.sendMessage({
        channel: this.target.channel,
        threadTs: this.target.threadTs,
        text: "Queued...",
      });
      this.progressMessageTs = posted.result.ts;
      await this.transitionReaction(QUEUED_REACTION);
      this.store.recordProgress(this.recordId, {
        state: "queued",
        messageTs: this.progressMessageTs,
        statusReaction: QUEUED_REACTION,
        summary: "Queued Slack run",
      });
    });
  }

  async onEvent(event: AgentRunEvent): Promise<void> {
    const summary = eventSummary(event);
    if (!summary) {
      return;
    }
    const now = Date.now();
    if (now - this.lastUpdateAt < 750) {
      return;
    }
    this.lastUpdateAt = now;
    await this.recordSideEffect("running", summary, async () => {
      await this.transitionReaction(RUNNING_REACTION);
      await this.updateProgressMessage(summary);
      this.store.recordProgress(this.recordId, {
        state: "running",
        messageTs: this.progressMessageTs,
        statusReaction: RUNNING_REACTION,
        summary,
      });
    });
  }

  async completed(outputText: string): Promise<void> {
    await this.recordSideEffect(
      "completed",
      "Completed Slack run",
      async () => {
        await this.transitionReaction(COMPLETED_REACTION);
        await this.updateProgressMessage(`Completed: ${truncate(outputText)}`);
        this.store.recordProgress(this.recordId, {
          state: "completed",
          messageTs: this.progressMessageTs,
          statusReaction: COMPLETED_REACTION,
          summary: "Completed Slack run",
        });
      }
    );
  }

  async failed(message: string): Promise<void> {
    await this.recordSideEffect(
      "failed",
      `Failed Slack run: ${truncate(message)}`,
      async () => {
        await this.transitionReaction(FAILED_REACTION);
        await this.updateProgressMessage(`Failed: ${truncate(message)}`);
        this.store.recordProgress(this.recordId, {
          state: "failed",
          messageTs: this.progressMessageTs,
          statusReaction: FAILED_REACTION,
          summary: `Failed Slack run: ${truncate(message)}`,
        });
      }
    );
  }

  private async updateProgressMessage(text: string): Promise<void> {
    if (!this.progressMessageTs) {
      const posted = await this.slack.sendMessage({
        channel: this.target.channel,
        threadTs: this.target.threadTs,
        text,
      });
      this.progressMessageTs = posted.result.ts;
      return;
    }
    await this.slack.updateMessage({
      channel: this.target.channel,
      ts: this.progressMessageTs,
      text,
    });
  }

  private async transitionReaction(next: string): Promise<void> {
    const timestamp = this.target.messageTs ?? this.target.threadTs;
    if (this.activeReaction && this.activeReaction !== next) {
      await this.slack.removeReaction({
        channel: this.target.channel,
        timestamp,
        name: this.activeReaction,
      });
    }
    if (this.activeReaction !== next) {
      await this.slack.addReaction({
        channel: this.target.channel,
        timestamp,
        name: next,
      });
      this.activeReaction = next;
    }
  }

  private async recordSideEffect(
    state: "queued" | "running" | "completed" | "failed",
    summary: string,
    work: () => Promise<void>
  ): Promise<void> {
    try {
      await work();
    } catch (error) {
      this.store.recordProgress(this.recordId, {
        state,
        messageTs: this.progressMessageTs,
        statusReaction: this.activeReaction,
        summary: `${summary}; Slack side effect failed: ${error instanceof Error ? error.message : "unknown error"}`,
      });
    }
  }
}

function eventSummary(event: AgentRunEvent): string | undefined {
  switch (event.type) {
    case "init":
      return "Running coordinator...";
    case "tool_call_started":
      return `Running tool: ${event.toolName ?? event.toolCallId}`;
    case "subagent_progress":
      return `Subagent ${event.status}: ${event.summary}`;
    case "warning":
      return `Warning: ${event.message}`;
    case "error":
      return `Error: ${event.message}`;
    default:
      return undefined;
  }
}

function truncate(value: string, maxLength = 180): string {
  return value.length > maxLength
    ? `${value.slice(0, maxLength - 1)}...`
    : value;
}
