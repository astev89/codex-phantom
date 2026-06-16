import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AutonomousMutationAdapter,
  AutonomousMutationExecutionError,
  AutonomousMutationExecutor,
} from "../src/assignments/autonomous-mutations.ts";
import { AutonomousMutationLedger } from "../src/assignments/mutation-ledger.ts";
import { AutonomousAssignmentService } from "../src/assignments/service.ts";
import {
  RuntimeConfigLimitsStore,
  runtimeConfigLimitValues,
} from "../src/config/runtime-limits.ts";
import { MemoryPolicyStore, memoryPolicyValues } from "../src/memory/policy.ts";
import { loadRolePolicyConfig } from "../src/orchestration/role-config.ts";
import {
  RolePolicyRuntimeStore,
  rolePolicyRuntimeSnapshot,
} from "../src/orchestration/role-policy-runtime.ts";
import { AppDatabase } from "../src/platform/database.ts";
import { ProjectFileDraftStore } from "../src/project-files/drafts.ts";
import { PromptRuntimeGuidanceStore } from "../src/prompts/runtime-guidance.ts";
import { OperatorSettingsStore } from "../src/server/settings.ts";
import { ToolBundleImportStore } from "../src/tools/bundles.ts";
import { ToolBundleLifecycleService } from "../src/tools/bundle-lifecycle.ts";
import { DynamicToolRegistry } from "../src/tools/dynamic-registry.ts";
import { ToolRegistry } from "../src/tools/registry.ts";
import type { JsonValue } from "../src/shared/types.ts";
import { makeConfig } from "./helpers.ts";

function createHarness() {
  const database = new AppDatabase(":memory:");
  const assignments = new AutonomousAssignmentService(database);
  const ledger = new AutonomousMutationLedger(database, assignments);
  const settings = new OperatorSettingsStore(database);
  const executor = new AutonomousMutationExecutor({
    assignments,
    ledger,
    settings,
  });
  return { assignments, database, executor, ledger, settings };
}

function createToolBundleHarness() {
  const database = new AppDatabase(":memory:");
  const assignments = new AutonomousAssignmentService(database);
  const ledger = new AutonomousMutationLedger(database, assignments);
  const settings = new OperatorSettingsStore(database);
  const tools = new ToolRegistry();
  const dynamicTools = new DynamicToolRegistry(database, tools);
  const toolBundles = new ToolBundleImportStore(database);
  const toolBundleLifecycle = new ToolBundleLifecycleService({
    toolBundles,
    dynamicTools,
  });
  const executor = new AutonomousMutationExecutor({
    assignments,
    ledger,
    settings,
    toolBundles: toolBundleLifecycle,
  });
  return {
    assignments,
    database,
    dynamicTools,
    executor,
    ledger,
    settings,
    toolBundles,
    tools,
  };
}

function createPromptGuidanceHarness() {
  const database = new AppDatabase(":memory:");
  const assignments = new AutonomousAssignmentService(database);
  const ledger = new AutonomousMutationLedger(database, assignments);
  const settings = new OperatorSettingsStore(database);
  const promptGuidance = new PromptRuntimeGuidanceStore(database);
  const executor = new AutonomousMutationExecutor({
    assignments,
    ledger,
    settings,
    promptGuidance,
  });
  return { assignments, database, executor, ledger, promptGuidance, settings };
}

function createMemoryPolicyHarness() {
  const database = new AppDatabase(":memory:");
  const assignments = new AutonomousAssignmentService(database);
  const ledger = new AutonomousMutationLedger(database, assignments);
  const settings = new OperatorSettingsStore(database);
  const memoryPolicy = new MemoryPolicyStore(database, makeConfig());
  const executor = new AutonomousMutationExecutor({
    assignments,
    ledger,
    settings,
    memoryPolicy,
  });
  return { assignments, database, executor, ledger, memoryPolicy, settings };
}

function createRolePolicyHarness() {
  const database = new AppDatabase(":memory:");
  const assignments = new AutonomousAssignmentService(database);
  const ledger = new AutonomousMutationLedger(database, assignments);
  const settings = new OperatorSettingsStore(database);
  const rolePolicy = new RolePolicyRuntimeStore(
    database,
    loadRolePolicyConfig(makeConfig().roleConfigPath)
  );
  const executor = new AutonomousMutationExecutor({
    assignments,
    ledger,
    settings,
    rolePolicy,
  });
  return { assignments, database, executor, ledger, rolePolicy, settings };
}

function createProjectFileDraftHarness() {
  const database = new AppDatabase(":memory:");
  const assignments = new AutonomousAssignmentService(database);
  const ledger = new AutonomousMutationLedger(database, assignments);
  const settings = new OperatorSettingsStore(database);
  const projectFileDrafts = new ProjectFileDraftStore(database);
  const executor = new AutonomousMutationExecutor({
    assignments,
    ledger,
    settings,
    projectFileDrafts,
  });
  return {
    assignments,
    database,
    executor,
    ledger,
    projectFileDrafts,
    settings,
  };
}

function createRuntimeConfigLimitsHarness() {
  const database = new AppDatabase(":memory:");
  const config = makeConfig();
  const assignments = new AutonomousAssignmentService(database);
  const ledger = new AutonomousMutationLedger(database, assignments);
  const settings = new OperatorSettingsStore(database);
  const runtimeConfigLimits = new RuntimeConfigLimitsStore(database, config);
  const executor = new AutonomousMutationExecutor({
    assignments,
    ledger,
    settings,
    runtimeConfigLimits,
  });
  return {
    assignments,
    config,
    database,
    executor,
    ledger,
    runtimeConfigLimits,
    settings,
  };
}

function previewApprovedReadOnlyBundle(toolBundles: ToolBundleImportStore) {
  const preview = toolBundles.preview({
    importedBy: "operator",
    manifest: {
      id: "internal.research",
      name: "Internal Research",
      version: "1.0.0",
      tools: [
        {
          id: "internal.research.lookup",
          description: "Lookup an internal research note.",
          scopes: ["read"],
          inputSchema: {
            type: "object",
            properties: { topic: { type: "string" } },
          },
          responseTemplate: "Research note for {{topic}}",
        },
      ],
    },
  });
  return toolBundles.approve(preview.id, "operator", "read-only bundle");
}

test("AutonomousMutationExecutor applies bounded operator settings mutations for evolve assignments", () => {
  const { assignments, database, executor, ledger, settings } = createHarness();
  const assignment = assignments.create({
    objective: "Tune autonomous operator settings",
    autonomyLevel: "evolve",
  });

  const result = executor.apply({
    assignmentId: assignment.assignment.id,
    runId: "coord_autonomous_config",
    target: "configuration",
    mutationType: "operator_settings",
    rationale:
      "Slow down the operator console while autonomous work is active.",
    actor: "alice",
    proposedChange: {
      operatorSettings: { dashboardRefreshSeconds: 12 },
    },
  });

  assert.equal(settings.get().dashboardRefreshSeconds, 12);
  assert.equal(result.assignment.assignment.id, assignment.assignment.id);
  assert.equal(result.mutation.status, "applied");
  assert.equal(result.mutation.assignmentId, assignment.assignment.id);
  assert.equal(result.mutation.runId, "coord_autonomous_config");
  assert.equal(result.mutation.target, "configuration");
  assert.equal(result.mutation.mutationType, "operator_settings");
  assert.equal(result.mutation.autonomyLevel, "evolve");
  assert.deepEqual(result.mutation.authorizingPolicy, {
    rule: "assignment.policy.selfEvolution",
    maxRiskClass: "medium",
    allowedMutationClasses: ["configuration.operator_settings"],
    mutationClass: "configuration.operator_settings",
    actor: "alice",
  });
  assert.deepEqual(result.mutation.before, {
    dashboardRefreshSeconds: 5,
    chatDefaultConversationId: "operator-console",
    memoryTimelineLimit: 20,
  });
  assert.deepEqual(result.mutation.after, {
    dashboardRefreshSeconds: 12,
    chatDefaultConversationId: "operator-console",
    memoryTimelineLimit: 20,
  });
  assert.deepEqual(result.mutation.rollback, {
    operatorSettings: {
      dashboardRefreshSeconds: 5,
      chatDefaultConversationId: "operator-console",
      memoryTimelineLimit: 20,
    },
  });
  assert.deepEqual(
    ledger.list({ assignmentId: assignment.assignment.id }).map((mutation) => ({
      id: mutation.id,
      status: mutation.status,
    })),
    [{ id: result.mutation.id, status: "applied" }]
  );
  const timelineEvents = assignments.timeline(assignment.assignment.id).events;
  assert.deepEqual(
    timelineEvents.map((event) => event.type),
    ["created", "mutation_planned", "mutation_applied"]
  );
  assert.deepEqual(
    timelineEvents
      .filter((event) => event.type.startsWith("mutation_"))
      .map((event) => (event.payload as { actor?: string }).actor),
    ["alice", "alice"]
  );

  database.close();
});

test("AutonomousMutationExecutor applies explicit runtime config limit mutations", () => {
  const {
    assignments,
    config,
    database,
    executor,
    ledger,
    runtimeConfigLimits,
  } = createRuntimeConfigLimitsHarness();
  const assignment = assignments.create({
    objective: "Tune runtime execution limits",
    autonomyLevel: "evolve",
    policy: {
      selfEvolution: {
        enabled: true,
        allowedMutationClasses: [
          "configuration.operator_settings",
          "configuration.runtime_limits",
        ],
        maxRiskClass: "medium",
      },
    },
  });

  const result = executor.apply({
    assignmentId: assignment.assignment.id,
    runId: "coord_runtime_limits",
    target: "configuration",
    mutationType: "runtime_limits",
    rationale: "Give autonomous execution more room for this assignment.",
    actor: "alice",
    proposedChange: {
      runtimeLimits: {
        defaultRunTimeoutMs: 45_000,
        defaultMaxToolCalls: 9,
        openAiRequestTimeoutMs: 25_000,
        emailPollIntervalMs: 15_000,
        emailPollBatchSize: 4,
        emailMaxMessageBytes: 524_288,
      },
    },
  });

  const expectedAfter = {
    defaultRunTimeoutMs: 45_000,
    defaultMaxToolCalls: 9,
    openAiRequestTimeoutMs: 25_000,
    emailPollIntervalMs: 15_000,
    emailPollBatchSize: 4,
    emailMaxMessageBytes: 524_288,
  };
  assert.deepEqual(
    runtimeConfigLimitValues(runtimeConfigLimits.get()),
    expectedAfter
  );
  assert.equal(config.defaultRunTimeoutMs, 45_000);
  assert.equal(config.defaultMaxToolCalls, 9);
  assert.equal(config.openAiRequestTimeoutMs, 25_000);
  assert.equal(config.emailPollIntervalMs, 15_000);
  assert.equal(config.emailPollBatchSize, 4);
  assert.equal(config.emailMaxMessageBytes, 524_288);
  assert.equal(result.mutation.status, "applied");
  assert.equal(result.mutation.riskClass, "medium");
  assert.equal(result.mutation.target, "configuration");
  assert.equal(result.mutation.mutationType, "runtime_limits");
  assert.deepEqual(result.mutation.authorizingPolicy, {
    rule: "assignment.policy.selfEvolution",
    maxRiskClass: "medium",
    allowedMutationClasses: [
      "configuration.operator_settings",
      "configuration.runtime_limits",
    ],
    mutationClass: "configuration.runtime_limits",
    actor: "alice",
  });
  assert.deepEqual(result.mutation.before, {
    defaultRunTimeoutMs: 5_000,
    defaultMaxToolCalls: 4,
    openAiRequestTimeoutMs: 60_000,
    emailPollIntervalMs: 30_000,
    emailPollBatchSize: 10,
    emailMaxMessageBytes: 1_048_576,
  });
  assert.deepEqual(result.mutation.after, expectedAfter);
  assert.deepEqual(result.mutation.rollback, {
    runtimeLimits: {
      defaultRunTimeoutMs: 5_000,
      defaultMaxToolCalls: 4,
      openAiRequestTimeoutMs: 60_000,
      emailPollIntervalMs: 30_000,
      emailPollBatchSize: 10,
      emailMaxMessageBytes: 1_048_576,
    },
    runtimeLimitsOverlay: {
      hasOverlay: false,
      overlay: {},
      values: {
        defaultRunTimeoutMs: 5_000,
        defaultMaxToolCalls: 4,
        openAiRequestTimeoutMs: 60_000,
        emailPollIntervalMs: 30_000,
        emailPollBatchSize: 10,
        emailMaxMessageBytes: 1_048_576,
      },
    },
  });
  assert.deepEqual(result.mutation.affectedResources, [
    { type: "runtime_config", id: "limits" },
  ]);
  assert.deepEqual(
    ledger.list({ assignmentId: assignment.assignment.id }).map((mutation) => ({
      id: mutation.id,
      status: mutation.status,
    })),
    [{ id: result.mutation.id, status: "applied" }]
  );

  database.close();
});

test("RuntimeConfigLimitsStore preserves env-derived startup limits until an overlay is applied", () => {
  const database = new AppDatabase(":memory:");
  const config = makeConfig(".", {
    defaultRunTimeoutMs: 500_000,
    defaultMaxToolCalls: 75,
    openAiRequestTimeoutMs: 450_000,
    emailPollBatchSize: 250,
  });
  const runtimeConfigLimits = new RuntimeConfigLimitsStore(database, config);

  assert.deepEqual(runtimeConfigLimitValues(runtimeConfigLimits.get()), {
    defaultRunTimeoutMs: 500_000,
    defaultMaxToolCalls: 75,
    openAiRequestTimeoutMs: 450_000,
    emailPollIntervalMs: 30_000,
    emailPollBatchSize: 250,
    emailMaxMessageBytes: 1_048_576,
  });
  assert.equal(config.defaultRunTimeoutMs, 500_000);
  assert.equal(config.defaultMaxToolCalls, 75);
  assert.equal(config.openAiRequestTimeoutMs, 450_000);
  assert.equal(config.emailPollBatchSize, 250);
  assert.equal(
    database.get<{ id: string }>(
      "SELECT id FROM runtime_config_limits WHERE id = ?",
      "runtime"
    ),
    null
  );

  database.close();
});

test("RuntimeConfigLimitsStore persists only explicit overlay fields", () => {
  const database = new AppDatabase(":memory:");
  const config = makeConfig(".", {
    defaultRunTimeoutMs: 500_000,
    defaultMaxToolCalls: 75,
    openAiRequestTimeoutMs: 450_000,
    emailPollBatchSize: 250,
  });
  const runtimeConfigLimits = new RuntimeConfigLimitsStore(database, config);

  runtimeConfigLimits.update({ defaultRunTimeoutMs: 45_000 }, "alice");

  assert.deepEqual(runtimeConfigLimitValues(runtimeConfigLimits.get()), {
    defaultRunTimeoutMs: 45_000,
    defaultMaxToolCalls: 75,
    openAiRequestTimeoutMs: 450_000,
    emailPollIntervalMs: 30_000,
    emailPollBatchSize: 250,
    emailMaxMessageBytes: 1_048_576,
  });
  assert.deepEqual(
    {
      ...database.get<{
        default_run_timeout_ms: number | null;
        default_max_tool_calls: number | null;
        openai_request_timeout_ms: number | null;
        email_poll_batch_size: number | null;
      }>(
        `
          SELECT
            default_run_timeout_ms,
            default_max_tool_calls,
            openai_request_timeout_ms,
            email_poll_batch_size
          FROM runtime_config_limits
          WHERE id = ?
        `,
        "runtime"
      ),
    },
    {
      default_run_timeout_ms: 45_000,
      default_max_tool_calls: null,
      openai_request_timeout_ms: null,
      email_poll_batch_size: null,
    }
  );

  const restartConfig = makeConfig(".", {
    defaultRunTimeoutMs: 250_000,
    defaultMaxToolCalls: 80,
    openAiRequestTimeoutMs: 120_000,
    emailPollBatchSize: 88,
  });
  const restartRuntimeConfigLimits = new RuntimeConfigLimitsStore(
    database,
    restartConfig
  );

  assert.deepEqual(runtimeConfigLimitValues(restartRuntimeConfigLimits.get()), {
    defaultRunTimeoutMs: 45_000,
    defaultMaxToolCalls: 80,
    openAiRequestTimeoutMs: 120_000,
    emailPollIntervalMs: 30_000,
    emailPollBatchSize: 88,
    emailMaxMessageBytes: 1_048_576,
  });

  database.close();
});

test("RuntimeConfigLimitsStore drops ambiguous legacy full-row overlays", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "codex-phantom-runtime-limits-"));
  const databasePath = join(dataDir, "phantom.sqlite");
  const legacyDatabase = new AppDatabase(databasePath);
  legacyDatabase.exec(`
    DROP TABLE runtime_config_limits;
    CREATE TABLE runtime_config_limits (
      id TEXT PRIMARY KEY,
      default_run_timeout_ms INTEGER NOT NULL,
      default_max_tool_calls INTEGER NOT NULL,
      openai_request_timeout_ms INTEGER NOT NULL,
      email_poll_interval_ms INTEGER NOT NULL,
      email_poll_batch_size INTEGER NOT NULL,
      email_max_message_bytes INTEGER NOT NULL,
      updated_by TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    INSERT INTO runtime_config_limits (
      id, default_run_timeout_ms, default_max_tool_calls,
      openai_request_timeout_ms, email_poll_interval_ms,
      email_poll_batch_size, email_max_message_bytes,
      updated_by, created_at, updated_at
    ) VALUES (
      'runtime', 45000, 75, 450000, 30000, 250, 1048576,
      'legacy', '2026-06-16T00:00:00.000Z', '2026-06-16T00:00:00.000Z'
    );
  `);
  legacyDatabase.close();

  const database = new AppDatabase(databasePath);
  const config = makeConfig(".", {
    defaultRunTimeoutMs: 500_000,
    defaultMaxToolCalls: 75,
    openAiRequestTimeoutMs: 450_000,
    emailPollBatchSize: 250,
  });
  const runtimeConfigLimits = new RuntimeConfigLimitsStore(database, config);

  assert.deepEqual(runtimeConfigLimitValues(runtimeConfigLimits.get()), {
    defaultRunTimeoutMs: 500_000,
    defaultMaxToolCalls: 75,
    openAiRequestTimeoutMs: 450_000,
    emailPollIntervalMs: 30_000,
    emailPollBatchSize: 250,
    emailMaxMessageBytes: 1_048_576,
  });
  assert.equal(
    database.get<{ id: string }>(
      "SELECT id FROM runtime_config_limits WHERE id = ?",
      "runtime"
    ),
    null
  );

  database.close();
});

test("AutonomousMutationExecutor keeps runtime config limits explicitly opt-in", () => {
  const {
    assignments,
    config,
    database,
    executor,
    ledger,
    runtimeConfigLimits,
  } = createRuntimeConfigLimitsHarness();
  const before = runtimeConfigLimitValues(runtimeConfigLimits.get());
  const assignment = assignments.create({
    objective: "Default policy should not mutate runtime limits",
    autonomyLevel: "evolve",
  });

  assert.throws(
    () =>
      executor.apply({
        assignmentId: assignment.assignment.id,
        target: "configuration",
        mutationType: "runtime_limits",
        rationale: "Try runtime limit mutation without explicit opt-in.",
        proposedChange: {
          runtimeLimits: { defaultRunTimeoutMs: 45_000 },
        },
      }),
    (error) => {
      assert.ok(error instanceof AutonomousMutationExecutionError);
      assert.equal(error.status, 403);
      assert.equal(error.mutation?.status, "failed");
      assert.match(
        error.message,
        /does not allow configuration\.runtime_limits/
      );
      return true;
    }
  );

  assert.deepEqual(runtimeConfigLimitValues(runtimeConfigLimits.get()), before);
  assert.equal(config.defaultRunTimeoutMs, before.defaultRunTimeoutMs);
  assert.deepEqual(
    ledger.list({ assignmentId: assignment.assignment.id }).map((mutation) => ({
      status: mutation.status,
      mutationType: mutation.mutationType,
      authorizingPolicy: mutation.authorizingPolicy,
      errorMessage: mutation.errorMessage,
    })),
    [
      {
        status: "failed",
        mutationType: "runtime_limits",
        authorizingPolicy: {
          rule: "assignment.policy.selfEvolution",
          maxRiskClass: "medium",
          allowedMutationClasses: ["configuration.operator_settings"],
          mutationClass: "configuration.runtime_limits",
        },
        errorMessage:
          "Assignment self-evolution policy does not allow configuration.runtime_limits",
      },
    ]
  );

  for (const autonomyLevel of ["execute", "draft", "observe"] as const) {
    const blocked = assignments.create({
      objective: `Blocked ${autonomyLevel} runtime limits`,
      autonomyLevel,
      policy: {
        selfEvolution: {
          enabled: true,
          allowedMutationClasses: [
            "configuration.operator_settings",
            "configuration.runtime_limits",
          ],
          maxRiskClass: "medium",
        },
      },
    });

    assert.throws(
      () =>
        executor.apply({
          assignmentId: blocked.assignment.id,
          target: "configuration",
          mutationType: "runtime_limits",
          rationale: "Non-evolve assignments cannot mutate runtime limits.",
          proposedChange: {
            runtimeLimits: { defaultRunTimeoutMs: 45_000 },
          },
        }),
      (error) => {
        assert.ok(error instanceof AutonomousMutationExecutionError);
        assert.equal(error.status, 403);
        assert.match(error.message, /autonomyLevel must be evolve/);
        return true;
      }
    );
    assert.deepEqual(ledger.list({ assignmentId: blocked.assignment.id }), []);
  }

  assert.deepEqual(runtimeConfigLimitValues(runtimeConfigLimits.get()), before);
  database.close();
});

test("AutonomousMutationExecutor classifies runtime config limit mutations as medium risk", () => {
  const {
    assignments,
    config,
    database,
    executor,
    ledger,
    runtimeConfigLimits,
  } = createRuntimeConfigLimitsHarness();
  const before = runtimeConfigLimitValues(runtimeConfigLimits.get());
  const assignment = assignments.create({
    objective: "Low-risk policy should not mutate runtime limits",
    autonomyLevel: "evolve",
    policy: {
      selfEvolution: {
        enabled: true,
        allowedMutationClasses: [
          "configuration.operator_settings",
          "configuration.runtime_limits",
        ],
        maxRiskClass: "low",
      },
    },
  });

  assert.throws(
    () =>
      executor.apply({
        assignmentId: assignment.assignment.id,
        target: "configuration",
        mutationType: "runtime_limits",
        rationale: "Try to omit the runtime-limits risk class.",
        proposedChange: {
          runtimeLimits: { defaultRunTimeoutMs: 45_000 },
        },
      }),
    (error) => {
      assert.ok(error instanceof AutonomousMutationExecutionError);
      assert.equal(error.status, 403);
      assert.equal(error.mutation?.status, "failed");
      assert.equal(error.mutation?.riskClass, "medium");
      assert.match(
        error.message,
        /risk exceeds assignment self-evolution policy/
      );
      return true;
    }
  );

  assert.deepEqual(runtimeConfigLimitValues(runtimeConfigLimits.get()), before);
  assert.equal(config.defaultRunTimeoutMs, before.defaultRunTimeoutMs);
  assert.deepEqual(
    ledger.list({ assignmentId: assignment.assignment.id }).map((mutation) => ({
      status: mutation.status,
      mutationType: mutation.mutationType,
      riskClass: mutation.riskClass,
      errorMessage: mutation.errorMessage,
    })),
    [
      {
        status: "failed",
        mutationType: "runtime_limits",
        riskClass: "medium",
        errorMessage:
          "Autonomous mutation risk exceeds assignment self-evolution policy",
      },
    ]
  );

  database.close();
});

test("AutonomousMutationExecutor rejects malformed runtime config limits without changing config", () => {
  const {
    assignments,
    config,
    database,
    executor,
    ledger,
    runtimeConfigLimits,
  } = createRuntimeConfigLimitsHarness();
  const before = runtimeConfigLimitValues(runtimeConfigLimits.get());
  const assignment = assignments.create({
    objective: "Reject unsafe runtime limit changes",
    autonomyLevel: "evolve",
    policy: {
      selfEvolution: {
        enabled: true,
        allowedMutationClasses: [
          "configuration.operator_settings",
          "configuration.runtime_limits",
        ],
        maxRiskClass: "medium",
      },
    },
  });

  const invalidChanges: Array<{ proposedChange: JsonValue; message: RegExp }> =
    [
      {
        proposedChange: {},
        message: /proposedChange\.runtimeLimits must be a JSON object/,
      },
      {
        proposedChange: { runtimeLimits: "fast" },
        message: /proposedChange\.runtimeLimits must be a JSON object/,
      },
      {
        proposedChange: { runtimeLimits: { model: "gpt-5.1" } },
        message: /runtimeLimits\.model is not supported/,
      },
      {
        proposedChange: { runtimeLimits: { defaultMaxToolCalls: 2.5 } },
        message: /runtimeLimits\.defaultMaxToolCalls must be an integer/,
      },
      {
        proposedChange: { runtimeLimits: { defaultRunTimeoutMs: 999 } },
        message:
          /runtimeLimits\.defaultRunTimeoutMs must be greater than or equal to 1000/,
      },
      {
        proposedChange: { runtimeLimits: { emailPollBatchSize: 101 } },
        message:
          /runtimeLimits\.emailPollBatchSize must be less than or equal to 100/,
      },
    ];

  for (const { proposedChange, message } of invalidChanges) {
    assert.throws(
      () =>
        executor.apply({
          assignmentId: assignment.assignment.id,
          target: "configuration",
          mutationType: "runtime_limits",
          rationale: "Reject malformed runtime limits.",
          proposedChange,
        }),
      (error) => {
        assert.ok(error instanceof AutonomousMutationExecutionError);
        assert.equal(error.status, 400);
        assert.equal(error.mutation?.status, "failed");
        assert.match(error.message, message);
        return true;
      }
    );
    assert.deepEqual(
      runtimeConfigLimitValues(runtimeConfigLimits.get()),
      before
    );
    assert.equal(config.defaultRunTimeoutMs, before.defaultRunTimeoutMs);
  }

  assert.deepEqual(
    ledger.list({ assignmentId: assignment.assignment.id }).map((mutation) => ({
      status: mutation.status,
      mutationType: mutation.mutationType,
      target: mutation.target,
    })),
    invalidChanges.map(() => ({
      status: "failed",
      mutationType: "runtime_limits",
      target: "configuration",
    }))
  );

  database.close();
});

test("AutonomousMutationExecutor rolls back runtime config limit mutations", () => {
  const { assignments, config, database, executor, runtimeConfigLimits } =
    createRuntimeConfigLimitsHarness();
  const before = runtimeConfigLimitValues(runtimeConfigLimits.get());
  const assignment = assignments.create({
    objective: "Rollback runtime config limits",
    autonomyLevel: "evolve",
    policy: {
      selfEvolution: {
        allowedMutationClasses: [
          "configuration.operator_settings",
          "configuration.runtime_limits",
        ],
      },
    },
  });

  const applied = executor.apply({
    assignmentId: assignment.assignment.id,
    target: "configuration",
    mutationType: "runtime_limits",
    rationale: "Temporarily allow longer runs.",
    actor: "alice",
    proposedChange: {
      runtimeLimits: {
        defaultRunTimeoutMs: 90_000,
        defaultMaxToolCalls: 12,
      },
    },
  });

  assert.equal(config.defaultRunTimeoutMs, 90_000);
  assert.equal(config.defaultMaxToolCalls, 12);

  const rolledBack = executor.rollback({
    assignmentId: assignment.assignment.id,
    mutationId: applied.mutation.id,
    actor: "bob",
  });

  assert.deepEqual(runtimeConfigLimitValues(runtimeConfigLimits.get()), before);
  assert.equal(config.defaultRunTimeoutMs, before.defaultRunTimeoutMs);
  assert.equal(config.defaultMaxToolCalls, before.defaultMaxToolCalls);
  assert.equal(
    database.get<{ id: string }>(
      "SELECT id FROM runtime_config_limits WHERE id = ?",
      "runtime"
    ),
    null
  );
  assert.equal(rolledBack.mutation.status, "rolled_back");
  assert.deepEqual(rolledBack.mutation.verification, {
    attempted: true,
    result: "passed",
    method: "runtime_config_limits_rollback",
  });
  assert.deepEqual(
    assignments
      .timeline(assignment.assignment.id)
      .events.map((event) => event.type),
    ["created", "mutation_planned", "mutation_applied", "mutation_rolled_back"]
  );

  database.close();
});

test("AutonomousMutationExecutor rolls back legacy runtime config limit evidence", () => {
  const database = new AppDatabase(":memory:");
  const config = makeConfig(".", {
    defaultRunTimeoutMs: 5_000,
    defaultMaxToolCalls: 4,
    openAiRequestTimeoutMs: 60_000,
    emailPollBatchSize: 10,
  });
  const assignments = new AutonomousAssignmentService(database);
  const ledger = new AutonomousMutationLedger(database, assignments);
  const settings = new OperatorSettingsStore(database);
  const runtimeConfigLimits = new RuntimeConfigLimitsStore(database, config);
  const executor = new AutonomousMutationExecutor({
    assignments,
    ledger,
    settings,
    runtimeConfigLimits,
  });
  const legacyBefore = {
    defaultRunTimeoutMs: 500_000,
    defaultMaxToolCalls: 75,
    openAiRequestTimeoutMs: 450_000,
    emailPollIntervalMs: 30_000,
    emailPollBatchSize: 250,
    emailMaxMessageBytes: 1_048_576,
  };
  const assignment = assignments.create({
    objective: "Rollback legacy runtime config limits",
    autonomyLevel: "evolve",
    policy: {
      selfEvolution: {
        allowedMutationClasses: [
          "configuration.operator_settings",
          "configuration.runtime_limits",
        ],
      },
    },
  });

  const applied = executor.apply({
    assignmentId: assignment.assignment.id,
    target: "configuration",
    mutationType: "runtime_limits",
    rationale: "Temporarily allow longer runs.",
    proposedChange: {
      runtimeLimits: { defaultRunTimeoutMs: 90_000 },
    },
  });
  database.run(
    "UPDATE assignment_mutations SET rollback_json = ? WHERE id = ?",
    JSON.stringify({ runtimeLimits: legacyBefore }),
    applied.mutation.id
  );

  executor.rollback({
    assignmentId: assignment.assignment.id,
    mutationId: applied.mutation.id,
  });

  assert.deepEqual(
    runtimeConfigLimitValues(runtimeConfigLimits.get()),
    legacyBefore
  );
  assert.equal(config.defaultRunTimeoutMs, legacyBefore.defaultRunTimeoutMs);
  assert.equal(config.defaultMaxToolCalls, legacyBefore.defaultMaxToolCalls);
  assert.equal(
    database
      .get<{
        updated_by: string;
      }>("SELECT updated_by FROM runtime_config_limits WHERE id = ?", "runtime")
      ?.updated_by.startsWith("legacy_runtime_config_limits_rollback"),
    true
  );

  const secondApplied = executor.apply({
    assignmentId: assignment.assignment.id,
    target: "configuration",
    mutationType: "runtime_limits",
    rationale: "Apply a normal mutation after legacy rollback.",
    proposedChange: {
      runtimeLimits: { defaultRunTimeoutMs: 45_000 },
    },
  });
  executor.rollback({
    assignmentId: assignment.assignment.id,
    mutationId: secondApplied.mutation.id,
  });

  assert.deepEqual(
    runtimeConfigLimitValues(runtimeConfigLimits.get()),
    legacyBefore
  );
  assert.equal(config.defaultRunTimeoutMs, legacyBefore.defaultRunTimeoutMs);
  assert.equal(config.defaultMaxToolCalls, legacyBefore.defaultMaxToolCalls);

  runtimeConfigLimits.update({ defaultRunTimeoutMs: 45_000 }, "alice");

  assert.deepEqual(runtimeConfigLimitValues(runtimeConfigLimits.get()), {
    defaultRunTimeoutMs: 45_000,
    defaultMaxToolCalls: 4,
    openAiRequestTimeoutMs: 60_000,
    emailPollIntervalMs: 30_000,
    emailPollBatchSize: 10,
    emailMaxMessageBytes: 1_048_576,
  });

  database.close();
});

test("AutonomousMutationExecutor blocks stale runtime config limit rollback across assignments", () => {
  const { assignments, config, database, executor } =
    createRuntimeConfigLimitsHarness();
  const first = assignments.create({
    objective: "First runtime limits change",
    autonomyLevel: "evolve",
    policy: {
      selfEvolution: {
        allowedMutationClasses: [
          "configuration.operator_settings",
          "configuration.runtime_limits",
        ],
      },
    },
  });
  const second = assignments.create({
    objective: "Second runtime limits change",
    autonomyLevel: "evolve",
    policy: {
      selfEvolution: {
        allowedMutationClasses: [
          "configuration.operator_settings",
          "configuration.runtime_limits",
        ],
      },
    },
  });

  const firstMutation = executor.apply({
    assignmentId: first.assignment.id,
    target: "configuration",
    mutationType: "runtime_limits",
    rationale: "First runtime timeout change.",
    proposedChange: {
      runtimeLimits: { defaultRunTimeoutMs: 45_000 },
    },
  });
  executor.apply({
    assignmentId: second.assignment.id,
    target: "configuration",
    mutationType: "runtime_limits",
    rationale: "Newer runtime timeout change.",
    proposedChange: {
      runtimeLimits: { defaultRunTimeoutMs: 75_000 },
    },
  });

  assert.throws(
    () =>
      executor.rollback({
        assignmentId: first.assignment.id,
        mutationId: firstMutation.mutation.id,
      }),
    (error) => {
      assert.ok(error instanceof AutonomousMutationExecutionError);
      assert.equal(error.status, 409);
      assert.match(
        error.message,
        /newer applied configuration\.runtime_limits mutation exists/
      );
      return true;
    }
  );
  assert.equal(config.defaultRunTimeoutMs, 75_000);

  database.close();
});

test("AutonomousMutationExecutor supports injected autonomous mutation adapters", () => {
  const database = new AppDatabase(":memory:");
  const assignments = new AutonomousAssignmentService(database);
  const ledger = new AutonomousMutationLedger(database, assignments);
  const settings = new OperatorSettingsStore(database);
  const fakeState = { value: "before" };
  const fakeAdapter: AutonomousMutationAdapter = {
    target: "configuration",
    mutationType: "fake_settings",
    mutationClass: "configuration.fake_settings",
    affectedResources: [{ type: "settings", id: "fake" }],
    apply(input) {
      const proposedChange = input.proposedChange as {
        fakeSettings?: { value?: string };
      };
      const nextValue = proposedChange.fakeSettings?.value;
      if (!nextValue) {
        throw new Error("fakeSettings.value is required");
      }
      const before = { value: fakeState.value };
      fakeState.value = nextValue;
      return {
        before,
        after: { value: fakeState.value },
        rollback: { fakeSettings: before },
        affectedResources: [{ type: "settings", id: "fake" }],
        verificationMethod: "fake_settings_update",
      };
    },
    rollback(input) {
      const rollback = input.rollback as { fakeSettings?: { value?: string } };
      const previousValue = rollback.fakeSettings?.value;
      if (!previousValue) {
        throw new Error("rollback.fakeSettings.value is required");
      }
      fakeState.value = previousValue;
      return {
        verificationMethod: "fake_settings_rollback",
      };
    },
  };
  const executor = new AutonomousMutationExecutor({
    assignments,
    ledger,
    settings,
    adapters: [fakeAdapter],
  });
  const assignment = assignments.create({
    objective: "Apply injected mutation adapter",
    autonomyLevel: "evolve",
    policy: {
      selfEvolution: {
        allowedMutationClasses: ["configuration.fake_settings"],
      },
    },
  });

  const applied = executor.apply({
    assignmentId: assignment.assignment.id,
    target: "configuration",
    mutationType: "fake_settings",
    rationale: "Exercise the adapter registry.",
    proposedChange: {
      fakeSettings: { value: "after" },
    },
  });

  assert.equal(fakeState.value, "after");
  assert.equal(applied.mutation.status, "applied");
  assert.equal(applied.mutation.mutationType, "fake_settings");
  assert.deepEqual(applied.mutation.authorizingPolicy, {
    rule: "assignment.policy.selfEvolution",
    maxRiskClass: "medium",
    allowedMutationClasses: ["configuration.fake_settings"],
    mutationClass: "configuration.fake_settings",
  });
  assert.deepEqual(applied.mutation.rollback, {
    fakeSettings: { value: "before" },
  });
  assert.deepEqual(applied.mutation.affectedResources, [
    { type: "settings", id: "fake" },
  ]);
  assert.deepEqual(applied.mutation.verification, {
    attempted: true,
    result: "passed",
    method: "fake_settings_update",
  });

  const defaultOnlyExecutor = new AutonomousMutationExecutor({
    assignments,
    ledger,
    settings,
  });
  assert.throws(
    () =>
      defaultOnlyExecutor.rollback({
        assignmentId: assignment.assignment.id,
        mutationId: applied.mutation.id,
      }),
    (error) => {
      assert.ok(error instanceof AutonomousMutationExecutionError);
      assert.equal(error.status, 400);
      assert.match(
        error.message,
        /No autonomous mutation adapter is available/
      );
      return true;
    }
  );
  assert.equal(fakeState.value, "after");

  const rolledBack = executor.rollback({
    assignmentId: assignment.assignment.id,
    mutationId: applied.mutation.id,
  });

  assert.equal(fakeState.value, "before");
  assert.equal(rolledBack.mutation.status, "rolled_back");
  assert.deepEqual(rolledBack.mutation.verification, {
    attempted: true,
    result: "passed",
    method: "fake_settings_rollback",
  });

  database.close();
});

test("AutonomousMutationExecutor applies explicit assignment policy mutations", () => {
  const { assignments, database, executor, ledger } = createHarness();
  const assignment = assignments.create({
    objective: "Tune assignment execution policy",
    autonomyLevel: "evolve",
    policy: {
      maxWakeups: 4,
      wakeupDelayMinMinutes: 5,
      wakeupDelayMaxMinutes: 60,
      notificationCadence: {
        onFailure: true,
        activeProgressIntervalMinutes: 30,
      },
      childAssignments: {
        maxDepth: 2,
        maxActiveChildren: 2,
      },
      selfEvolution: {
        allowedMutationClasses: [
          "configuration.operator_settings",
          "configuration.assignment_policy",
        ],
      },
    },
  });

  const applied = executor.apply({
    assignmentId: assignment.assignment.id,
    runId: "coord_assignment_policy",
    target: "configuration",
    mutationType: "assignment_policy",
    rationale: "Give this assignment a little more wakeup room.",
    actor: "alice",
    proposedChange: {
      assignmentPolicy: {
        maxWakeups: 8,
        wakeupDelayMinMinutes: 10,
        wakeupDelayMaxMinutes: 120,
        notificationCadence: {
          onFailure: false,
          activeProgressIntervalMinutes: 45,
        },
        childAssignments: {
          maxDepth: 3,
          maxActiveChildren: 1,
        },
      },
    },
  });

  const updated = assignments.getRequired(assignment.assignment.id).assignment;
  assert.equal(updated.policy.maxWakeups, 8);
  assert.equal(updated.policy.wakeupDelayMinMinutes, 10);
  assert.equal(updated.policy.wakeupDelayMaxMinutes, 120);
  assert.equal(updated.policy.notificationCadence.onFailure, false);
  assert.equal(
    updated.policy.notificationCadence.activeProgressIntervalMinutes,
    45
  );
  assert.deepEqual(updated.policy.childAssignments, {
    maxDepth: 3,
    maxActiveChildren: 1,
  });
  assert.deepEqual(updated.policy.selfEvolution.allowedMutationClasses, [
    "configuration.operator_settings",
    "configuration.assignment_policy",
  ]);
  assert.equal(applied.mutation.status, "applied");
  assert.equal(applied.mutation.mutationType, "assignment_policy");
  assert.deepEqual(applied.mutation.authorizingPolicy, {
    rule: "assignment.policy.selfEvolution",
    maxRiskClass: "medium",
    allowedMutationClasses: [
      "configuration.operator_settings",
      "configuration.assignment_policy",
    ],
    mutationClass: "configuration.assignment_policy",
    actor: "alice",
  });
  assert.equal(
    (applied.mutation.before as { maxWakeups?: number }).maxWakeups,
    4
  );
  assert.equal(
    (applied.mutation.after as { maxWakeups?: number }).maxWakeups,
    8
  );
  assert.deepEqual(applied.mutation.rollback, {
    assignmentPolicy: assignment.assignment.policy,
  });
  assert.deepEqual(applied.mutation.affectedResources, [
    { type: "assignment_policy", id: assignment.assignment.id },
  ]);
  assert.deepEqual(applied.mutation.verification, {
    attempted: true,
    result: "passed",
    method: "assignment_policy_update",
  });
  assert.deepEqual(
    ledger.list({ assignmentId: assignment.assignment.id }).map((mutation) => ({
      id: mutation.id,
      status: mutation.status,
    })),
    [{ id: applied.mutation.id, status: "applied" }]
  );

  const rolledBack = executor.rollback({
    assignmentId: assignment.assignment.id,
    mutationId: applied.mutation.id,
    actor: "bob",
  });

  assert.equal(rolledBack.mutation.status, "rolled_back");
  assert.deepEqual(
    assignments.getRequired(assignment.assignment.id).assignment.policy,
    assignment.assignment.policy
  );
  assert.deepEqual(rolledBack.mutation.verification, {
    attempted: true,
    result: "passed",
    method: "assignment_policy_rollback",
  });
  assert.deepEqual(
    assignments
      .timeline(assignment.assignment.id)
      .events.map((event) => event.type),
    [
      "created",
      "mutation_planned",
      "policy_changed",
      "mutation_applied",
      "policy_changed",
      "mutation_rolled_back",
    ]
  );
  assert.deepEqual(
    assignments
      .timeline(assignment.assignment.id)
      .events.filter(
        (event) =>
          event.type === "policy_changed" ||
          event.type === "mutation_rolled_back"
      )
      .map((event) => (event.payload as { actor?: string | null }).actor),
    ["alice", "bob", "bob"]
  );

  database.close();
});

test("AutonomousMutationExecutor applies explicit tool bundle enable mutations", () => {
  const {
    assignments,
    database,
    dynamicTools,
    executor,
    ledger,
    toolBundles,
    tools,
  } = createToolBundleHarness();
  const bundle = previewApprovedReadOnlyBundle(toolBundles);
  const assignment = assignments.create({
    objective: "Enable governed internal tool bundle",
    autonomyLevel: "evolve",
    policy: {
      selfEvolution: {
        allowedMutationClasses: [
          "configuration.operator_settings",
          "tool.bundle_enable",
        ],
      },
    },
  });

  const applied = executor.apply({
    assignmentId: assignment.assignment.id,
    runId: "coord_tool_bundle_enable",
    target: "tool",
    mutationType: "bundle_enable",
    rationale: "Make the approved internal research bundle available.",
    actor: "alice",
    proposedChange: {
      toolBundle: { importId: bundle.id },
    },
  });

  assert.equal(tools.has("internal.research.lookup"), true);
  assert.equal(
    dynamicTools.get("internal.research.lookup")?.approvedBy,
    "operator"
  );
  assert.equal(toolBundles.get(bundle.id)?.lifecycleState, "enabled");
  assert.equal(applied.mutation.status, "applied");
  assert.equal(applied.mutation.target, "tool");
  assert.equal(applied.mutation.mutationType, "bundle_enable");
  assert.deepEqual(applied.mutation.authorizingPolicy, {
    rule: "assignment.policy.selfEvolution",
    maxRiskClass: "medium",
    allowedMutationClasses: [
      "configuration.operator_settings",
      "tool.bundle_enable",
    ],
    mutationClass: "tool.bundle_enable",
    actor: "alice",
  });
  assert.equal(
    (applied.mutation.before as { lifecycleState?: string }).lifecycleState,
    "approved"
  );
  assert.equal(
    (applied.mutation.after as { lifecycleState?: string }).lifecycleState,
    "enabled"
  );
  assert.deepEqual(applied.mutation.rollback, {
    toolBundle: { importId: bundle.id },
  });
  assert.deepEqual(applied.mutation.affectedResources, [
    { type: "tool_bundle_import", id: bundle.id },
    { type: "tool", id: "internal.research.lookup" },
  ]);
  assert.deepEqual(applied.mutation.verification, {
    attempted: true,
    result: "passed",
    method: "tool_bundle_enable_update",
  });
  assert.deepEqual(
    ledger.list({ assignmentId: assignment.assignment.id }).map((mutation) => ({
      id: mutation.id,
      status: mutation.status,
    })),
    [{ id: applied.mutation.id, status: "applied" }]
  );

  const rolledBack = executor.rollback({
    assignmentId: assignment.assignment.id,
    mutationId: applied.mutation.id,
    actor: "bob",
  });

  assert.equal(tools.has("internal.research.lookup"), false);
  assert.equal(toolBundles.get(bundle.id)?.lifecycleState, "disabled");
  assert.equal(rolledBack.mutation.status, "rolled_back");
  assert.deepEqual(rolledBack.mutation.verification, {
    attempted: true,
    result: "passed",
    method: "tool_bundle_enable_rollback",
  });
  assert.deepEqual(
    assignments
      .timeline(assignment.assignment.id)
      .events.map((event) => event.type),
    ["created", "mutation_planned", "mutation_applied", "mutation_rolled_back"]
  );

  database.close();
});

test("AutonomousMutationExecutor applies prompt runtime guidance mutations", () => {
  const { assignments, database, executor, ledger, promptGuidance } =
    createPromptGuidanceHarness();
  promptGuidance.update("Prefer neutral summaries.", "operator");
  const assignment = assignments.create({
    objective: "Tune runtime prompt guidance",
    autonomyLevel: "evolve",
    policy: {
      selfEvolution: {
        allowedMutationClasses: [
          "configuration.operator_settings",
          "prompt.runtime_guidance",
        ],
      },
    },
  });

  const applied = executor.apply({
    assignmentId: assignment.assignment.id,
    runId: "coord_prompt_guidance",
    target: "prompt",
    mutationType: "runtime_guidance",
    rationale: "Prefer evidence-first wakeup summaries.",
    actor: "alice",
    proposedChange: {
      runtimeGuidance: {
        text: "Prefer evidence-first wakeup summaries.",
      },
    },
  });

  assert.equal(
    promptGuidance.get().text,
    "Prefer evidence-first wakeup summaries."
  );
  assert.equal(applied.mutation.status, "applied");
  assert.equal(applied.mutation.target, "prompt");
  assert.equal(applied.mutation.mutationType, "runtime_guidance");
  assert.deepEqual(applied.mutation.authorizingPolicy, {
    rule: "assignment.policy.selfEvolution",
    maxRiskClass: "medium",
    allowedMutationClasses: [
      "configuration.operator_settings",
      "prompt.runtime_guidance",
    ],
    mutationClass: "prompt.runtime_guidance",
    actor: "alice",
  });
  assert.equal(
    (applied.mutation.before as { text?: string }).text,
    "Prefer neutral summaries."
  );
  assert.equal(
    (applied.mutation.after as { text?: string }).text,
    "Prefer evidence-first wakeup summaries."
  );
  assert.deepEqual(applied.mutation.rollback, {
    runtimeGuidance: { text: "Prefer neutral summaries." },
  });
  assert.deepEqual(applied.mutation.affectedResources, [
    { type: "prompt", id: "runtime_guidance" },
  ]);
  assert.deepEqual(applied.mutation.verification, {
    attempted: true,
    result: "passed",
    method: "prompt_runtime_guidance_update",
  });
  assert.deepEqual(
    ledger.list({ assignmentId: assignment.assignment.id }).map((mutation) => ({
      id: mutation.id,
      status: mutation.status,
    })),
    [{ id: applied.mutation.id, status: "applied" }]
  );

  const rolledBack = executor.rollback({
    assignmentId: assignment.assignment.id,
    mutationId: applied.mutation.id,
    actor: "bob",
  });

  assert.equal(promptGuidance.get().text, "Prefer neutral summaries.");
  assert.equal(rolledBack.mutation.status, "rolled_back");
  assert.deepEqual(rolledBack.mutation.verification, {
    attempted: true,
    result: "passed",
    method: "prompt_runtime_guidance_rollback",
  });

  database.close();
});

test("AutonomousMutationExecutor rolls back first prompt runtime guidance mutation to the default empty overlay", () => {
  const { assignments, database, executor, promptGuidance } =
    createPromptGuidanceHarness();
  const assignment = assignments.create({
    objective: "Tune runtime prompt guidance from an empty baseline",
    autonomyLevel: "evolve",
    policy: {
      selfEvolution: {
        allowedMutationClasses: [
          "configuration.operator_settings",
          "prompt.runtime_guidance",
        ],
      },
    },
  });

  const applied = executor.apply({
    assignmentId: assignment.assignment.id,
    target: "prompt",
    mutationType: "runtime_guidance",
    rationale: "Prefer evidence-first wakeup summaries.",
    proposedChange: {
      runtimeGuidance: {
        text: "Prefer evidence-first wakeup summaries.",
      },
    },
  });

  assert.equal(
    promptGuidance.get().text,
    "Prefer evidence-first wakeup summaries."
  );
  assert.deepEqual(applied.mutation.rollback, {
    runtimeGuidance: { text: "" },
  });

  executor.rollback({
    assignmentId: assignment.assignment.id,
    mutationId: applied.mutation.id,
  });

  assert.equal(promptGuidance.get().text, "");
  database.close();
});

test("AutonomousMutationExecutor applies explicit memory policy runtime bounds mutations", () => {
  const { assignments, database, executor, ledger, memoryPolicy } =
    createMemoryPolicyHarness();
  const before = memoryPolicyValues(memoryPolicy.get());
  const assignment = assignments.create({
    objective: "Tune memory runtime bounds",
    autonomyLevel: "evolve",
    policy: {
      selfEvolution: {
        allowedMutationClasses: [
          "configuration.operator_settings",
          "memory_policy.runtime_bounds",
        ],
      },
    },
  });

  const applied = executor.apply({
    assignmentId: assignment.assignment.id,
    runId: "coord_memory_policy",
    target: "memory_policy",
    mutationType: "runtime_bounds",
    rationale: "Reduce memory retrieval context for autonomous work.",
    actor: "alice",
    proposedChange: {
      memoryPolicy: {
        memoryPerCategoryLimit: 2,
        memorySummaryLimit: 1,
        semanticPruneLimit: 10,
      },
    },
  });

  assert.equal(memoryPolicy.get().memoryPerCategoryLimit, 2);
  assert.equal(memoryPolicy.get().memorySummaryLimit, 1);
  assert.equal(memoryPolicy.get().semanticPruneLimit, 10);
  assert.equal(applied.mutation.status, "applied");
  assert.equal(applied.mutation.target, "memory_policy");
  assert.equal(applied.mutation.mutationType, "runtime_bounds");
  assert.deepEqual(applied.mutation.authorizingPolicy, {
    rule: "assignment.policy.selfEvolution",
    maxRiskClass: "medium",
    allowedMutationClasses: [
      "configuration.operator_settings",
      "memory_policy.runtime_bounds",
    ],
    mutationClass: "memory_policy.runtime_bounds",
    actor: "alice",
  });
  assert.deepEqual(applied.mutation.before, before);
  assert.deepEqual(applied.mutation.after, {
    ...before,
    memoryPerCategoryLimit: 2,
    memorySummaryLimit: 1,
    semanticPruneLimit: 10,
  });
  assert.deepEqual(applied.mutation.rollback, {
    memoryPolicy: before,
  });
  assert.deepEqual(applied.mutation.affectedResources, [
    { type: "memory_policy", id: "runtime_bounds" },
  ]);
  assert.deepEqual(applied.mutation.verification, {
    attempted: true,
    result: "passed",
    method: "memory_policy_runtime_bounds_update",
  });
  assert.deepEqual(
    ledger.list({ assignmentId: assignment.assignment.id }).map((mutation) => ({
      id: mutation.id,
      status: mutation.status,
    })),
    [{ id: applied.mutation.id, status: "applied" }]
  );

  const rolledBack = executor.rollback({
    assignmentId: assignment.assignment.id,
    mutationId: applied.mutation.id,
    actor: "bob",
  });

  assert.deepEqual(memoryPolicyValues(memoryPolicy.get()), before);
  assert.equal(rolledBack.mutation.status, "rolled_back");
  assert.deepEqual(rolledBack.mutation.verification, {
    attempted: true,
    result: "passed",
    method: "memory_policy_runtime_bounds_rollback",
  });
  assert.deepEqual(
    assignments
      .timeline(assignment.assignment.id)
      .events.map((event) => event.type),
    ["created", "mutation_planned", "mutation_applied", "mutation_rolled_back"]
  );

  database.close();
});

test("AutonomousMutationExecutor keeps memory policy mutations explicitly opt-in", () => {
  const { assignments, database, executor, ledger, memoryPolicy } =
    createMemoryPolicyHarness();
  const before = memoryPolicyValues(memoryPolicy.get());
  const assignment = assignments.create({
    objective: "Default policy should not mutate memory policy",
    autonomyLevel: "evolve",
  });

  assert.throws(
    () =>
      executor.apply({
        assignmentId: assignment.assignment.id,
        target: "memory_policy",
        mutationType: "runtime_bounds",
        rationale: "Try memory policy mutation without explicit opt-in.",
        proposedChange: {
          memoryPolicy: { memorySummaryLimit: 1 },
        },
      }),
    (error) => {
      assert.ok(error instanceof AutonomousMutationExecutionError);
      assert.equal(error.status, 403);
      assert.equal(error.mutation?.status, "failed");
      assert.match(
        error.message,
        /does not allow memory_policy\.runtime_bounds/
      );
      return true;
    }
  );

  assert.deepEqual(memoryPolicyValues(memoryPolicy.get()), before);
  assert.deepEqual(
    ledger.list({ assignmentId: assignment.assignment.id }).map((mutation) => ({
      status: mutation.status,
      mutationType: mutation.mutationType,
      authorizingPolicy: mutation.authorizingPolicy,
      errorMessage: mutation.errorMessage,
    })),
    [
      {
        status: "failed",
        mutationType: "runtime_bounds",
        authorizingPolicy: {
          rule: "assignment.policy.selfEvolution",
          maxRiskClass: "medium",
          allowedMutationClasses: ["configuration.operator_settings"],
          mutationClass: "memory_policy.runtime_bounds",
        },
        errorMessage:
          "Assignment self-evolution policy does not allow memory_policy.runtime_bounds",
      },
    ]
  );
  database.close();
});

test("AutonomousMutationExecutor rejects malformed memory policy mutations without changing policy", () => {
  const { assignments, database, executor, ledger, memoryPolicy } =
    createMemoryPolicyHarness();
  const before = memoryPolicyValues(memoryPolicy.get());
  const assignment = assignments.create({
    objective: "Reject unsafe memory policy bounds",
    autonomyLevel: "evolve",
    policy: {
      selfEvolution: {
        allowedMutationClasses: [
          "configuration.operator_settings",
          "memory_policy.runtime_bounds",
        ],
      },
    },
  });

  assert.throws(
    () =>
      executor.apply({
        assignmentId: assignment.assignment.id,
        target: "memory_policy",
        mutationType: "runtime_bounds",
        rationale: "Try an invalid memory retrieval bound.",
        proposedChange: {
          memoryPolicy: { memoryTopK: 0 },
        },
      }),
    (error) => {
      assert.ok(error instanceof AutonomousMutationExecutionError);
      assert.equal(error.status, 400);
      assert.equal(error.mutation?.status, "failed");
      assert.match(error.message, /memoryPolicy\.memoryTopK/);
      return true;
    }
  );

  assert.throws(
    () =>
      executor.apply({
        assignmentId: assignment.assignment.id,
        target: "memory_policy",
        mutationType: "runtime_bounds",
        rationale: "Try an unsupported memory policy field.",
        proposedChange: {
          memoryPolicy: { memoryEntryRewriteLimit: 3 },
        },
      }),
    (error) => {
      assert.ok(error instanceof AutonomousMutationExecutionError);
      assert.equal(error.status, 400);
      assert.equal(error.mutation?.status, "failed");
      assert.match(error.message, /memoryPolicy\.memoryEntryRewriteLimit/);
      return true;
    }
  );

  assert.deepEqual(memoryPolicyValues(memoryPolicy.get()), before);
  assert.deepEqual(
    ledger
      .list({ assignmentId: assignment.assignment.id })
      .map((mutation) => ({
        target: mutation.target,
        mutationType: mutation.mutationType,
        status: mutation.status,
        errorMessage: mutation.errorMessage,
      }))
      .sort((left, right) =>
        String(left.errorMessage).localeCompare(String(right.errorMessage))
      ),
    [
      {
        target: "memory_policy",
        mutationType: "runtime_bounds",
        status: "failed",
        errorMessage: "memoryPolicy.memoryEntryRewriteLimit is not supported",
      },
      {
        target: "memory_policy",
        mutationType: "runtime_bounds",
        status: "failed",
        errorMessage:
          "memoryPolicy.memoryTopK must be an integer between 1 and 50",
      },
    ]
  );

  database.close();
});

test("AutonomousMutationExecutor blocks stale memory policy rollback across assignments", () => {
  const { assignments, database, executor, memoryPolicy } =
    createMemoryPolicyHarness();
  const selfEvolution = {
    allowedMutationClasses: [
      "configuration.operator_settings",
      "memory_policy.runtime_bounds",
    ],
  };
  const first = assignments.create({
    objective: "First memory policy mutation",
    autonomyLevel: "evolve",
    policy: { selfEvolution },
  });
  const second = assignments.create({
    objective: "Second memory policy mutation",
    autonomyLevel: "evolve",
    policy: { selfEvolution },
  });

  const firstApplied = executor.apply({
    assignmentId: first.assignment.id,
    target: "memory_policy",
    mutationType: "runtime_bounds",
    rationale: "Set first memory policy bound.",
    proposedChange: {
      memoryPolicy: { memorySummaryLimit: 1 },
    },
  });
  const secondApplied = executor.apply({
    assignmentId: second.assignment.id,
    target: "memory_policy",
    mutationType: "runtime_bounds",
    rationale: "Set second memory policy bound.",
    proposedChange: {
      memoryPolicy: { memorySummaryLimit: 2 },
    },
  });

  assert.equal(secondApplied.mutation.status, "applied");
  assert.equal(memoryPolicy.get().memorySummaryLimit, 2);
  assert.throws(
    () =>
      executor.rollback({
        assignmentId: first.assignment.id,
        mutationId: firstApplied.mutation.id,
      }),
    (error) => {
      assert.ok(error instanceof AutonomousMutationExecutionError);
      assert.equal(error.status, 409);
      assert.match(
        error.message,
        /newer applied memory_policy\.runtime_bounds/
      );
      return true;
    }
  );
  assert.equal(memoryPolicy.get().memorySummaryLimit, 2);

  database.close();
});

test("AutonomousMutationExecutor applies explicit role permission policy mutations", () => {
  const { assignments, database, executor, ledger, rolePolicy } =
    createRolePolicyHarness();
  const before = rolePolicyRuntimeSnapshot(rolePolicy.get());
  const assignment = assignments.create({
    objective: "Narrow explorer role policy",
    autonomyLevel: "evolve",
    policy: {
      selfEvolution: {
        allowedMutationClasses: [
          "configuration.operator_settings",
          "role.permission_policy",
        ],
      },
    },
  });

  const applied = executor.apply({
    assignmentId: assignment.assignment.id,
    runId: "coord_role_policy",
    target: "role",
    mutationType: "permission_policy",
    rationale: "Limit explorer subagents to docs reads for this assignment.",
    actor: "alice",
    proposedChange: {
      rolePolicy: {
        roles: {
          explorer: {
            mode: "read_only",
            fileGlobs: ["docs/**/*"],
            allowedToolIds: ["echo.summary"],
            allowedMcpServers: ["docs"],
          },
        },
      },
    },
  });

  assert.deepEqual(rolePolicy.get().overrides, {
    explorer: {
      mode: "read_only",
      fileGlobs: ["docs/**/*"],
      allowedToolIds: ["echo.summary"],
      allowedMcpServers: ["docs"],
    },
  });
  assert.deepEqual(rolePolicy.get().baselines.explorer, {
    mode: "read_only",
    fileGlobs: ["docs/**/*"],
    allowedToolIds: ["echo.summary"],
    allowedMcpServers: ["docs"],
  });
  assert.equal(applied.mutation.status, "applied");
  assert.equal(applied.mutation.target, "role");
  assert.equal(applied.mutation.mutationType, "permission_policy");
  assert.deepEqual(applied.mutation.authorizingPolicy, {
    rule: "assignment.policy.selfEvolution",
    maxRiskClass: "medium",
    allowedMutationClasses: [
      "configuration.operator_settings",
      "role.permission_policy",
    ],
    mutationClass: "role.permission_policy",
    actor: "alice",
  });
  assert.deepEqual(applied.mutation.before, before);
  assert.deepEqual(
    applied.mutation.after,
    rolePolicyRuntimeSnapshot(rolePolicy.get())
  );
  assert.deepEqual(applied.mutation.rollback, {
    rolePolicy: { overrides: before.overrides },
  });
  assert.deepEqual(applied.mutation.affectedResources, [
    { type: "role_policy", id: "runtime" },
  ]);
  assert.deepEqual(applied.mutation.verification, {
    attempted: true,
    result: "passed",
    method: "role_permission_policy_update",
  });
  assert.deepEqual(
    ledger.list({ assignmentId: assignment.assignment.id }).map((mutation) => ({
      id: mutation.id,
      status: mutation.status,
    })),
    [{ id: applied.mutation.id, status: "applied" }]
  );

  const rolledBack = executor.rollback({
    assignmentId: assignment.assignment.id,
    mutationId: applied.mutation.id,
    actor: "bob",
  });

  assert.deepEqual(rolePolicyRuntimeSnapshot(rolePolicy.get()), before);
  assert.equal(rolledBack.mutation.status, "rolled_back");
  assert.deepEqual(rolledBack.mutation.verification, {
    attempted: true,
    result: "passed",
    method: "role_permission_policy_rollback",
  });
  assert.deepEqual(
    assignments
      .timeline(assignment.assignment.id)
      .events.map((event) => event.type),
    ["created", "mutation_planned", "mutation_applied", "mutation_rolled_back"]
  );

  database.close();
});

test("AutonomousMutationExecutor keeps role permission policy mutations explicitly opt-in", () => {
  const { assignments, database, executor, ledger, rolePolicy } =
    createRolePolicyHarness();
  const before = rolePolicyRuntimeSnapshot(rolePolicy.get());
  const assignment = assignments.create({
    objective: "Default policy should not mutate role policy",
    autonomyLevel: "evolve",
  });

  assert.throws(
    () =>
      executor.apply({
        assignmentId: assignment.assignment.id,
        target: "role",
        mutationType: "permission_policy",
        rationale: "Try role policy mutation without explicit opt-in.",
        proposedChange: {
          rolePolicy: {
            roles: {
              explorer: { allowedMcpServers: ["docs"] },
            },
          },
        },
      }),
    (error) => {
      assert.ok(error instanceof AutonomousMutationExecutionError);
      assert.equal(error.status, 403);
      assert.equal(error.mutation?.status, "failed");
      assert.match(error.message, /does not allow role\.permission_policy/);
      return true;
    }
  );

  assert.deepEqual(rolePolicyRuntimeSnapshot(rolePolicy.get()), before);
  assert.deepEqual(
    ledger.list({ assignmentId: assignment.assignment.id }).map((mutation) => ({
      status: mutation.status,
      mutationType: mutation.mutationType,
      authorizingPolicy: mutation.authorizingPolicy,
      errorMessage: mutation.errorMessage,
    })),
    [
      {
        status: "failed",
        mutationType: "permission_policy",
        authorizingPolicy: {
          rule: "assignment.policy.selfEvolution",
          maxRiskClass: "medium",
          allowedMutationClasses: ["configuration.operator_settings"],
          mutationClass: "role.permission_policy",
        },
        errorMessage:
          "Assignment self-evolution policy does not allow role.permission_policy",
      },
    ]
  );
  database.close();
});

test("AutonomousMutationExecutor rejects malformed role policy mutations without changing policy", () => {
  const { assignments, database, executor, ledger, rolePolicy } =
    createRolePolicyHarness();
  const before = rolePolicyRuntimeSnapshot(rolePolicy.get());
  const assignment = assignments.create({
    objective: "Reject unsafe role policy",
    autonomyLevel: "evolve",
    policy: {
      selfEvolution: {
        allowedMutationClasses: [
          "configuration.operator_settings",
          "role.permission_policy",
        ],
      },
    },
  });

  assert.throws(
    () =>
      executor.apply({
        assignmentId: assignment.assignment.id,
        target: "role",
        mutationType: "permission_policy",
        rationale: "Try an unsupported role.",
        proposedChange: {
          rolePolicy: {
            roles: {
              coordinator: { allowedMcpServers: ["repo"] },
            },
          },
        },
      }),
    (error) => {
      assert.ok(error instanceof AutonomousMutationExecutionError);
      assert.equal(error.status, 400);
      assert.equal(error.mutation?.status, "failed");
      assert.match(error.message, /rolePolicy\.roles\.coordinator/);
      return true;
    }
  );

  assert.throws(
    () =>
      executor.apply({
        assignmentId: assignment.assignment.id,
        target: "role",
        mutationType: "permission_policy",
        rationale: "Try widening explorer MCP access.",
        proposedChange: {
          rolePolicy: {
            roles: {
              explorer: { allowedMcpServers: ["repo"] },
            },
          },
        },
      }),
    (error) => {
      assert.ok(error instanceof AutonomousMutationExecutionError);
      assert.equal(error.status, 400);
      assert.equal(error.mutation?.status, "failed");
      assert.match(
        error.message,
        /rolePolicy\.roles\.explorer\.allowedMcpServers cannot include repo/
      );
      return true;
    }
  );

  assert.throws(
    () =>
      executor.apply({
        assignmentId: assignment.assignment.id,
        target: "role",
        mutationType: "permission_policy",
        rationale: "Try escalating read-only explorer to write scope.",
        proposedChange: {
          rolePolicy: {
            roles: {
              explorer: { mode: "scoped_write" },
            },
          },
        },
      }),
    (error) => {
      assert.ok(error instanceof AutonomousMutationExecutionError);
      assert.equal(error.status, 400);
      assert.equal(error.mutation?.status, "failed");
      assert.match(
        error.message,
        /rolePolicy\.roles\.explorer\.mode cannot exceed baseline read_only/
      );
      return true;
    }
  );

  assert.deepEqual(rolePolicyRuntimeSnapshot(rolePolicy.get()), before);
  assert.deepEqual(
    ledger
      .list({ assignmentId: assignment.assignment.id })
      .map((mutation) => ({
        target: mutation.target,
        mutationType: mutation.mutationType,
        status: mutation.status,
        errorMessage: mutation.errorMessage,
      }))
      .sort((left, right) =>
        String(left.errorMessage).localeCompare(String(right.errorMessage))
      ),
    [
      {
        target: "role",
        mutationType: "permission_policy",
        status: "failed",
        errorMessage: "rolePolicy.roles.coordinator is not supported",
      },
      {
        target: "role",
        mutationType: "permission_policy",
        status: "failed",
        errorMessage:
          "rolePolicy.roles.explorer.allowedMcpServers cannot include repo",
      },
      {
        target: "role",
        mutationType: "permission_policy",
        status: "failed",
        errorMessage:
          "rolePolicy.roles.explorer.mode cannot exceed baseline read_only",
      },
    ]
  );

  database.close();
});

test("AutonomousMutationExecutor blocks stale role policy rollback across assignments", () => {
  const { assignments, database, executor, rolePolicy } =
    createRolePolicyHarness();
  const selfEvolution = {
    allowedMutationClasses: [
      "configuration.operator_settings",
      "role.permission_policy",
    ],
  };
  const first = assignments.create({
    objective: "First role policy mutation",
    autonomyLevel: "evolve",
    policy: { selfEvolution },
  });
  const second = assignments.create({
    objective: "Second role policy mutation",
    autonomyLevel: "evolve",
    policy: { selfEvolution },
  });

  const firstApplied = executor.apply({
    assignmentId: first.assignment.id,
    target: "role",
    mutationType: "permission_policy",
    rationale: "Set first role policy override.",
    proposedChange: {
      rolePolicy: {
        roles: { explorer: { allowedMcpServers: ["docs"] } },
      },
    },
  });
  const secondApplied = executor.apply({
    assignmentId: second.assignment.id,
    target: "role",
    mutationType: "permission_policy",
    rationale: "Set second role policy override.",
    proposedChange: {
      rolePolicy: {
        roles: { explorer: { allowedToolIds: ["echo.summary"] } },
      },
    },
  });

  assert.equal(secondApplied.mutation.status, "applied");
  assert.deepEqual(rolePolicy.get().overrides.explorer, {
    allowedMcpServers: ["docs"],
    allowedToolIds: ["echo.summary"],
  });
  assert.throws(
    () =>
      executor.rollback({
        assignmentId: first.assignment.id,
        mutationId: firstApplied.mutation.id,
      }),
    (error) => {
      assert.ok(error instanceof AutonomousMutationExecutionError);
      assert.equal(error.status, 409);
      assert.match(error.message, /newer applied role\.permission_policy/);
      return true;
    }
  );
  assert.deepEqual(rolePolicy.get().overrides.explorer, {
    allowedMcpServers: ["docs"],
    allowedToolIds: ["echo.summary"],
  });

  database.close();
});

test("AutonomousMutationExecutor applies explicit project file draft mutations", () => {
  const { assignments, database, executor, ledger, projectFileDrafts } =
    createProjectFileDraftHarness();
  const assignment = assignments.create({
    objective: "Draft docs update",
    autonomyLevel: "evolve",
    policy: {
      selfEvolution: {
        allowedMutationClasses: [
          "configuration.operator_settings",
          "project_file.draft",
        ],
      },
    },
  });
  const draftPath = "docs/autonomous-project-file-draft-test.md";

  const applied = executor.apply({
    assignmentId: assignment.assignment.id,
    runId: "coord_project_file_draft",
    target: "project_file",
    mutationType: "draft",
    rationale: "Draft a docs update without writing the repository.",
    proposedChange: {
      projectFileDraft: {
        path: draftPath,
        content: "# Draft\n\nThis is only a draft.\n",
        contentType: "text/markdown",
      },
    },
  });

  const drafts = projectFileDrafts.list({
    assignmentId: assignment.assignment.id,
  });
  assert.equal(drafts.length, 1);
  assert.equal(drafts[0]?.status, "active");
  assert.equal(drafts[0]?.path, draftPath);
  assert.equal(drafts[0]?.content, "# Draft\n\nThis is only a draft.\n");
  assert.equal(
    existsSync(join(process.cwd(), draftPath)),
    false,
    "project file draft mutation must not write to the repository filesystem"
  );
  assert.equal(applied.mutation.target, "project_file");
  assert.equal(applied.mutation.mutationType, "draft");
  assert.equal(applied.mutation.status, "applied");
  assert.deepEqual(applied.mutation.before, {
    path: draftPath,
    activeDrafts: [],
  });
  assert.deepEqual(applied.mutation.after, {
    draft: {
      id: drafts[0]?.id,
      assignmentId: assignment.assignment.id,
      runId: "coord_project_file_draft",
      path: draftPath,
      contentType: "text/markdown",
      sizeBytes: 31,
      sha256: drafts[0]?.sha256,
      status: "active",
    },
  });
  assert.deepEqual(applied.mutation.rollback, {
    projectFileDraft: { id: drafts[0]?.id },
  });
  assert.deepEqual(applied.mutation.affectedResources, [
    { type: "project_file_draft", id: drafts[0]?.id, path: draftPath },
  ]);
  assert.deepEqual(
    ledger.list({ assignmentId: assignment.assignment.id }).map((mutation) => ({
      id: mutation.id,
      status: mutation.status,
      mutationClass: (mutation.authorizingPolicy as { mutationClass?: string })
        .mutationClass,
    })),
    [
      {
        id: applied.mutation.id,
        status: "applied",
        mutationClass: "project_file.draft",
      },
    ]
  );
  assert.deepEqual(
    assignments
      .timeline(assignment.assignment.id)
      .events.map((event) => event.type),
    ["created", "mutation_planned", "mutation_applied"]
  );

  database.close();
});

test("AutonomousMutationExecutor keeps project file drafts explicitly opt-in", () => {
  const { assignments, database, executor, projectFileDrafts } =
    createProjectFileDraftHarness();
  const assignment = assignments.create({
    objective: "Denied draft",
    autonomyLevel: "evolve",
  });

  assert.throws(
    () =>
      executor.apply({
        assignmentId: assignment.assignment.id,
        target: "project_file",
        mutationType: "draft",
        rationale: "Default policy should not permit drafts.",
        proposedChange: {
          projectFileDraft: {
            path: "docs/denied.md",
            content: "Denied",
          },
        },
      }),
    (error) => {
      assert.ok(error instanceof AutonomousMutationExecutionError);
      assert.equal(error.status, 403);
      assert.match(error.message, /does not allow project_file\.draft/);
      return true;
    }
  );
  assert.deepEqual(projectFileDrafts.list(), []);

  for (const autonomyLevel of ["execute", "draft", "observe"] as const) {
    const blocked = assignments.create({
      objective: `Denied ${autonomyLevel} draft`,
      autonomyLevel,
      policy: {
        selfEvolution: {
          allowedMutationClasses: [
            "configuration.operator_settings",
            "project_file.draft",
          ],
        },
      },
    });
    assert.throws(
      () =>
        executor.apply({
          assignmentId: blocked.assignment.id,
          target: "project_file",
          mutationType: "draft",
          rationale: `${autonomyLevel} assignments cannot draft project files.`,
          proposedChange: {
            projectFileDraft: {
              path: `docs/${autonomyLevel}-denied.md`,
              content: "Denied",
            },
          },
        }),
      (error) => {
        assert.ok(error instanceof AutonomousMutationExecutionError);
        assert.equal(error.status, 403);
        assert.match(error.message, /Assignment autonomyLevel must be evolve/);
        return true;
      }
    );
  }
  assert.deepEqual(projectFileDrafts.list(), []);

  database.close();
});

test("AutonomousMutationExecutor rejects unsafe project file drafts without creating rows", () => {
  const { assignments, database, executor, ledger, projectFileDrafts } =
    createProjectFileDraftHarness();
  const assignment = assignments.create({
    objective: "Reject unsafe drafts",
    autonomyLevel: "evolve",
    policy: {
      selfEvolution: {
        allowedMutationClasses: [
          "configuration.operator_settings",
          "project_file.draft",
        ],
      },
    },
  });
  const attempts = [
    {
      draft: {
        path: "/tmp/escape.md",
        content: "absolute",
        contentType: "text/markdown",
      },
      message: /path must be relative/,
    },
    {
      draft: {
        path: "../escape.md",
        content: "parent",
        contentType: "text/markdown",
      },
      message: /path cannot contain \.\. segments/,
    },
    {
      draft: {
        path: "C:/escape.md",
        content: "drive",
        contentType: "text/markdown",
      },
      message: /path must be relative/,
    },
    {
      draft: {
        path: "docs\\escape.md",
        content: "backslash",
        contentType: "text/markdown",
      },
      message: /path must use clean forward-slash path segments/,
    },
    {
      draft: {
        path: "docs/\u0000escape.md",
        content: "control",
        contentType: "text/markdown",
      },
      message: /path must use clean forward-slash path segments/,
    },
    {
      draft: {
        path: ".env",
        content: "secret",
        contentType: "text/plain",
      },
      message: /path cannot target protected project location/,
    },
    {
      draft: {
        path: "docs/.env",
        content: "nested secret",
        contentType: "text/plain",
      },
      message: /path cannot target protected project location/,
    },
    {
      draft: {
        path: "docs/binary.bin",
        content: "binary",
        contentType: "application/octet-stream",
      },
      message: /contentType must be a safe text content type/,
    },
    {
      draft: {
        path: "docs/empty.md",
        content: "",
        contentType: "text/markdown",
      },
      message: /content must be a non-empty string/,
    },
    {
      draft: {
        path: "docs/oversize.md",
        content: "x".repeat(200_001),
        contentType: "text/markdown",
      },
      message: /content exceeds 200000 bytes/,
    },
  ];

  for (const attempt of attempts) {
    assert.throws(
      () =>
        executor.apply({
          assignmentId: assignment.assignment.id,
          target: "project_file",
          mutationType: "draft",
          rationale: `Reject ${attempt.draft.path}`,
          proposedChange: { projectFileDraft: attempt.draft },
        }),
      (error) => {
        assert.ok(error instanceof AutonomousMutationExecutionError);
        assert.equal(error.status, 400);
        assert.equal(error.mutation?.status, "failed");
        assert.match(error.message, attempt.message);
        return true;
      }
    );
  }

  assert.deepEqual(projectFileDrafts.list(), []);
  assert.equal(
    ledger
      .list({ assignmentId: assignment.assignment.id })
      .filter((mutation) => mutation.status === "failed").length,
    attempts.length
  );

  database.close();
});

test("AutonomousMutationExecutor rolls back project file draft mutations", () => {
  const { assignments, database, executor, projectFileDrafts } =
    createProjectFileDraftHarness();
  const assignment = assignments.create({
    objective: "Rollback draft",
    autonomyLevel: "evolve",
    policy: {
      selfEvolution: {
        allowedMutationClasses: [
          "configuration.operator_settings",
          "project_file.draft",
        ],
      },
    },
  });
  const applied = executor.apply({
    assignmentId: assignment.assignment.id,
    target: "project_file",
    mutationType: "draft",
    rationale: "Create draft for rollback.",
    proposedChange: {
      projectFileDraft: {
        path: "docs/rollback-draft.md",
        content: "Rollback me",
      },
    },
  });
  const draftId = (
    applied.mutation.rollback as {
      projectFileDraft?: { id?: string };
    }
  ).projectFileDraft?.id;
  assert.ok(draftId);

  const rolledBack = executor.rollback({
    assignmentId: assignment.assignment.id,
    mutationId: applied.mutation.id,
  });

  assert.equal(rolledBack.mutation.status, "rolled_back");
  const draft = projectFileDrafts.get(draftId);
  assert.equal(draft?.status, "rolled_back");
  assert.equal(draft?.content, "Rollback me");
  assert.equal(
    existsSync(join(process.cwd(), "docs/rollback-draft.md")),
    false
  );
  assert.deepEqual(
    assignments
      .timeline(assignment.assignment.id)
      .events.map((event) => event.type),
    ["created", "mutation_planned", "mutation_applied", "mutation_rolled_back"]
  );

  database.close();
});

test("AutonomousMutationExecutor blocks stale project file draft rollback", () => {
  const { assignments, database, executor } = createProjectFileDraftHarness();
  const selfEvolution = {
    allowedMutationClasses: [
      "configuration.operator_settings",
      "project_file.draft",
    ],
  };
  const assignment = assignments.create({
    objective: "Block stale project draft rollback",
    autonomyLevel: "evolve",
    policy: { selfEvolution },
  });
  const first = executor.apply({
    assignmentId: assignment.assignment.id,
    target: "project_file",
    mutationType: "draft",
    rationale: "First draft.",
    proposedChange: {
      projectFileDraft: {
        path: "docs/stale-draft.md",
        content: "First",
      },
    },
  });
  executor.apply({
    assignmentId: assignment.assignment.id,
    target: "project_file",
    mutationType: "draft",
    rationale: "Second draft.",
    proposedChange: {
      projectFileDraft: {
        path: "docs/stale-draft.md",
        content: "Second",
      },
    },
  });

  assert.throws(
    () =>
      executor.rollback({
        assignmentId: assignment.assignment.id,
        mutationId: first.mutation.id,
      }),
    (error) => {
      assert.ok(error instanceof AutonomousMutationExecutionError);
      assert.equal(error.status, 409);
      assert.match(error.message, /newer applied project_file\.draft/);
      return true;
    }
  );

  database.close();
});

test("AutonomousMutationExecutor blocks stale prompt runtime guidance rollback across assignments", () => {
  const { assignments, database, executor, promptGuidance } =
    createPromptGuidanceHarness();
  const first = assignments.create({
    objective: "First prompt guidance mutation",
    autonomyLevel: "evolve",
    policy: {
      selfEvolution: {
        allowedMutationClasses: [
          "configuration.operator_settings",
          "prompt.runtime_guidance",
        ],
      },
    },
  });
  const second = assignments.create({
    objective: "Second prompt guidance mutation",
    autonomyLevel: "evolve",
    policy: {
      selfEvolution: {
        allowedMutationClasses: [
          "configuration.operator_settings",
          "prompt.runtime_guidance",
        ],
      },
    },
  });

  const firstApplied = executor.apply({
    assignmentId: first.assignment.id,
    target: "prompt",
    mutationType: "runtime_guidance",
    rationale: "Prefer first guidance.",
    proposedChange: {
      runtimeGuidance: { text: "Prefer first guidance." },
    },
  });
  const secondApplied = executor.apply({
    assignmentId: second.assignment.id,
    target: "prompt",
    mutationType: "runtime_guidance",
    rationale: "Prefer second guidance.",
    proposedChange: {
      runtimeGuidance: { text: "Prefer second guidance." },
    },
  });

  assert.equal(secondApplied.mutation.status, "applied");
  assert.equal(promptGuidance.get().text, "Prefer second guidance.");
  assert.throws(
    () =>
      executor.rollback({
        assignmentId: first.assignment.id,
        mutationId: firstApplied.mutation.id,
      }),
    (error) => {
      assert.ok(error instanceof AutonomousMutationExecutionError);
      assert.equal(error.status, 409);
      assert.match(error.message, /newer applied prompt\.runtime_guidance/);
      return true;
    }
  );
  assert.equal(promptGuidance.get().text, "Prefer second guidance.");

  database.close();
});

test("AutonomousMutationExecutor keeps prompt runtime guidance mutations opt-in", () => {
  const { assignments, database, executor, promptGuidance } =
    createPromptGuidanceHarness();
  const assignment = assignments.create({
    objective: "Default policy should not mutate prompts",
    autonomyLevel: "evolve",
  });

  assert.throws(
    () =>
      executor.apply({
        assignmentId: assignment.assignment.id,
        target: "prompt",
        mutationType: "runtime_guidance",
        rationale: "Try prompt mutation without explicit opt-in.",
        proposedChange: {
          runtimeGuidance: { text: "Prefer shorter replies." },
        },
      }),
    (error) => {
      assert.ok(error instanceof AutonomousMutationExecutionError);
      assert.equal(error.status, 403);
      assert.equal(error.mutation?.status, "failed");
      assert.match(error.message, /does not allow prompt\.runtime_guidance/);
      return true;
    }
  );

  assert.equal(promptGuidance.get().text, "");
  database.close();
});

test("AutonomousMutationExecutor rejects malformed prompt runtime guidance mutations", () => {
  const { assignments, database, executor, ledger, promptGuidance } =
    createPromptGuidanceHarness();
  promptGuidance.update("Keep initial guidance.", "operator");
  const assignment = assignments.create({
    objective: "Reject unsafe prompt guidance changes",
    autonomyLevel: "evolve",
    policy: {
      selfEvolution: {
        allowedMutationClasses: [
          "configuration.operator_settings",
          "prompt.runtime_guidance",
        ],
      },
    },
  });

  assert.throws(
    () =>
      executor.apply({
        assignmentId: assignment.assignment.id,
        target: "prompt",
        mutationType: "runtime_guidance",
        rationale: "Try blank prompt guidance.",
        proposedChange: { runtimeGuidance: { text: "   " } },
      }),
    (error) => {
      assert.ok(error instanceof AutonomousMutationExecutionError);
      assert.equal(error.status, 400);
      assert.equal(error.mutation?.status, "failed");
      assert.match(error.message, /non-empty string/);
      return true;
    }
  );

  assert.throws(
    () =>
      executor.apply({
        assignmentId: assignment.assignment.id,
        target: "prompt",
        mutationType: "runtime_guidance",
        rationale: "Try oversized prompt guidance.",
        proposedChange: { runtimeGuidance: { text: "x".repeat(2001) } },
      }),
    (error) => {
      assert.ok(error instanceof AutonomousMutationExecutionError);
      assert.equal(error.status, 400);
      assert.equal(error.mutation?.status, "failed");
      assert.match(error.message, /2000 characters or less/);
      return true;
    }
  );

  assert.equal(promptGuidance.get().text, "Keep initial guidance.");
  assert.deepEqual(
    ledger.list({ assignmentId: assignment.assignment.id }).map((mutation) => ({
      target: mutation.target,
      mutationType: mutation.mutationType,
      status: mutation.status,
      errorMessage: mutation.errorMessage,
    })),
    [
      {
        target: "prompt",
        mutationType: "runtime_guidance",
        status: "failed",
        errorMessage: "runtimeGuidance.text must be 2000 characters or less",
      },
      {
        target: "prompt",
        mutationType: "runtime_guidance",
        status: "failed",
        errorMessage: "runtimeGuidance.text must be a non-empty string",
      },
    ]
  );

  database.close();
});

test("AutonomousMutationExecutor keeps tool bundle enable mutations opt-in", () => {
  const { assignments, database, executor, toolBundles, tools } =
    createToolBundleHarness();
  const bundle = previewApprovedReadOnlyBundle(toolBundles);
  const assignment = assignments.create({
    objective: "Default policy should not enable tools",
    autonomyLevel: "evolve",
  });

  assert.throws(
    () =>
      executor.apply({
        assignmentId: assignment.assignment.id,
        target: "tool",
        mutationType: "bundle_enable",
        rationale: "Try tool bundle enable without explicit opt-in.",
        proposedChange: {
          toolBundle: { importId: bundle.id },
        },
      }),
    (error) => {
      assert.ok(error instanceof AutonomousMutationExecutionError);
      assert.equal(error.status, 403);
      assert.equal(error.mutation?.status, "failed");
      assert.match(error.message, /does not allow tool\.bundle_enable/);
      return true;
    }
  );

  assert.equal(tools.has("internal.research.lookup"), false);
  assert.equal(toolBundles.get(bundle.id)?.lifecycleState, "approved");

  database.close();
});

test("AutonomousMutationExecutor rejects unsafe tool bundle enable mutations without registering tools", () => {
  const { assignments, database, executor, ledger, toolBundles, tools } =
    createToolBundleHarness();
  const unapproved = toolBundles.preview({
    importedBy: "operator",
    manifest: {
      id: "internal.pending",
      name: "Internal Pending",
      version: "1.0.0",
      tools: [
        {
          id: "internal.pending.lookup",
          description: "Pending lookup.",
          scopes: ["read"],
          responseTemplate: "pending",
        },
      ],
    },
  });
  const assignment = assignments.create({
    objective: "Reject unsafe tool bundle enable",
    autonomyLevel: "evolve",
    policy: {
      selfEvolution: {
        allowedMutationClasses: [
          "configuration.operator_settings",
          "tool.bundle_enable",
        ],
      },
    },
  });

  assert.throws(
    () =>
      executor.apply({
        assignmentId: assignment.assignment.id,
        target: "tool",
        mutationType: "bundle_enable",
        rationale: "Try enabling an unapproved bundle.",
        proposedChange: {
          toolBundle: { importId: unapproved.id },
        },
      }),
    (error) => {
      assert.ok(error instanceof AutonomousMutationExecutionError);
      assert.equal(error.status, 400);
      assert.equal(error.mutation?.status, "failed");
      assert.match(error.message, /must be approved/);
      return true;
    }
  );

  assert.throws(
    () =>
      executor.apply({
        assignmentId: assignment.assignment.id,
        target: "tool",
        mutationType: "bundle_enable",
        rationale: "Try malformed tool bundle mutation.",
        proposedChange: {
          toolBundle: {},
        },
      }),
    (error) => {
      assert.ok(error instanceof AutonomousMutationExecutionError);
      assert.equal(error.status, 400);
      assert.equal(error.mutation?.status, "failed");
      assert.match(error.message, /toolBundle.importId is required/);
      return true;
    }
  );

  assert.equal(tools.has("internal.pending.lookup"), false);
  assert.equal(toolBundles.get(unapproved.id)?.lifecycleState, "previewed");
  assert.deepEqual(
    ledger
      .list({ assignmentId: assignment.assignment.id })
      .map((mutation) => ({
        target: mutation.target,
        mutationType: mutation.mutationType,
        status: mutation.status,
        errorMessage: mutation.errorMessage,
      }))
      .sort((left, right) =>
        String(left.errorMessage).localeCompare(String(right.errorMessage))
      ),
    [
      {
        target: "tool",
        mutationType: "bundle_enable",
        status: "failed",
        errorMessage: "Tool bundle must be approved before it can be enabled",
      },
      {
        target: "tool",
        mutationType: "bundle_enable",
        status: "failed",
        errorMessage: "toolBundle.importId is required",
      },
    ]
  );

  database.close();
});

test("AutonomousMutationExecutor rolls back assignment policy mutations after operator tightens self-evolution policy", () => {
  const { assignments, database, executor } = createHarness();
  const assignment = assignments.create({
    objective: "Roll back assignment policy after authority tightening",
    autonomyLevel: "evolve",
    policy: {
      maxWakeups: 4,
      selfEvolution: {
        allowedMutationClasses: [
          "configuration.operator_settings",
          "configuration.assignment_policy",
        ],
      },
    },
  });
  const applied = executor.apply({
    assignmentId: assignment.assignment.id,
    target: "configuration",
    mutationType: "assignment_policy",
    rationale: "Temporarily increase wakeups.",
    proposedChange: {
      assignmentPolicy: { maxWakeups: 9 },
    },
  });
  assert.equal(
    assignments.getRequired(assignment.assignment.id).assignment.policy
      .maxWakeups,
    9
  );

  assignments.control(assignment.assignment.id, {
    action: "change_policy",
    actor: "operator",
    reason: "Tighten mutation authority after the temporary change.",
    policy: {
      selfEvolution: {
        allowedMutationClasses: ["configuration.operator_settings"],
      },
    },
  });

  const rolledBack = executor.rollback({
    assignmentId: assignment.assignment.id,
    mutationId: applied.mutation.id,
    actor: "operator",
  });

  const policy = assignments.getRequired(assignment.assignment.id).assignment
    .policy;
  assert.equal(rolledBack.mutation.status, "rolled_back");
  assert.equal(policy.maxWakeups, 4);
  assert.deepEqual(policy.selfEvolution.allowedMutationClasses, [
    "configuration.operator_settings",
  ]);
  assert.deepEqual(
    assignments
      .timeline(assignment.assignment.id)
      .events.filter(
        (event) =>
          event.type === "policy_changed" ||
          event.type === "mutation_rolled_back"
      )
      .map((event) => ({
        type: event.type,
        actor: (event.payload as { actor?: string | null }).actor,
      })),
    [
      { type: "policy_changed", actor: "autonomous_mutation" },
      { type: "policy_changed", actor: "operator" },
      { type: "policy_changed", actor: "operator" },
      { type: "mutation_rolled_back", actor: "operator" },
    ]
  );

  database.close();
});

test("AutonomousMutationExecutor blocks assignment policy authority escalation", () => {
  const { assignments, database, executor, ledger } = createHarness();
  const assignment = assignments.create({
    objective: "Do not let assignment policy mutate self-evolution",
    autonomyLevel: "evolve",
    policy: {
      selfEvolution: {
        allowedMutationClasses: [
          "configuration.operator_settings",
          "configuration.assignment_policy",
        ],
      },
    },
  });

  assert.throws(
    () =>
      executor.apply({
        assignmentId: assignment.assignment.id,
        target: "configuration",
        mutationType: "assignment_policy",
        rationale: "Try to widen mutation authority.",
        proposedChange: {
          assignmentPolicy: {
            selfEvolution: {
              allowedMutationClasses: [
                "configuration.operator_settings",
                "configuration.assignment_policy",
                "tool.bundle_enable",
              ],
            },
          },
        },
      }),
    (error) => {
      assert.ok(error instanceof AutonomousMutationExecutionError);
      assert.equal(error.status, 400);
      assert.equal(error.mutation?.status, "failed");
      assert.match(
        error.message,
        /assignmentPolicy.selfEvolution cannot be changed/
      );
      return true;
    }
  );

  assert.deepEqual(
    assignments.getRequired(assignment.assignment.id).assignment.policy,
    assignment.assignment.policy
  );
  assert.deepEqual(
    ledger.list({ assignmentId: assignment.assignment.id }).map((mutation) => ({
      status: mutation.status,
      mutationType: mutation.mutationType,
      errorMessage: mutation.errorMessage,
    })),
    [
      {
        status: "failed",
        mutationType: "assignment_policy",
        errorMessage:
          "assignmentPolicy.selfEvolution cannot be changed by autonomous assignment policy mutations",
      },
    ]
  );

  database.close();
});

test("AutonomousMutationExecutor keeps assignment policy mutations opt-in", () => {
  const { assignments, database, executor, ledger } = createHarness();
  const assignment = assignments.create({
    objective: "Default policy should not mutate assignment policy",
    autonomyLevel: "evolve",
  });

  assert.throws(
    () =>
      executor.apply({
        assignmentId: assignment.assignment.id,
        target: "configuration",
        mutationType: "assignment_policy",
        rationale: "Try assignment policy mutation without explicit opt-in.",
        proposedChange: {
          assignmentPolicy: { maxWakeups: 9 },
        },
      }),
    (error) => {
      assert.ok(error instanceof AutonomousMutationExecutionError);
      assert.equal(error.status, 403);
      assert.equal(error.mutation?.status, "failed");
      assert.match(
        error.message,
        /does not allow configuration\.assignment_policy/
      );
      return true;
    }
  );

  assert.equal(
    assignments.getRequired(assignment.assignment.id).assignment.policy
      .maxWakeups,
    5
  );
  assert.deepEqual(
    ledger.list({ assignmentId: assignment.assignment.id }).map((mutation) => ({
      status: mutation.status,
      mutationType: mutation.mutationType,
      authorizingPolicy: mutation.authorizingPolicy,
      errorMessage: mutation.errorMessage,
    })),
    [
      {
        status: "failed",
        mutationType: "assignment_policy",
        authorizingPolicy: {
          rule: "assignment.policy.selfEvolution",
          maxRiskClass: "medium",
          allowedMutationClasses: ["configuration.operator_settings"],
          mutationClass: "configuration.assignment_policy",
        },
        errorMessage:
          "Assignment self-evolution policy does not allow configuration.assignment_policy",
      },
    ]
  );

  database.close();
});

test("AutonomousMutationExecutor rejects malformed assignment policy mutations without changing policy", () => {
  const { assignments, database, executor, ledger } = createHarness();
  const assignment = assignments.create({
    objective: "Reject malformed assignment policy mutation",
    autonomyLevel: "evolve",
    policy: {
      maxWakeups: 5,
      selfEvolution: {
        allowedMutationClasses: [
          "configuration.operator_settings",
          "configuration.assignment_policy",
        ],
      },
    },
  });

  assert.throws(
    () =>
      executor.apply({
        assignmentId: assignment.assignment.id,
        target: "configuration",
        mutationType: "assignment_policy",
        rationale: "Try an invalid wakeup budget.",
        proposedChange: {
          assignmentPolicy: { maxWakeups: 0 },
        },
      }),
    (error) => {
      assert.ok(error instanceof AutonomousMutationExecutionError);
      assert.equal(error.status, 400);
      assert.equal(error.mutation?.status, "failed");
      assert.match(error.message, /maxWakeups must be a positive integer/);
      return true;
    }
  );

  assert.equal(
    assignments.getRequired(assignment.assignment.id).assignment.policy
      .maxWakeups,
    5
  );
  assert.deepEqual(
    ledger.list({ assignmentId: assignment.assignment.id }).map((mutation) => ({
      status: mutation.status,
      errorMessage: mutation.errorMessage,
    })),
    [
      {
        status: "failed",
        errorMessage: "maxWakeups must be a positive integer",
      },
    ]
  );

  database.close();
});

test("AutonomousMutationExecutor rejects duplicate autonomous mutation adapters", () => {
  const database = new AppDatabase(":memory:");
  const assignments = new AutonomousAssignmentService(database);
  const ledger = new AutonomousMutationLedger(database, assignments);
  const settings = new OperatorSettingsStore(database);
  const adapter: AutonomousMutationAdapter = {
    target: "configuration",
    mutationType: "fake_settings",
    mutationClass: "configuration.fake_settings",
    affectedResources: [{ type: "settings", id: "fake" }],
    apply() {
      return {
        before: { value: "before" },
        after: { value: "after" },
        rollback: { fakeSettings: { value: "before" } },
      };
    },
    rollback() {},
  };

  assert.throws(
    () =>
      new AutonomousMutationExecutor({
        assignments,
        ledger,
        settings,
        adapters: [adapter, adapter],
      }),
    /Duplicate autonomous mutation adapter for configuration\.fake_settings/
  );

  database.close();
});

test("AutonomousMutationExecutor blocks non-evolve assignments without mutation evidence", () => {
  for (const autonomyLevel of ["execute", "draft", "observe"] as const) {
    const { assignments, database, executor, ledger, settings } =
      createHarness();
    const assignment = assignments.create({
      objective: `Blocked ${autonomyLevel} mutation`,
      autonomyLevel,
    });

    assert.throws(
      () =>
        executor.apply({
          assignmentId: assignment.assignment.id,
          target: "configuration",
          mutationType: "operator_settings",
          rationale: "Try to mutate without evolve authority.",
          proposedChange: {
            operatorSettings: { dashboardRefreshSeconds: 12 },
          },
        }),
      (error) => {
        assert.ok(error instanceof AutonomousMutationExecutionError);
        assert.equal(error.status, 403);
        assert.match(error.message, /must be evolve/);
        return true;
      }
    );
    assert.equal(settings.get().dashboardRefreshSeconds, 5);
    assert.deepEqual(
      ledger.list({ assignmentId: assignment.assignment.id }),
      []
    );

    database.close();
  }
});

test("AutonomousMutationExecutor audits unsupported and malformed autonomous mutations as failed", () => {
  const { assignments, database, executor, ledger, settings } = createHarness();
  const assignment = assignments.create({
    objective: "Audit failed autonomous mutations",
    autonomyLevel: "evolve",
  });

  assert.throws(
    () =>
      executor.apply({
        assignmentId: assignment.assignment.id,
        target: "tool",
        mutationType: "tool_bundle_enable",
        rationale: "Try a deferred mutation class.",
        proposedChange: { toolBundleId: "bundle_123" },
      }),
    (error) => {
      assert.ok(error instanceof AutonomousMutationExecutionError);
      assert.equal(error.status, 400);
      assert.equal(error.mutation?.status, "failed");
      assert.match(error.message, /Only configuration\.operator_settings/);
      return true;
    }
  );
  assert.equal(settings.get().dashboardRefreshSeconds, 5);

  assert.throws(
    () =>
      executor.apply({
        assignmentId: assignment.assignment.id,
        target: "configuration",
        mutationType: "operator_settings",
        rationale: "Try malformed operator settings.",
        proposedChange: {
          operatorSettings: { dashboardRefreshSeconds: 0 },
        },
      }),
    (error) => {
      assert.ok(error instanceof AutonomousMutationExecutionError);
      assert.equal(error.status, 400);
      assert.equal(error.mutation?.status, "failed");
      assert.match(error.message, /positive integer/);
      return true;
    }
  );
  assert.equal(settings.get().dashboardRefreshSeconds, 5);

  assert.throws(
    () =>
      executor.apply({
        assignmentId: assignment.assignment.id,
        target: "configuration",
        mutationType: "operator_settings",
        rationale: "Try out-of-range operator settings.",
        proposedChange: {
          operatorSettings: { memoryTimelineLimit: 999 },
        },
      }),
    (error) => {
      assert.ok(error instanceof AutonomousMutationExecutionError);
      assert.equal(error.status, 400);
      assert.equal(error.mutation?.status, "failed");
      assert.match(error.message, /less than or equal to 100/);
      return true;
    }
  );
  assert.equal(settings.get().memoryTimelineLimit, 20);

  assert.deepEqual(
    ledger.list({ assignmentId: assignment.assignment.id }).map((mutation) => ({
      target: mutation.target,
      mutationType: mutation.mutationType,
      status: mutation.status,
      errorMessage: mutation.errorMessage,
    })),
    [
      {
        target: "configuration",
        mutationType: "operator_settings",
        status: "failed",
        errorMessage:
          "operatorSettings.memoryTimelineLimit must be less than or equal to 100",
      },
      {
        target: "configuration",
        mutationType: "operator_settings",
        status: "failed",
        errorMessage:
          "operatorSettings.dashboardRefreshSeconds must be a positive integer",
      },
      {
        target: "tool",
        mutationType: "tool_bundle_enable",
        status: "failed",
        errorMessage:
          "Only configuration.operator_settings, configuration.assignment_policy, configuration.runtime_limits, tool.bundle_enable, prompt.runtime_guidance, memory_policy.runtime_bounds, role.permission_policy, and project_file.draft autonomous mutations are supported in this slice",
      },
    ]
  );

  database.close();
});

test("AutonomousMutationExecutor audits self-evolution policy denials as failed", () => {
  const { assignments, database, executor, ledger, settings } = createHarness();
  const disabled = assignments.create({
    objective: "Disabled self-evolution policy",
    autonomyLevel: "evolve",
    policy: {
      selfEvolution: {
        enabled: false,
      },
    },
  });
  const disallowed = assignments.create({
    objective: "Disallowed self-evolution mutation class",
    autonomyLevel: "evolve",
    policy: {
      selfEvolution: {
        allowedMutationClasses: [],
      },
    },
  });

  assert.throws(
    () =>
      executor.apply({
        assignmentId: disabled.assignment.id,
        target: "configuration",
        mutationType: "operator_settings",
        rationale: "Try to mutate while self-evolution is disabled.",
        proposedChange: {
          operatorSettings: { dashboardRefreshSeconds: 12 },
        },
      }),
    (error) => {
      assert.ok(error instanceof AutonomousMutationExecutionError);
      assert.equal(error.status, 403);
      assert.equal(error.mutation?.status, "failed");
      assert.match(error.message, /self-evolution policy is disabled/);
      return true;
    }
  );

  assert.throws(
    () =>
      executor.apply({
        assignmentId: disallowed.assignment.id,
        target: "configuration",
        mutationType: "operator_settings",
        rationale: "Try to mutate without an allowed mutation class.",
        proposedChange: {
          operatorSettings: { dashboardRefreshSeconds: 12 },
        },
      }),
    (error) => {
      assert.ok(error instanceof AutonomousMutationExecutionError);
      assert.equal(error.status, 403);
      assert.equal(error.mutation?.status, "failed");
      assert.match(error.message, /does not allow/);
      return true;
    }
  );

  assert.equal(settings.get().dashboardRefreshSeconds, 5);
  assert.deepEqual(
    ledger.list({ assignmentId: disabled.assignment.id }).map((mutation) => ({
      status: mutation.status,
      errorMessage: mutation.errorMessage,
      authorizingPolicy: mutation.authorizingPolicy,
    })),
    [
      {
        status: "failed",
        errorMessage: "Assignment self-evolution policy is disabled",
        authorizingPolicy: {
          rule: "assignment.policy.selfEvolution",
          maxRiskClass: "medium",
          allowedMutationClasses: ["configuration.operator_settings"],
          mutationClass: "configuration.operator_settings",
        },
      },
    ]
  );
  assert.deepEqual(
    ledger.list({ assignmentId: disallowed.assignment.id }).map((mutation) => ({
      status: mutation.status,
      errorMessage: mutation.errorMessage,
      authorizingPolicy: mutation.authorizingPolicy,
    })),
    [
      {
        status: "failed",
        errorMessage:
          "Assignment self-evolution policy does not allow configuration.operator_settings",
        authorizingPolicy: {
          rule: "assignment.policy.selfEvolution",
          maxRiskClass: "medium",
          allowedMutationClasses: [],
          mutationClass: "configuration.operator_settings",
        },
      },
    ]
  );

  database.close();
});

test("AutonomousMutationExecutor rolls back applied operator settings mutations", () => {
  const { assignments, database, executor, settings } = createHarness();
  const assignment = assignments.create({
    objective: "Roll back autonomous operator settings",
    autonomyLevel: "evolve",
  });
  const applied = executor.apply({
    assignmentId: assignment.assignment.id,
    target: "configuration",
    mutationType: "operator_settings",
    rationale: "Temporarily tune the operator console.",
    proposedChange: {
      operatorSettings: {
        dashboardRefreshSeconds: 15,
        chatDefaultConversationId: "autonomy-console",
      },
    },
  });
  assert.equal(settings.get().dashboardRefreshSeconds, 15);
  assert.equal(settings.get().chatDefaultConversationId, "autonomy-console");

  const rolledBack = executor.rollback({
    assignmentId: assignment.assignment.id,
    mutationId: applied.mutation.id,
    actor: "bob",
  });

  assert.equal(rolledBack.mutation.status, "rolled_back");
  assert.deepEqual(settings.get(), {
    dashboardRefreshSeconds: 5,
    chatDefaultConversationId: "operator-console",
    memoryTimelineLimit: 20,
  });
  const timelineEvents = assignments.timeline(assignment.assignment.id).events;
  assert.deepEqual(
    timelineEvents.map((event) => event.type),
    ["created", "mutation_planned", "mutation_applied", "mutation_rolled_back"]
  );
  assert.equal(
    (
      timelineEvents.find((event) => event.type === "mutation_rolled_back")
        ?.payload as { actor?: string }
    ).actor,
    "bob"
  );

  database.close();
});

test("AutonomousMutationExecutor blocks rollback when newer operator settings mutations are applied", () => {
  const { assignments, database, executor, ledger, settings } = createHarness();
  const assignment = assignments.create({
    objective: "Prevent stale autonomous operator settings rollback",
    autonomyLevel: "evolve",
  });
  const first = executor.apply({
    assignmentId: assignment.assignment.id,
    target: "configuration",
    mutationType: "operator_settings",
    rationale: "Temporarily slow down the operator console.",
    proposedChange: {
      operatorSettings: { dashboardRefreshSeconds: 15 },
    },
  });
  const second = executor.apply({
    assignmentId: assignment.assignment.id,
    target: "configuration",
    mutationType: "operator_settings",
    rationale: "Temporarily expand the assignment timeline.",
    proposedChange: {
      operatorSettings: { memoryTimelineLimit: 25 },
    },
  });
  const sameAppliedAt = "2026-06-12T22:00:00.000Z";
  database.run(
    "UPDATE assignment_mutations SET applied_at = ? WHERE id IN (?, ?)",
    sameAppliedAt,
    first.mutation.id,
    second.mutation.id
  );
  database.run(
    "UPDATE assignment_mutations SET id = ? WHERE id = ?",
    "asgnmut_same_z",
    first.mutation.id
  );
  database.run(
    "UPDATE assignment_mutations SET id = ? WHERE id = ?",
    "asgnmut_same_10",
    second.mutation.id
  );

  assert.throws(
    () =>
      executor.rollback({
        assignmentId: assignment.assignment.id,
        mutationId: "asgnmut_same_z",
        actor: "bob",
      }),
    (error) => {
      assert.ok(error instanceof AutonomousMutationExecutionError);
      assert.equal(error.status, 409);
      assert.match(error.message, /newer applied/);
      return true;
    }
  );
  assert.deepEqual(settings.get(), {
    dashboardRefreshSeconds: 15,
    chatDefaultConversationId: "operator-console",
    memoryTimelineLimit: 25,
  });
  assert.deepEqual(
    ledger
      .list({ assignmentId: assignment.assignment.id })
      .map((mutation) => ({
        id: mutation.id,
        status: mutation.status,
      }))
      .sort((left, right) => left.id.localeCompare(right.id)),
    [
      { id: "asgnmut_same_10", status: "applied" },
      { id: "asgnmut_same_z", status: "applied" },
    ]
  );

  database.close();
});

test("AutonomousMutationExecutor does not reuse apply actor for actorless rollback events", () => {
  const { assignments, database, executor, settings } = createHarness();
  const assignment = assignments.create({
    objective: "Keep rollback attribution distinct",
    autonomyLevel: "evolve",
  });
  const applied = executor.apply({
    assignmentId: assignment.assignment.id,
    target: "configuration",
    mutationType: "operator_settings",
    rationale: "Temporarily tune the operator console.",
    actor: "alice",
    proposedChange: {
      operatorSettings: { dashboardRefreshSeconds: 15 },
    },
  });

  executor.rollback({
    assignmentId: assignment.assignment.id,
    mutationId: applied.mutation.id,
  });

  assert.equal(settings.get().dashboardRefreshSeconds, 5);
  const rollbackEvent = assignments
    .timeline(assignment.assignment.id)
    .events.find((event) => event.type === "mutation_rolled_back");
  assert.deepEqual((rollbackEvent?.payload as { actor?: string }).actor, null);

  database.close();
});
