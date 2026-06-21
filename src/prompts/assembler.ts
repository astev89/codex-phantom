import type { AppConfig } from "../config.ts";
import type { PromptManagedFragmentRecord } from "./runtime-guidance.ts";
import type { MemoryContextEnvelope } from "../shared/types.ts";

export function assemblePrompt(
  config: AppConfig,
  memory: MemoryContextEnvelope,
  runtimeGuidanceText = "",
  managedFragments: PromptManagedFragmentRecord[] = []
): string {
  const sections = [
    buildIdentitySection(config),
    buildEnvironmentSection(config),
    buildRoleSection(),
    buildLearnedBehaviorSection(),
    buildRuntimeGuidanceSection(runtimeGuidanceText),
    buildManagedFragmentsSection(managedFragments),
    buildSafetySection(),
    buildToolingSection(),
    buildMemorySection(memory),
  ].filter((section): section is string => section !== null);

  return sections.join("\n\n");
}

function buildIdentitySection(config: AppConfig): string {
  return [
    `You are ${config.agentName}, a Codex-native autonomous co-worker running on a dedicated machine.`,
    "You are durable, stateful, and expected to make concrete progress instead of offering generic advice.",
  ].join("\n");
}

function buildEnvironmentSection(config: AppConfig): string {
  return [
    "# Environment",
    `Model target: ${config.model}`,
    "You operate through tools, memory, scheduling, and MCP integrations.",
    "Assume the host process persists session state and can resume prior context when supported.",
  ].join("\n");
}

function buildRoleSection(): string {
  return [
    "# Role",
    "Use subagents only for bounded, parallelizable work.",
    "When delegating, give explicit objectives, scoped permissions, and a clear output contract.",
  ].join("\n");
}

function buildLearnedBehaviorSection(): string {
  return [
    "# Learned Behavior",
    "Prefer direct action over vague advice.",
    "Surface uncertainty clearly and keep outputs grounded in the available evidence.",
  ].join("\n");
}

function buildRuntimeGuidanceSection(
  runtimeGuidanceText: string
): string | null {
  const text = runtimeGuidanceText.trim();
  return text ? ["# Runtime Guidance Overlay", text].join("\n") : null;
}

function buildManagedFragmentsSection(
  fragments: PromptManagedFragmentRecord[]
): string | null {
  const activeFragments = fragments
    .filter((fragment) => fragment.active && fragment.text.trim())
    .sort((left, right) => left.id.localeCompare(right.id));
  if (activeFragments.length === 0) {
    return null;
  }
  return [
    "# Managed Prompt Fragments",
    activeFragments
      .map(
        (fragment) =>
          `## ${formatManagedFragmentHeadingId(fragment.id)}\n${fragment.text.trim()}`
      )
      .join("\n\n"),
  ].join("\n");
}

function formatManagedFragmentHeadingId(id: string): string {
  const safe = id.trim().replace(/[^A-Za-z0-9._-]+/g, "_");
  return safe || "legacy-fragment";
}

function buildSafetySection(): string {
  return [
    "# Safety",
    "Never use tools or files outside the assigned permission policy.",
    "Treat tool and MCP allowlists as hard constraints.",
  ].join("\n");
}

function buildToolingSection(): string {
  return [
    "# Tooling",
    "Summarize tool usage clearly.",
    "If a tool call is required but blocked or unavailable, say so explicitly.",
  ].join("\n");
}

function buildMemorySection(memory: MemoryContextEnvelope): string {
  const render = (
    label: string,
    values: MemoryContextEnvelope[keyof MemoryContextEnvelope]
  ): string =>
    `${label}: ${values.length > 0 ? values.map((value) => value.content).join(" | ") : "none"}`;

  return [
    "Memory Context",
    render("Summaries", memory.summaries),
    render("Episodic", memory.episodic),
    render("Semantic", memory.semantic),
    render("Procedural", memory.procedural),
  ].join("\n");
}
