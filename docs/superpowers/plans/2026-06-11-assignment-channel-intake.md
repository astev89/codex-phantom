# Assignment Channel Intake Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add channel/API assignment intake so explicit persistence intent creates durable autonomous assignments and schedules the first wakeup while preserving existing one-shot chat, webhook, Slack, and Email behavior by default.

**Architecture:** Introduce an `AssignmentIntakeService` as the domain seam for classifying persistence intent, creating assignments, scheduling first wakeups, and returning adapter-friendly acknowledgement data. HTTP, Slack, Email, and webhook paths stay adapters: they parse/validate input, call intake, and either return the existing one-shot path or serialize/send an assignment-created acknowledgement. Full progress and terminal assignment notifications remain a later slice.

**Tech Stack:** TypeScript ESM, SQLite through `AppDatabase`, Node `node:test`, existing `AutonomousAssignmentService`, `AssignmentWakeupPlanner`, `InboundChannelRouter`, `SlackChannel`, `EmailChannelService`, and HTTP validation helpers.

---

## File Structure

- Create `src/assignments/intake.ts`
  - Owns persistence-intent classification, explicit intake commands, assignment creation input mapping, first-wakeup scheduling, and acknowledgement text.
- Modify `src/assignments/types.ts`
  - Adds intake-oriented types only if they are shared outside `intake.ts`.
- Modify `src/server/validation.ts`
  - Adds optional assignment intake request validation for `/chat/message` and `/channels/webhook`.
- Modify `src/server/http-server.ts`
  - Wires `AssignmentIntakeService`, uses it in chat/webhook/Slack routes, and keeps one-shot routes unchanged when intake returns `one_shot`.
- Modify `src/channels/email.ts`
  - Delegates inbound Email messages through assignment intake before one-shot routing.
- Modify `src/index.ts`
  - Constructs and passes the intake service into HTTP and Email wiring.
- Add `tests/assignment-intake.test.ts`
  - Unit coverage for classifier and service behavior.
- Update `tests/server.test.ts`
  - Contract coverage for chat/webhook/Slack assignment intake and unchanged one-shot behavior.
- Update `tests/email-channel.test.ts`
  - Proves Email assignment-intake messages create assignments and skip one-shot completion delivery.
- Update `CONTEXT.md`, `docs/phantom-parity.md`, and `docs/project-status.md`
  - Records completed assignment-intake slice and remaining deferred capabilities.

## Scope Boundaries

Included:

- Explicit durable intent from natural language, for example `keep working`, `continue until`, `monitor`, `check back`, `follow up`, `wake yourself`, `keep going on this`, and `work on this in the background`.
- Explicit structured request fields for chat/webhook, for example:

```json
{
  "message": "Research the deployment issue and keep working until blocked.",
  "assignment": {
    "create": true,
    "title": "Deployment research",
    "autonomyLevel": "execute",
    "policy": {
      "maxWakeups": 5
    }
  }
}
```

- Assignment creation with source channel, conversation id, sender/user id, original message metadata, and default policy.
- Due-now first wakeup scheduling through `AssignmentWakeupPlanner.scheduleNext({ force: true, delayMinutes: 0 })`.
- Acceptance acknowledgement for chat/webhook route responses and Slack thread replies.
- Email intake creates the assignment and records source metadata; visible Email acknowledgement can be deferred unless it can reuse existing SMTP reply dispatch without synthetic run records.

Excluded:

- Full assignment notification dispatcher for progress, completion, blocked, expiration, or failure.
- Slack thread commands for assignment control.
- Child assignments.
- Delegated mutation ledger or autonomous self-evolution execution.
- LLM-based classifier or planner.
- Schema changes to inbound channel events.

## Task 1: Intake Classifier

**Files:**

- Create: `src/assignments/intake.ts`
- Test: `tests/assignment-intake.test.ts`

- [ ] **Step 1: Write failing classifier tests**

Add tests for one-shot default, natural-language persistence intent, explicit `assignment.create: true`, explicit `assignment.create: false`, and policy/autonomy extraction:

```ts
test("assignment intake classifier preserves one-shot behavior by default", () => {
  assert.deepEqual(
    classifyAssignmentIntent({
      message: "What is the current readiness status?",
    }).kind,
    "one_shot"
  );
});

test("assignment intake classifier detects explicit persistence intent", () => {
  const decision = classifyAssignmentIntent({
    message: "Monitor this deploy and check back later.",
  });
  assert.equal(decision.kind, "create_assignment");
  assert.match(decision.objective, /Monitor this deploy/);
});

test("assignment intake classifier honors structured assignment overrides", () => {
  assert.equal(
    classifyAssignmentIntent({
      message: "Run once only.",
      assignment: { create: false },
    }).kind,
    "one_shot"
  );
  const decision = classifyAssignmentIntent({
    message: "Research this.",
    assignment: {
      create: true,
      title: "Research task",
      autonomyLevel: "execute",
      policy: { maxWakeups: 3 },
    },
  });
  assert.equal(decision.kind, "create_assignment");
  assert.equal(decision.title, "Research task");
  assert.equal(decision.autonomyLevel, "execute");
  assert.equal(decision.policy?.maxWakeups, 3);
});
```

- [ ] **Step 2: Run the test and verify red**

Run:

```bash
node --experimental-strip-types --test tests/assignment-intake.test.ts
```

Expected: fail because `src/assignments/intake.ts` and `classifyAssignmentIntent` do not exist.

- [ ] **Step 3: Implement minimal classifier**

Create `src/assignments/intake.ts` with:

```ts
import type {
  AssignmentAutonomyLevel,
  AssignmentPolicyPatch,
} from "./types.ts";

export type AssignmentIntakeCommand = {
  create?: boolean;
  title?: string;
  autonomyLevel?: AssignmentAutonomyLevel;
  policy?: AssignmentPolicyPatch;
};

export type AssignmentIntentDecision =
  | { kind: "one_shot" }
  | {
      kind: "create_assignment";
      objective: string;
      title?: string;
      autonomyLevel?: AssignmentAutonomyLevel;
      policy?: AssignmentPolicyPatch;
      reason: string;
    };

const PERSISTENCE_PATTERNS = [
  /\bkeep working\b/i,
  /\bcontinue until\b/i,
  /\bmonitor\b/i,
  /\bcheck back\b/i,
  /\bfollow up\b/i,
  /\bwake yourself\b/i,
  /\bkeep going\b/i,
  /\bin the background\b/i,
];

export function classifyAssignmentIntent(input: {
  message: string;
  assignment?: AssignmentIntakeCommand;
}): AssignmentIntentDecision {
  const message = input.message.trim();
  if (input.assignment?.create === false) {
    return { kind: "one_shot" };
  }
  if (input.assignment?.create === true) {
    return {
      kind: "create_assignment",
      objective: message,
      title: normalizeText(input.assignment.title),
      autonomyLevel: input.assignment.autonomyLevel,
      policy: input.assignment.policy,
      reason: "structured_request",
    };
  }
  const matched = PERSISTENCE_PATTERNS.find((pattern) => pattern.test(message));
  if (!matched) {
    return { kind: "one_shot" };
  }
  return {
    kind: "create_assignment",
    objective: message,
    reason: "persistence_intent",
  };
}

function normalizeText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== ""
    ? value.trim()
    : undefined;
}
```

- [ ] **Step 4: Run classifier tests and verify green**

Run:

```bash
node --experimental-strip-types --test tests/assignment-intake.test.ts
```

Expected: pass.

## Task 2: Intake Service Creates Assignments And Schedules Wakeups

**Files:**

- Modify: `src/assignments/intake.ts`
- Test: `tests/assignment-intake.test.ts`

- [ ] **Step 1: Write failing service tests**

Add tests proving `AssignmentIntakeService` creates assignments with source metadata, schedules due-now wakeup jobs, dedupes repeated provider events through an idempotency key, and returns `one_shot` for non-persistent messages.

Expected service call:

```ts
const result = await intake.handle({
  channelId: "slack",
  providerEventId: "evt_123",
  conversationId: "slack:C123:171",
  senderId: "U123",
  message: "Keep working on the deploy until it is green.",
  rawPayload: { type: "event_callback" },
});
```

Expected assertions:

```ts
assert.equal(result.kind, "assignment_created");
assert.equal(result.assignment.assignment.source.channelId, "slack");
assert.equal(
  result.assignment.assignment.source.conversationId,
  "slack:C123:171"
);
assert.equal(result.assignment.assignment.source.userId, "U123");
assert.equal(result.nextJob?.name, ASSIGNMENT_WAKEUP_JOB_NAME);
assert.equal(result.nextJob?.delayMs, 0);
```

- [ ] **Step 2: Run test and verify red**

Run:

```bash
node --experimental-strip-types --test tests/assignment-intake.test.ts
```

Expected: fail because `AssignmentIntakeService` does not exist.

- [ ] **Step 3: Implement service**

Extend `src/assignments/intake.ts` with:

```ts
import type { JobRecord } from "../scheduler/service.ts";
import type { JsonValue } from "../shared/types.ts";
import { AutonomousAssignmentService } from "./service.ts";
import { AssignmentWakeupPlanner } from "./wakeup-planner.ts";
import type { AssignmentDetail } from "./types.ts";

export type AssignmentIntakeInput = {
  channelId: string;
  providerEventId?: string;
  conversationId: string;
  senderId?: string;
  message: string;
  rawPayload: JsonValue;
  assignment?: AssignmentIntakeCommand;
};

export type AssignmentIntakeResult =
  | { kind: "one_shot" }
  | {
      kind: "assignment_created";
      assignment: AssignmentDetail;
      nextJob?: JobRecord;
      acknowledgementText: string;
    };

export class AssignmentIntakeService {
  constructor(
    private readonly assignments: AutonomousAssignmentService,
    private readonly wakeups?: Pick<AssignmentWakeupPlanner, "scheduleNext">
  ) {}

  async handle(input: AssignmentIntakeInput): Promise<AssignmentIntakeResult> {
    const decision = classifyAssignmentIntent({
      message: input.message,
      assignment: input.assignment,
    });
    if (decision.kind === "one_shot") {
      return { kind: "one_shot" };
    }
    const created = this.assignments.create({
      objective: decision.objective,
      title: decision.title,
      autonomyLevel: decision.autonomyLevel,
      policy: decision.policy,
      source: {
        channelId: input.channelId,
        conversationId: input.conversationId,
        userId: input.senderId,
      },
      metadata: {
        intake: {
          providerEventId: input.providerEventId ?? null,
          reason: decision.reason,
          rawPayload: input.rawPayload,
        },
      },
      createdBy: input.senderId ?? input.channelId,
    });
    const nextJob = this.wakeups
      ? await this.wakeups.scheduleNext({
          assignmentId: created.assignment.id,
          reason: "Assignment created from channel intake",
          delayMinutes: 0,
          force: true,
        })
      : undefined;
    return {
      kind: "assignment_created",
      assignment: created,
      nextJob,
      acknowledgementText: `Created assignment ${created.assignment.id}: ${created.assignment.objective}`,
    };
  }
}
```

Add idempotency after the first green pass by searching existing assignments for matching `metadata.intake.providerEventId` or by adding a small service-local query helper. Do not add a schema change.

- [ ] **Step 4: Run service tests and verify green**

Run:

```bash
node --experimental-strip-types --test tests/assignment-intake.test.ts
```

Expected: pass.

## Task 3: Validate Explicit Chat And Webhook Intake Requests

**Files:**

- Modify: `src/server/validation.ts`
- Test: `tests/server.test.ts`

- [ ] **Step 1: Write failing route-validation tests**

Add route-level tests for:

- `/chat/message` with `{ assignment: { create: true } }` produces assignment-created SSE events.
- `/chat/message` with `{ assignment: { create: false } }` preserves existing one-shot SSE.
- `/channels/webhook` with `{ assignment: { create: true } }` returns assignment-created JSON.
- Existing webhook body without `assignment` still returns the current one-shot `outputText` and `inboundEvent`.

- [ ] **Step 2: Run focused server tests and verify red**

Run:

```bash
node --experimental-strip-types --test tests/server.test.ts
```

Expected: fail because validation drops/rejects the `assignment` request object and routes do not call intake.

- [ ] **Step 3: Extend validation shapes**

Update `validateChatBody` and `validateWebhookBody` to include:

```ts
assignment: validateAssignmentIntakeCommand(value.assignment),
```

Add:

```ts
function validateAssignmentIntakeCommand(
  input: unknown
): AssignmentIntakeCommand | undefined {
  if (input === undefined || input === null) {
    return undefined;
  }
  const value = asRecord(input, "assignment");
  return {
    create:
      value.create === undefined
        ? undefined
        : requireBoolean(value.create, "assignment.create"),
    title: optionalString(value.title),
    autonomyLevel:
      value.autonomyLevel === undefined
        ? undefined
        : requireAssignmentAutonomyLevel(
            value.autonomyLevel,
            "assignment.autonomyLevel"
          ),
    policy: validateAssignmentPolicyPatch(value.policy),
  };
}
```

- [ ] **Step 4: Run validation-focused tests and verify green for validation**

Run:

```bash
node --experimental-strip-types --test tests/server.test.ts
```

Expected: still fail at route behavior until Task 4, but validation errors should be gone.

## Task 4: HTTP Chat And Webhook Adapter Integration

**Files:**

- Modify: `src/server/http-server.ts`
- Modify: `src/index.ts`
- Test: `tests/server.test.ts`

- [ ] **Step 1: Add constructor wiring tests or use existing server fixture**

Use the existing server fixture in `tests/server.test.ts`; assert that `HttpServer` constructs with an intake service and that existing one-shot tests still pass.

- [ ] **Step 2: Wire `AssignmentIntakeService` into `HttpServer`**

Add a private `assignmentIntake` field and constructor parameter:

```ts
private readonly assignmentIntake: AssignmentIntakeService;
```

If no intake is supplied, construct one from `assignments` and `assignmentWakeups` in the constructor to preserve tests that instantiate `HttpServer` directly.

- [ ] **Step 3: Integrate `/chat/message` before coordinator execution**

After body validation and before starting the coordinator run, call:

```ts
const intake = await this.assignmentIntake.handle({
  channelId: "web",
  conversationId: body.conversationId ?? body.sessionId ?? "web-chat",
  senderId: "operator",
  message: body.message,
  rawPayload: body as unknown as JsonValue,
  assignment: body.assignment,
});
```

If `intake.kind === "assignment_created"`, emit SSE:

```ts
emitWire("assignment.created", {
  assignment: intake.assignment.assignment,
  nextJob: intake.nextJob,
  acknowledgementText: intake.acknowledgementText,
});
emitWire("request.completed", {
  status: "assignment_created",
});
res.end();
return;
```

If `one_shot`, fall through to the existing chat behavior unchanged.

- [ ] **Step 4: Integrate `/channels/webhook` before `routeSync`**

After webhook body validation, call intake with `channelId: "webhook"`. If assignment-created, return:

```ts
this.json(res, 202, {
  requestId,
  status: "assignment_created",
  assignment: intake.assignment.assignment,
  nextJob: intake.nextJob,
  acknowledgementText: intake.acknowledgementText,
});
return;
```

If `one_shot`, fall through to the existing `routeSync` behavior unchanged.

- [ ] **Step 5: Run server tests**

Run:

```bash
node --experimental-strip-types --test tests/server.test.ts
```

Expected: pass.

## Task 5: Slack Intake Adapter

**Files:**

- Modify: `src/server/http-server.ts`
- Test: `tests/server.test.ts`

- [ ] **Step 1: Write failing Slack tests**

Extend Slack inbound route tests:

- Existing normal mention remains `accepted` and creates an inbound event.
- Mention text with `keep working` creates an assignment, schedules an `assignment.wakeup` job, returns HTTP `202`, and posts one Slack thread acknowledgement through the fake Slack transport.
- Duplicate Slack event returns duplicate assignment intake result without creating a second assignment or second due-now job.

- [ ] **Step 2: Run tests and verify red**

Run:

```bash
node --experimental-strip-types --test tests/server.test.ts
```

Expected: fail because Slack route still always calls `routeAsync`.

- [ ] **Step 3: Add Slack intake branch**

After `mapSlackEventToInboundMessage`, before `routeAsync`, call intake. If assignment-created:

```ts
await this.slack.sendMessage({
  channel: message.responseTarget.channel,
  threadTs: message.responseTarget.threadTs,
  text: intake.acknowledgementText,
});
this.json(res, 202, {
  requestId,
  status: "assignment_created",
  assignmentId: intake.assignment.assignment.id,
  duplicate: false,
});
return;
```

Keep one-shot behavior unchanged when intake returns `one_shot`.

- [ ] **Step 4: Run Slack route tests**

Run:

```bash
node --experimental-strip-types --test tests/server.test.ts
```

Expected: pass.

## Task 6: Email Intake Adapter

**Files:**

- Modify: `src/channels/email.ts`
- Modify: `src/index.ts`
- Test: `tests/email-channel.test.ts`

- [ ] **Step 1: Write failing Email tests**

Add Email polling test:

- Email body with `keep working` creates assignment with `source.channelId === "email"` and schedules due-now wakeup.
- It does not call `InboundChannelRouter.routeAsync`.
- Existing non-persistent Email still routes through `routeAsync` and reply delivery as today.

- [ ] **Step 2: Run Email tests and verify red**

Run:

```bash
node --experimental-strip-types --test tests/email-channel.test.ts
```

Expected: fail because Email service does not call intake.

- [ ] **Step 3: Inject optional intake service into `EmailChannelService`**

Add constructor input:

```ts
assignmentIntake?: AssignmentIntakeService;
```

In `pollOnce`, before `routeAsync`, call intake for each `toInboundChannelMessage(message)`. If assignment-created, skip one-shot routing and mark the IMAP message seen using the same success path as accepted routed messages.

Do not send SMTP acknowledgement in this slice unless it can be done without synthetic inbound run records. Record source metadata so a future assignment notification dispatcher can reply in-thread.

- [ ] **Step 4: Run Email tests**

Run:

```bash
node --experimental-strip-types --test tests/email-channel.test.ts
```

Expected: pass.

## Task 7: Docs And Verification

**Files:**

- Modify: `CONTEXT.md`
- Modify: `docs/phantom-parity.md`
- Modify: `docs/project-status.md`

- [ ] **Step 1: Update project language**

Add or refine:

- `Assignment intake service`
- `Assignment acceptance acknowledgement`

Keep existing language that full assignment notifications are a later slice.

- [ ] **Step 2: Update parity and ledger**

Record that channel assignment intake now exists for explicit persistence intent, while delegated mutation ledger, child assignment execution, retention compaction, and full notification lifecycle remain deferred.

- [ ] **Step 3: Final verification**

Run:

```bash
node --experimental-strip-types --test tests/assignment-intake.test.ts tests/email-channel.test.ts tests/server.test.ts tests/assignment-wakeup-planner.test.ts
npm run typecheck
npm test
npm run build
git diff --check
GitNexus detect_changes(scope="staged")
```

Expected: all pass; GitNexus affected flows are limited to assignments, HTTP adapters, Slack inbound, Email polling, and scheduler wakeup scheduling.

## Commit

Use one atomic commit:

```bash
git add src/assignments/intake.ts src/assignments/types.ts src/server/validation.ts src/server/http-server.ts src/channels/email.ts src/index.ts tests/assignment-intake.test.ts tests/server.test.ts tests/email-channel.test.ts CONTEXT.md docs/phantom-parity.md docs/project-status.md
git commit -m "feat(assignments): add channel assignment intake"
```

## Self-Review Checklist

- Existing one-shot chat, webhook, Slack, and Email behavior remains unchanged unless persistence intent is explicit.
- Assignment intake does not add unauthenticated endpoints.
- Assignment creation schedules only one due-now first wakeup per intake event.
- Slack receives a visible acceptance acknowledgement for assignment-created intake.
- Email assignment intake records durable source metadata even if visible Email acknowledgement remains deferred.
- No autonomous mutation, child assignment, compaction, or full notification lifecycle work leaks into this slice.
