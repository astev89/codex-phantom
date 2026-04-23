import type { AppConfig } from "../config.ts";
import { HttpError } from "../server/validation.ts";
import type { ChannelRegistry } from "./registry.ts";
import type { ChannelDeliveryRecord, ChannelDeliveryStore } from "./delivery-log.ts";

export type SlackTransport = {
  sendMessage(input: { token: string; channel: string; text: string }): Promise<{ ok: boolean; ts?: string; error?: string }>;
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
    const result = await this.transport.sendMessage({
      token: this.config.slackBotToken,
      channel: input.channel,
      text: input.text
    });

    if (!result.ok || !result.ts) {
      const errorMessage = result.error ?? "Slack delivery failed";
      const delivery = this.deliveries.record({
        channelId: "slack",
        destination: input.channel,
        payload,
        status: "failed",
        response: result,
        errorMessage
      });
      throw new HttpError(502, errorMessage, { delivery });
    }

    const delivery = this.deliveries.record({
      channelId: "slack",
      destination: input.channel,
      payload,
      status: "delivered",
      response: result
    });

    return {
      delivery,
      result: { ts: result.ts }
    };
  }
}

class SlackApiTransport implements SlackTransport {
  async sendMessage(input: { token: string; channel: string; text: string }): Promise<{ ok: boolean; ts?: string; error?: string }> {
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
      return { ok: false, error: `Slack HTTP ${response.status}` };
    }

    const body = await response.json() as { ok: boolean; ts?: string; error?: string };
    return body;
  }
}
