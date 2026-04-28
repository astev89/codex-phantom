import type { AppConfig } from "../config.ts";
import { fetchWithTimeout } from "../platform/outbound.ts";

export type EmbeddingService = {
  readonly enabled: boolean;
  readonly model: string;
  embed(texts: string[]): Promise<number[][] | null>;
};

export class OpenAiEmbeddingService implements EmbeddingService {
  readonly enabled: boolean;
  readonly model: string;
  private readonly apiKey?: string;
  private readonly baseUrl?: string;
  private readonly timeoutMs: number;

  constructor(config: AppConfig) {
    this.enabled = config.semanticRetrievalEnabled && Boolean(config.openAiApiKey);
    this.model = config.openAiEmbeddingModel;
    this.apiKey = config.openAiApiKey;
    this.baseUrl = config.openAiBaseUrl;
    this.timeoutMs = config.openAiEmbeddingTimeoutMs ?? 10_000;
  }

  async embed(texts: string[]): Promise<number[][] | null> {
    if (!this.enabled || texts.length === 0) {
      return null;
    }

    const response = await fetchWithTimeout(`${this.baseUrl ?? "https://api.openai.com/v1"}/embeddings`, {
      method: "POST",
      timeoutMs: this.timeoutMs,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`
      },
      body: JSON.stringify({
        model: this.model,
        input: texts
      })
    });

    if (!response.ok) {
      throw new Error(`OpenAI embedding request failed with status ${response.status}`);
    }

    const json = await response.json() as { data?: Array<{ embedding?: number[] }> };
    return (json.data ?? []).map((item) => item.embedding ?? []);
  }
}
