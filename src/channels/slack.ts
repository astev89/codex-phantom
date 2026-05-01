import type { AppConfig } from "../config.ts";
import { HttpError } from "../server/validation.ts";
import type { ChannelRegistry } from "./registry.ts";
import type { ChannelDeliveryRecord, ChannelDeliveryStore } from "./delivery-log.ts";

export type SlackTransport = {
  sendMessage(input: { token: string; channel: string; text: string }): Promise<{
    ok: boolean;
    ts?: string;
    error?: string;
    statusCode?: number;
    retryAfterMs?: number;
  }>;
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

  async sendMessage(input: { channel: string; text: string }): Promise<{
    delivery: ChannelDeliveryRecord;
    result: { ts: string };
  }> {
    const channelRecord = this.channels.get("slack");
    if (!channelRecord || !channelRecord.enabled) {
      throw new HttpError(409, "Slack channel is not enabled");
    }
    if (!this.config.slackBotToken) {
      throw new HttpError(412, "SLACK_BOT_TOKEN is required for Slack delivery");
    }

    const payload = { channel: input.channel, text: input.text };
    let result: Awaited<ReturnType<SlackTransport["sendMessage"]>> = { ok: false, error: "Slack delivery was not attempted" };
    let attemptCount = 0;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      attemptCount = attempt;
      result = await this.transport.sendMessage({
        token: this.config.slackBotToken,
        channel: input.channel,
        text: input.text
      });
      if (result.ok && result.ts) {
        break;
      }
      if (attempt === 3 || !isRetryableSlackResult(result)) {
        break;
      }
      await sleep(Math.min(result.retryAfterMs ?? attempt * 100, 1_000));
    }

    if (!result.ok || !result.ts) {
      const errorMessage = result.error ?? "Slack delivery failed";
      const delivery = this.deliveries.record({
        channelId: "slack",
        destination: input.channel,
        payload,
        status: "failed",
        response: result,
        errorMessage,
        attemptCount
      });
      throw new HttpError(502, errorMessage, { delivery });
    }

    const delivery = this.deliveries.record({
      channelId: "slack",
      destination: input.channel,
      payload,
      status: "delivered",
      response: result,
      attemptCount
    });

    return {
      delivery,
      result: { ts: result.ts }
    };
  }
}

function isRetryableSlackResult(result: { ok: boolean; statusCode?: number }): boolean {
  return result.statusCode === 429 || (result.statusCode !== undefined && result.statusCode >= 500);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class SlackApiTransport implements SlackTransport {
  async sendMessage(input: { token: string; channel: string; text: string }): Promise<{
    ok: boolean;
    ts?: string;
    error?: string;
    statusCode?: number;
    retryAfterMs?: number;
  }> {
    const response = await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        Authorization: `Bearer ${input.token}`
      },
      body: JSON.stringify({
        channel: input.channel,
        text: input.text
      })
    });

    if (!response.ok) {
      const retryAfter = response.headers.get("retry-after");
      return {
        ok: false,
        error: `Slack HTTP ${response.status}`,
        statusCode: response.status,
        retryAfterMs: retryAfter ? Number(retryAfter) * 1000 : undefined
      };
    }

    const body = await response.json() as { ok: boolean; ts?: string; error?: string };
    return { ...body, statusCode: 200 };
  }
}
