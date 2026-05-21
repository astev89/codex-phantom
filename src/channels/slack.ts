import type { AppConfig } from "../config.ts";
import { HttpError } from "../server/validation.ts";
import type { JsonValue } from "../shared/types.ts";
import type { ChannelRegistry } from "./registry.ts";
import type {
  ChannelDeliveryRecord,
  ChannelDeliveryStore,
} from "./delivery-log.ts";

export type SlackBlock = Record<string, JsonValue>;

type SlackApiResult = {
  ok: boolean;
  ts?: string;
  error?: string;
  statusCode?: number;
  retryAfterMs?: number;
};

export type SlackTransport = {
  sendMessage(input: {
    token: string;
    channel: string;
    text: string;
    threadTs?: string;
    blocks?: SlackBlock[];
  }): Promise<SlackApiResult>;
  updateMessage(input: {
    token: string;
    channel: string;
    ts: string;
    text: string;
    blocks?: SlackBlock[];
  }): Promise<SlackApiResult>;
  addReaction(input: {
    token: string;
    channel: string;
    timestamp: string;
    name: string;
  }): Promise<SlackApiResult>;
  removeReaction(input: {
    token: string;
    channel: string;
    timestamp: string;
    name: string;
  }): Promise<SlackApiResult>;
};

export class SlackChannel {
  private readonly config: AppConfig;
  private readonly channels: ChannelRegistry;
  private readonly deliveries: ChannelDeliveryStore;
  private readonly transport: SlackTransport;

  constructor(
    config: AppConfig,
    channels: ChannelRegistry,
    deliveries: ChannelDeliveryStore,
    transport: SlackTransport = new SlackApiTransport()
  ) {
    this.config = config;
    this.channels = channels;
    this.deliveries = deliveries;
    this.transport = transport;
  }

  async sendMessage(input: {
    channel: string;
    text: string;
    threadTs?: string;
    blocks?: SlackBlock[];
  }): Promise<{
    delivery: ChannelDeliveryRecord;
    result: { ts: string };
  }> {
    const payload: Record<string, JsonValue> = {
      method: "chat.postMessage",
      channel: input.channel,
      text: input.text,
    };
    if (input.threadTs) {
      payload.threadTs = input.threadTs;
      payload.thread_ts = input.threadTs;
    }
    if (input.blocks) {
      payload.blocks = input.blocks;
    }
    const delivered = await this.deliver(
      input.channel,
      payload,
      (token) =>
        this.transport.sendMessage({
          token,
          channel: input.channel,
          text: input.text,
          threadTs: input.threadTs,
          blocks: input.blocks,
        }),
      (result) => Boolean(result.ts)
    );

    return {
      delivery: delivered.delivery,
      result: { ts: delivered.result.ts! },
    };
  }

  async updateMessage(input: {
    channel: string;
    ts: string;
    text: string;
    blocks?: SlackBlock[];
  }): Promise<{ delivery: ChannelDeliveryRecord; result: { ts: string } }> {
    const payload: Record<string, JsonValue> = {
      method: "chat.update",
      channel: input.channel,
      ts: input.ts,
      text: input.text,
    };
    if (input.blocks) {
      payload.blocks = input.blocks;
    }
    const delivered = await this.deliver(
      input.channel,
      payload,
      (token) =>
        this.transport.updateMessage({
          token,
          channel: input.channel,
          ts: input.ts,
          text: input.text,
          blocks: input.blocks,
        }),
      () => true
    );
    return {
      delivery: delivered.delivery,
      result: { ts: delivered.result.ts ?? input.ts },
    };
  }

  async addReaction(input: {
    channel: string;
    timestamp: string;
    name: string;
  }): Promise<{ delivery: ChannelDeliveryRecord }> {
    const delivered = await this.deliver(
      input.channel,
      {
        method: "reactions.add",
        channel: input.channel,
        timestamp: input.timestamp,
        name: input.name,
      },
      (token) =>
        this.transport.addReaction({
          token,
          channel: input.channel,
          timestamp: input.timestamp,
          name: input.name,
        }),
      () => true
    );
    return { delivery: delivered.delivery };
  }

  async removeReaction(input: {
    channel: string;
    timestamp: string;
    name: string;
  }): Promise<{ delivery: ChannelDeliveryRecord }> {
    const delivered = await this.deliver(
      input.channel,
      {
        method: "reactions.remove",
        channel: input.channel,
        timestamp: input.timestamp,
        name: input.name,
      },
      (token) =>
        this.transport.removeReaction({
          token,
          channel: input.channel,
          timestamp: input.timestamp,
          name: input.name,
        }),
      () => true
    );
    return { delivery: delivered.delivery };
  }

  private async deliver(
    destination: string,
    payload: Record<string, JsonValue>,
    call: (token: string) => Promise<SlackApiResult>,
    isComplete: (result: SlackApiResult) => boolean
  ): Promise<{ delivery: ChannelDeliveryRecord; result: SlackApiResult }> {
    const channelRecord = this.channels.get("slack");
    if (!channelRecord || !channelRecord.enabled) {
      throw new HttpError(409, "Slack channel is not enabled");
    }
    if (!this.config.slackBotToken) {
      throw new HttpError(
        412,
        "SLACK_BOT_TOKEN is required for Slack delivery"
      );
    }

    let result: SlackApiResult = {
      ok: false,
      error: "Slack delivery was not attempted",
    };
    let attemptCount = 0;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      attemptCount = attempt;
      result = await call(this.config.slackBotToken);
      if (result.ok && isComplete(result)) {
        break;
      }
      if (attempt === 3 || !isRetryableSlackResult(result)) {
        break;
      }
      await sleep(Math.min(result.retryAfterMs ?? attempt * 100, 1_000));
    }

    if (!result.ok || !isComplete(result)) {
      const errorMessage = result.error ?? "Slack delivery failed";
      const delivery = this.deliveries.record({
        channelId: "slack",
        destination,
        payload,
        status: "failed",
        response: result,
        errorMessage,
        attemptCount,
      });
      throw new HttpError(502, errorMessage, { delivery });
    }

    const delivery = this.deliveries.record({
      channelId: "slack",
      destination,
      payload,
      status: "delivered",
      response: result,
      attemptCount,
    });

    return { delivery, result };
  }
}

function isRetryableSlackResult(result: {
  ok: boolean;
  statusCode?: number;
}): boolean {
  return (
    result.statusCode === 429 ||
    (result.statusCode !== undefined && result.statusCode >= 500)
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class SlackApiTransport implements SlackTransport {
  async sendMessage(input: {
    token: string;
    channel: string;
    text: string;
    threadTs?: string;
    blocks?: SlackBlock[];
  }): Promise<SlackApiResult> {
    return slackApiCall(input.token, "chat.postMessage", {
      channel: input.channel,
      text: input.text,
      thread_ts: input.threadTs,
      blocks: input.blocks,
    });
  }

  async updateMessage(input: {
    token: string;
    channel: string;
    ts: string;
    text: string;
    blocks?: SlackBlock[];
  }): Promise<SlackApiResult> {
    return slackApiCall(input.token, "chat.update", {
      channel: input.channel,
      ts: input.ts,
      text: input.text,
      blocks: input.blocks,
    });
  }

  async addReaction(input: {
    token: string;
    channel: string;
    timestamp: string;
    name: string;
  }): Promise<SlackApiResult> {
    return slackApiCall(input.token, "reactions.add", {
      channel: input.channel,
      timestamp: input.timestamp,
      name: input.name,
    });
  }

  async removeReaction(input: {
    token: string;
    channel: string;
    timestamp: string;
    name: string;
  }): Promise<SlackApiResult> {
    return slackApiCall(input.token, "reactions.remove", {
      channel: input.channel,
      timestamp: input.timestamp,
      name: input.name,
    });
  }
}

async function slackApiCall(
  token: string,
  method: string,
  payload: Record<string, unknown>
): Promise<SlackApiResult> {
  const response = await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const retryAfter = response.headers.get("retry-after");
    return {
      ok: false,
      error: `Slack HTTP ${response.status}`,
      statusCode: response.status,
      retryAfterMs: retryAfter ? Number(retryAfter) * 1000 : undefined,
    };
  }

  const body = (await response.json()) as SlackApiResult;
  return { ...body, statusCode: 200 };
}
