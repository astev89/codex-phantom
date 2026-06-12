import type { JsonValue } from "../shared/types.ts";

export type OperatorExportFormat = "json" | "ndjson";
export type OperatorExportScope =
  | "requests"
  | "runs"
  | "channels"
  | "governance"
  | "mcp"
  | (string & {});
export type OperatorExportRecord = { [key: string]: JsonValue };
export type OperatorExportMetadata = Record<string, JsonValue>;

type OperatorExportOptions<T extends OperatorExportRecord> = {
  scope: OperatorExportScope;
  items: readonly T[];
  exportedAt?: string;
  meta?: OperatorExportMetadata;
};

type OperatorExportBase = {
  scope: OperatorExportScope;
  exportedAt: string;
  count: number;
  meta?: OperatorExportMetadata;
};

export type JsonExportPayload<T extends OperatorExportRecord> =
  OperatorExportBase & {
    format: "json";
    items: T[];
  };

export type NdjsonExportPayload = OperatorExportBase & {
  format: "ndjson";
  body: string;
};

export type OperatorExportPayload<T extends OperatorExportRecord> =
  | JsonExportPayload<T>
  | NdjsonExportPayload;

export type OperatorExportCollection = {
  items: OperatorExportRecord[];
};

type RequestAuditExportSource = {
  list(limit?: number): unknown[];
};

type ChannelDeliveryExportSource = {
  list(channelId?: string, limit?: number): unknown[];
};

type ChannelInboundExportSource = {
  list(options?: { channelId?: string; limit?: number }): unknown[];
};

type LimitedListExportSource = {
  list(limit?: number): unknown[];
};

type GovernanceExportSource = {
  listAudit(limit?: number): unknown[];
};

type SelfEvolutionExportSource = {
  list(limit?: number): unknown[];
  listMutations(proposalId?: string, limit?: number): unknown[];
};

type AutonomousMutationExportSource = {
  list(options?: { limit?: number }): unknown[];
};

type RunEventExportSource = {
  all(sql: string): unknown[];
};

type ChatArtifactExportSource = {
  listChatExportItems(limit?: number): Promise<unknown[]>;
};

export type OperatorExportServiceOptions = {
  requestAudits: RequestAuditExportSource;
  channelDeliveries: ChannelDeliveryExportSource;
  channelInbound: ChannelInboundExportSource;
  slackFeedback: LimitedListExportSource;
  governance: GovernanceExportSource;
  selfEvolution: SelfEvolutionExportSource;
  autonomousMutations: AutonomousMutationExportSource;
  toolBundles: LimitedListExportSource;
  mcpAudit: LimitedListExportSource;
  runEvents: RunEventExportSource;
  chatArtifacts: ChatArtifactExportSource;
  memoryMaintenance?: LimitedListExportSource;
};

const FULL_EXPORT_LIMIT = 250;
const TIMELINE_EXPORT_LIMIT = 50;

export class OperatorExportService {
  private readonly sources: OperatorExportServiceOptions;

  constructor(sources: OperatorExportServiceOptions) {
    this.sources = sources;
  }

  async collect(scope: string): Promise<OperatorExportCollection> {
    switch (scope) {
      case "requests":
        return {
          items: toExportRecords(
            this.sources.requestAudits.list(FULL_EXPORT_LIMIT)
          ),
        };
      case "channels":
        return {
          items: [
            ...toExportRecords(
              this.sources.channelDeliveries.list(undefined, FULL_EXPORT_LIMIT)
            ),
            ...toExportRecords(
              this.sources.channelInbound.list({ limit: FULL_EXPORT_LIMIT })
            ),
            ...toExportRecords(
              this.sources.slackFeedback.list(FULL_EXPORT_LIMIT)
            ),
          ],
        };
      case "governance":
        return this.collectGovernance(FULL_EXPORT_LIMIT);
      case "mcp":
        return {
          items: toExportRecords(this.sources.mcpAudit.list(FULL_EXPORT_LIMIT)),
        };
      case "runs":
        return {
          items: toExportRecords(
            this.sources.runEvents.all(
              `SELECT * FROM run_events ORDER BY created_at DESC LIMIT ${FULL_EXPORT_LIMIT}`
            )
          ),
        };
      case "chat":
        return {
          items: toExportRecords(
            await this.sources.chatArtifacts.listChatExportItems(
              FULL_EXPORT_LIMIT
            )
          ),
        };
      case "timeline":
      default:
        return this.collectTimeline();
    }
  }

  private collectGovernance(limit: number): OperatorExportCollection {
    return {
      items: [
        ...toExportRecords(this.sources.governance.listAudit(limit)),
        ...toExportRecords(this.sources.selfEvolution.list(limit)).map(
          (proposal) => ({
            ...proposal,
            kind: "self_evolution_proposal",
          })
        ),
        ...toExportRecords(
          this.sources.selfEvolution.listMutations(undefined, limit)
        ).map((mutation) => ({
          ...mutation,
          kind: "self_evolution_mutation",
        })),
        ...toExportRecords(
          this.sources.autonomousMutations.list({ limit })
        ).map((mutation) => ({
          ...mutation,
          kind: "autonomous_mutation",
        })),
        ...toExportRecords(this.sources.toolBundles.list(limit)).map(
          (importRecord) => ({
            ...importRecord,
            kind: "tool_bundle_import",
          })
        ),
      ],
    };
  }

  private collectTimeline(): OperatorExportCollection {
    const governance = this.collectGovernance(TIMELINE_EXPORT_LIMIT);
    return {
      items: [
        ...toExportRecords(
          this.sources.requestAudits.list(TIMELINE_EXPORT_LIMIT)
        ),
        ...toExportRecords(
          this.sources.channelDeliveries.list(undefined, TIMELINE_EXPORT_LIMIT)
        ),
        ...toExportRecords(
          this.sources.channelInbound.list({ limit: TIMELINE_EXPORT_LIMIT })
        ),
        ...toExportRecords(
          this.sources.slackFeedback.list(TIMELINE_EXPORT_LIMIT)
        ),
        ...toExportRecords(
          this.sources.memoryMaintenance?.list(TIMELINE_EXPORT_LIMIT) ?? []
        ),
        ...governance.items,
      ],
    };
  }
}

export function buildJsonExport<T extends OperatorExportRecord>(
  options: OperatorExportOptions<T>
): JsonExportPayload<T> {
  const items = [...options.items];

  return {
    scope: options.scope,
    format: "json",
    exportedAt: options.exportedAt ?? new Date().toISOString(),
    count: items.length,
    meta: options.meta,
    items,
  };
}

export function buildNdjsonExport<T extends OperatorExportRecord>(
  options: OperatorExportOptions<T>
): NdjsonExportPayload {
  const items = [...options.items];

  return {
    scope: options.scope,
    format: "ndjson",
    exportedAt: options.exportedAt ?? new Date().toISOString(),
    count: items.length,
    meta: options.meta,
    body: items.map((item) => JSON.stringify(item)).join("\n"),
  };
}

export function buildOperatorExport<T extends OperatorExportRecord>(
  format: OperatorExportFormat,
  options: OperatorExportOptions<T>
): OperatorExportPayload<T> {
  return format === "json"
    ? buildJsonExport(options)
    : buildNdjsonExport(options);
}

function toExportRecords(items: readonly unknown[]): OperatorExportRecord[] {
  return items as OperatorExportRecord[];
}
