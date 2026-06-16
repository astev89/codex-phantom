# Codex Phantom Context

This context defines the project language for bringing `codex-phantom` to production-level parity with the reference Phantom system while keeping Codex-specific boundaries explicit.

## Language

**Production-level parity**:
Feature-set parity with Phantom, excluding Telegram, implemented in a way that is safe to run in a production environment.
_Avoid_: Operational parity, production hardening only

**Web Chat parity**:
Matching Phantom's user-visible browser chat capabilities without requiring exact compatibility with Phantom's internal 32-event wire protocol.
_Avoid_: Wire-protocol parity, protocol clone

**Slack parity**:
Matching Phantom's Slack interaction set, including inbound messages, thread replies, progressive updates, status reactions, and feedback signals.
_Avoid_: Outbound-only Slack, basic Slack inbound

**Governed self-evolution**:
Agent-proposed or agent-applied changes to its own behavior, memory, tools, prompts, configuration, or project files under explicit policy, audit, rollback, and operator-interruption controls. Human approval is one possible control, not a requirement for every mutation.
_Avoid_: Unrestricted self-mutation

**Self-evolution mutation module**:
A governed self-evolution module interface that owns approved proposal execution, target-specific mutation adapters, before/after/rollback payloads, apply failure recording, and rollback effects while HTTP remains an adapter and proposal storage remains persistence.
_Avoid_: Route mutation helper, proposal store side effect

**Delegated autonomous self-evolution**:
A governed self-evolution mode where Phantom may autonomously modify prompts, memory policy, tools, roles, runtime configuration, and project files when an operator delegates that authority through autonomous assignment policy, while preserving rationale, audit, rollback records, budget limits, and interruption controls.
_Avoid_: Proposal-only self-evolution, ambient unrestricted mutation

**Internal tool parity**:
Phantom plugin capability reduced to internal, governed tool bundles and dynamic tools without a public marketplace.
_Avoid_: Plugin marketplace, public marketplace

**Operator onboarding parity**:
Matching Phantom's role/config/setup readiness through internal operator setup flows without requiring magic-link authentication.
_Avoid_: Magic-link parity

**Managed memory parity**:
Matching Phantom's advanced memory lifecycle, including contradiction handling, supersession, scheduled consolidation, promote/prune behavior, decay, reinforcement, and hybrid retrieval.
_Avoid_: Smarter memory, advanced memory

**Memory lifecycle module**:
A memory module interface that owns lifecycle links, active/inactive state transitions, reinforcement events, retrieval access effects, episodic compaction, and active-row pruning while storage remains in SQLite.
_Avoid_: Store helper, maintenance side effect

**Memory retrieval policy**:
A memory module interface that owns active-row filtering, hybrid ranking, decay calculation, vector-score blending, and bounded context envelope shaping.
_Avoid_: Query helper, scoring formula in storage

**Production proof**:
Executable evidence that production claims hold in a real deployment-like environment, separate from Phantom feature parity.
_Avoid_: Parity feature, feature gap

**Channel parity**:
Matching Phantom channel capabilities across Slack, Web Chat, signed webhook, Email, and any future discovered channels except Telegram.
_Avoid_: Telegram parity

**Email channel parity**:
Matching Phantom's built-in email channel capability with production-safe IMAP/SMTP configuration, inbound thread routing, outbound replies, attachment handling, auth boundaries, audit, and operator visibility.
_Avoid_: Newsletter feature, generic email notifications

**First-class runtime channel**:
An enabled channel that participates in runtime startup, readiness, inbound routing, outbound delivery, audit, and operator visibility.
_Avoid_: Manual-only integration, notification helper

**Runtime channel capability**:
A channel module interface that owns channel metadata, configuration requirements, readiness, diagnostics, and optional lifecycle hooks while leaving persisted enabled state in channel storage.
_Avoid_: Channel row, route special case

**Inbound response dispatcher**:
A channel module interface that owns completed and failed inbound run side effects, dispatching replies, progress, audit, retry, and failure isolation through target-specific adapters.
_Avoid_: Route callback, channel reply helper

**Chat artifact module**:
A chat module interface that owns attachment upload, text indexing, artifact persistence, automatic extraction persistence, search, session artifact summaries, and download handles while HTTP remains only an adapter.
_Avoid_: Storage helper, route workflow

**Artifact content policy**:
A central chat policy module that owns artifact and attachment byte limits, safe searchable content types, extracted-artifact content rules, download names, and file-name generation.
_Avoid_: Per-route content checks, duplicated MIME allowlist

**Operator export module**:
An operator module interface that owns export scope collection and formatting across audit, channel, governance, run, MCP, chat, and timeline sources while HTTP remains only auth, query parsing, and response writing.
_Avoid_: Export formatter, route scope switch

**Autonomous assignment**:
A durable operator-given objective that Phantom may pursue across multiple runs, scheduler wakeups, memory updates, and channel notifications until it reaches a terminal outcome or exhausts its policy or budget.
_Avoid_: One-shot run, scheduler job, inbound message

**Bounded autonomous execution**:
The initial autonomy model for autonomous assignments: Phantom may plan, wake itself, run allowed tools, update memory, and notify channels without another inbound trigger, but only inside explicit policy limits for budget, wakeups, runtime, tool scope, approvals, and notification cadence.
_Avoid_: Unbounded background daemon, fully independent agent

**Assignment autonomy level**:
The delegated authority tier for an autonomous assignment: `observe` may inspect, plan, and report; `execute` may run approved tools and continue across wakeups; `evolve` may perform delegated autonomous self-evolution; `operate` may additionally take externally visible operational actions.
_Avoid_: Boolean autonomy flag, hidden trust mode

**Assignment lifecycle state**:
The durable status of an autonomous assignment: `active`, `waiting`, `needs_approval`, `blocked`, `completed`, `cancelled`, `expired`, or `failed`.
_Avoid_: Run status, scheduler status

**Assignment intake**:
The channel/API interpretation step that decides whether an inbound operator request creates a one-shot run or a durable autonomous assignment, using explicit persistence intent first, configured defaults second, and confirmation only for ambiguous high-authority cases.
_Avoid_: Every message is an assignment, hidden background work

**Assignment intake service**:
The assignment module interface that classifies explicit persistence intent, creates durable autonomous assignments from channel/API requests, schedules the first wakeup, and returns adapter-ready acknowledgement data while preserving one-shot behavior by default.
_Avoid_: Route keyword hack, every inbound message becomes background work

**Assignment acceptance acknowledgement**:
A minimal channel/API confirmation that an autonomous assignment was created and queued for its first wakeup, distinct from full progress, blocked, terminal, or mutation notifications.
_Avoid_: Silent background intake, full notification lifecycle

**Assignment policy**:
The explicit limits and authorities for an autonomous assignment, including autonomy level, wakeup budget, runtime budget, failure budget, idle expiry, tool-call limits, notification cadence, self-evolution authority, and approval gates.
_Avoid_: Prompt-only guardrail, global daemon setting

**Autonomous mutation ledger**:
The durable evidence record for autonomous self-evolution mutations, capturing assignment id, run id, target, autonomy level, authorizing policy rule, rationale, risk class, before/after snapshots or hashes, rollback payload, affected resources, verification attempted, verification result, operator notification, and final status.
_Avoid_: Silent self-change, unrollbackable mutation

**Assignment step planner**:
The assignment runtime decision component that builds a compact assignment state packet on each wakeup and chooses one inspectable next action: run, schedule, notify, mutate, request approval, complete, block, cancel, or expire.
_Avoid_: Re-run the whole objective blindly, hidden infinite loop

**Assignment wakeup planner**:
The deterministic v1 implementation of the assignment step planner that wakes an assignment through scheduler policy, runs one coordinator attempt, links the run, applies bounded lifecycle decisions, can route mutation-authorized planner markers through the autonomous mutation executor, and schedules the next wakeup without child assignment execution.
_Avoid_: Infinite autonomous loop, hidden background worker

**Assignment notification**:
An assignment-level channel update about accepted work, wakeup start, progress, autonomous changes, waiting state, approval needs, blocked state, completion, expiration, failure, or cancellation.
_Avoid_: Tool-call spam, hidden background work

**Assignment control**:
An operator action that interrupts or modifies an autonomous assignment, such as pause, resume, cancel, change policy, force wakeup, add context, roll back a mutation, or promote a discovered subproblem into a child assignment.
_Avoid_: Reply-only steering, unmanaged background process

**Assignment event retention**:
The assignment event-log policy that keeps audit and milestone events long-term while marking high-frequency detail events as compactable with optional expiry and later summary compaction.
_Avoid_: Unbounded progress log, lossy audit trail

**Deferred assignment slice**:
A consciously excluded autonomous-assignment capability that remains part of the planned sequence, such as child execution, additional mutation classes, event compaction, or richer UI.
_Avoid_: Forgotten out-of-scope item, permanent exclusion

**Child assignment**:
An autonomous assignment created from a parent assignment for a distinct sub-objective, inheriting parent policy by default without exceeding parent autonomy level, remaining budget, maximum depth, or active-child limits.
_Avoid_: Hidden subagent, vague side quest

**Email thread identity**:
The conversation identity for an email exchange, derived from RFC message threading headers when available and from sender plus normalized subject only as a fallback.
_Avoid_: Subject-only thread, mailbox folder identity

**Email attachment parity**:
Attachment-aware email handling that records attachment metadata and only ingests safe bounded content through audited storage/indexing paths.
_Avoid_: Unbounded mailbox ingestion, opaque binary hoarding

**Production-safe feature**:
A parity feature with auth boundaries, bounded inputs, auditability, operator visibility, recovery behavior, failure isolation, and verification evidence.
_Avoid_: Implemented feature, feature complete

## Relationships

- **Production-level parity** includes Phantom feature coverage and production safety.
- **Production-level parity** explicitly excludes Telegram.
- **Web Chat parity** is part of **Production-level parity**.
- **Web Chat parity** requires matching product capabilities, not Phantom's internal event protocol.
- **Slack parity** is part of **Production-level parity**.
- **Slack parity** treats feedback buttons and reaction feedback as required parity features that can trail progressive updates and status reactions.
- **Governed self-evolution** is part of **Production-level parity**.
- **Governed self-evolution** excludes ambient unrestricted mutation, but it does not require human approval for every mutation when authority has been delegated by policy.
- **Governed self-evolution** uses the **Self-evolution mutation module** so approved apply and rollback behavior stays behind target-specific adapters instead of living in HTTP routes.
- **Delegated autonomous self-evolution** is the self-directed mode of **Governed self-evolution** for autonomous assignments.
- **Delegated autonomous self-evolution** is granted per **Autonomous assignment**, with permissive defaults allowed for trusted local or development operation.
- **Internal tool parity** is part of **Production-level parity**.
- **Internal tool parity** excludes Phantom's public marketplace model because `codex-phantom` is an internal project.
- **Operator onboarding parity** is part of **Production-level parity**.
- **Operator onboarding parity** includes YAML-first roles/config and first-run setup checks, but does not require Phantom's magic-link auth.
- **Managed memory parity** is part of **Production-level parity**.
- **Managed memory parity** prioritizes contradiction/supersession and scheduled consolidation before retrieval tuning.
- **Managed memory parity** uses the **Memory lifecycle module** for durable lifecycle mutation, reinforcement, compaction, and pruning.
- **Managed memory parity** uses the **Memory retrieval policy** for bounded hybrid ranking and decay without making storage own scoring rules.
- **Production proof** validates **Production-level parity** but is not itself a Phantom feature.
- **Channel parity** is part of **Production-level parity**.
- **Channel parity** explicitly excludes Telegram and defaults future discovered Phantom channels to in scope unless carved out.
- **Email channel parity** is part of **Channel parity** because Phantom ships a built-in Email channel.
- **Email channel parity** requires Email to be a **First-class runtime channel**, not a manual-only SMTP notifier.
- A **First-class runtime channel** is described by a **Runtime channel capability** so channel semantics stay local instead of leaking across startup, readiness, diagnostics, and HTTP routes.
- A **First-class runtime channel** uses the **Inbound response dispatcher** so inbound run completion behavior stays local to channel reply adapters instead of leaking into HTTP routes or polling loops.
- **Web Chat parity** uses the **Chat artifact module** so attachment continuity, artifact persistence, search, downloads, and extraction side effects stay local to chat instead of leaking into HTTP routes.
- The **Chat artifact module** depends on the **Artifact content policy** for byte limits, safe text indexing, extracted-artifact content rules, and download names.
- Operator visibility uses the **Operator export module** so export scope collection stays local instead of leaking across HTTP routes.
- **Autonomous assignment** turns an operator objective into durable work across runs; a run is one execution attempt, and a scheduler job is only one way to wake the assignment.
- **Autonomous assignment** starts with **Bounded autonomous execution** so initiative is durable but constrained by explicit operator policy.
- **Autonomous assignment** uses an **Assignment autonomy level** rather than a boolean autonomy flag.
- **Autonomous assignment** has an **Assignment lifecycle state** distinct from run status and scheduler job status.
- **Autonomous assignment** is the durable parent of related runs, scheduler wakeups, channel notifications, memory entries, and artifacts.
- A run is one execution attempt within an **Autonomous assignment**, not the assignment itself.
- A scheduler job is one wakeup mechanism for an **Autonomous assignment**, not the assignment itself.
- Subagents are execution helpers inside assignment runs; they do not become durable autonomous assignments unless Phantom explicitly creates child assignments.
- Autonomous assignment summaries absorb useful subagent results so future wakeups do not require full transcript replay.
- **Assignment intake** creates autonomous assignments from explicit persistence intent such as "keep working", "continue until", "monitor", "check back later", or explicit API fields.
- Slack mentions default to one-shot runs unless **Assignment intake** detects persistence intent or channel/operator policy says otherwise.
- **Assignment intake** is implemented through the **Assignment intake service** so HTTP, Slack, Email, and webhook adapters do not own assignment creation policy.
- **Assignment acceptance acknowledgement** confirms intake without expanding into the full **Assignment notification** lifecycle.
- `evolve` and `operate` autonomy require explicit delegation language or an operator default policy.
- **Assignment policy** defaults v1 trusted local/dev assignments to `execute`, 5 wakeups, 60 total runtime minutes, 2 consecutive failures, 24 max idle hours, planner-chosen wakeups capped from 5 minutes to 4 hours, and progress notifications at create/start/progress/block/failure/completion plus at least every 30 active minutes.
- **Assignment policy** enables broad self/project mutation only at `evolve` or higher, and keeps external destructive actions, secrets/auth changes, spending outside budget, and `operate` actions behind explicit delegation or approval gates.
- **Delegated autonomous self-evolution** records every autonomous mutation in the **Autonomous mutation ledger**.
- The **Autonomous mutation ledger** owns autonomous mutation evidence, assignment timeline links, operator read models, export visibility, and read-only MCP visibility; it does not itself execute mutation adapters.
- If Phantom cannot construct a rollback payload or before snapshot for a mutation class, it cannot autonomously apply that mutation class.
- **Autonomous assignment** uses an **Assignment step planner** on each wakeup instead of blindly re-running the full objective.
- **Assignment step planner** chooses one outer next action per wakeup so the autonomous loop remains inspectable.
- **Assignment wakeup planner** is the first runtime implementation of the **Assignment step planner**: it can run one coordinator wakeup, link the run, transition lifecycle, route mutation-authorized planner markers through the autonomous mutation executor, and schedule the next wakeup.
- **Assignment wakeup planner** is deliberately deterministic in v1 and does not yet own child assignment creation, notification delivery, or dashboard behavior.
- **Autonomous assignment** reports through **Assignment notifications** at assignment-level milestones rather than exposing every internal tool call.
- Slack **Assignment notifications** use one thread per assignment and avoid flooding by updating progress/status messages where practical.
- Feedback buttons attach to major **Assignment notifications** and terminal outcomes, not every wakeup.
- Operators steer autonomous work through **Assignment controls**.
- V1 **Assignment controls** are admin/API-first, with Slack thread commands allowed as a later or parallel adapter.
- **Assignment controls** include pause, resume, cancel, change policy, force wakeup, add context, roll back mutation, and promote child assignment.
- Phantom may create **Child assignments** for distinct sub-objectives discovered during autonomous work.
- **Child assignments** inherit parent assignment policy by default and cannot exceed parent autonomy level or remaining budget without explicit delegation.
- V1 **Child assignments** default to max depth 2 and max active children 3.
- Parent assignments record why a **Child assignment** exists, whether the parent waits or continues, and absorb child completion summaries.
- Phantom may mark an **Autonomous assignment** completed when completion criteria appear satisfied, but completion must include summary, evidence, changes, verification, residual risks, and any autonomous mutation rollback handles.
- Operators may reopen a completed **Autonomous assignment** by adding corrective context or rejecting the completion.
- Ambiguous completion criteria should move an **Autonomous assignment** to `needs_approval` rather than pretending certainty.
- V1 autonomous assignment surfaces are admin/API-first: create, list, inspect, control, timeline, mutation ledger, and channel-intake service integration.
- The first implementation slice for autonomous work is **Autonomous assignment** core: durable assignment storage, assignment events, assignment controls, assignment-run links, policy defaults, admin APIs, and minimal planner/control plumbing before delegated autonomous mutation.
- Autonomous assignment storage uses current state rows plus append-only events, not pure event sourcing.
- **Assignment event retention** gives assignment events `importance`, `compactable`, and optional `expiresAt` metadata from v1, even if maintenance compaction lands later.
- **Assignment event retention** keeps terminal summaries, final outcomes, policy changes, controls, child links, run links, mutation links, completion, and reopen events long-term.
- High-frequency assignment progress/detail events may be compacted into summary events; autonomous mutation ledger entries are not compacted while rollback is promised.
- The first **Autonomous assignment** core plus wakeup planner and intake slices deliberately exclude several **Deferred assignment slices**: autonomous mutation execution, child assignment execution, LLM planner policy, event compaction maintenance, full dashboard, production deployment automation, autonomous filesystem/project mutation, and changes to existing one-shot channel behavior.
- **Deferred assignment slices** remain planned follow-up work rather than permanent exclusions.
- **Deferred assignment slices** should proceed from the planner-driven mutation marker baseline through child assignment execution, retention/compaction maintenance, additional safe mutation adapters, then operator UX.
- Public unauthenticated assignment endpoints, heavy UI changes, assignment templates, and multi-agent dashboards are not part of the v1 autonomous assignment surface.
- `waiting` means Phantom knows when or how to resume; `blocked` means it cannot make meaningful progress without new information or access.
- **Email channel parity** treats inbound IMAP and outbound SMTP as one all-or-nothing enabled capability; partial inbound-only or outbound-only modes are not parity-complete.
- **Email thread identity** uses message headers first so replies remain attached to the correct exchange across subject edits and multi-party threads.
- **Email attachment parity** prioritizes metadata and safe bounded text extraction before raw binary storage or outbound attachment generation.
- **Production-level parity** backlog order is **Production proof**, **Slack parity**, **Operator onboarding parity**, **Managed memory parity**, **Governed self-evolution**, **Internal tool parity**, artifact intelligence, then newly discovered non-Telegram **Channel parity** gaps.
- Every feature counted toward **Production-level parity** must be a **Production-safe feature**.

## Example dialogue

> **Dev:** "Can we skip Phantom's plugin marketplace because dynamic governed tools are safer?"
> **Domain expert:** "No — for **production-level parity**, match the Phantom feature set unless the feature is Telegram, then make the implementation production-safe."
>
> **Dev:** "Do we need Phantom's exact 32-event browser protocol?"
> **Domain expert:** "No — **Web Chat parity** means the same visible chat capabilities, not drop-in protocol compatibility."
>
> **Dev:** "Can Slack parity stop at app mentions and one final reply?"
> **Domain expert:** "No — **Slack parity** includes progressive updates, status reactions, thread replies, and feedback signals."
>
> **Dev:** "Can the agent rewrite its own prompt in production?"
> **Domain expert:** "Only through **Governed self-evolution**. If an **Autonomous assignment** delegates that authority, Phantom may apply the change autonomously, but it must keep rationale, audit, policy evidence, and rollback possible."
>
> **Dev:** "Does self-evolution always require a human approval step?"
> **Domain expert:** "No — **Delegated autonomous self-evolution** allows broad autonomous mutation when assignment policy grants it. Human approval remains a policy option, not the definition."
>
> **Dev:** "Do we need Phantom's plugin marketplace?"
> **Domain expert:** "No — for this internal project, **Internal tool parity** means governed internal tool bundles and dynamic tools, not a marketplace."
>
> **Dev:** "Does parity require magic-link login?"
> **Domain expert:** "No — **Operator onboarding parity** requires setup readiness and role/config clarity, not Phantom's exact auth UX."
>
> **Dev:** "Is Qdrant-backed recall enough for memory parity?"
> **Domain expert:** "No — **Managed memory parity** also needs contradiction/supersession, lifecycle consolidation, decay, and reinforcement."
>
> **Dev:** "Should memory retrieval scoring live in the store because the store queries rows?"
> **Domain expert:** "No — keep `MemoryStore` as the facade, but put scoring and context shaping in the **Memory retrieval policy** and state changes in the **Memory lifecycle module**."
>
> **Dev:** "Is running the Docker smoke script a parity feature?"
> **Domain expert:** "No — it is **Production proof** that the production-safe implementation actually works."
>
> **Dev:** "Can we ignore Telegram when comparing channels?"
> **Domain expert:** "Yes — **Channel parity** excludes Telegram, but other Phantom channels default to in scope."
>
> **Dev:** "Does Phantom's built-in Email channel count?"
> **Domain expert:** "Yes — **Email channel parity** is in scope because Phantom ships email as a first-class channel. Implement it with production-safe IMAP/SMTP boundaries."
>
> **Dev:** "Can Email parity just send SMTP notifications?"
> **Domain expert:** "No — **Email channel parity** requires a **First-class runtime channel** with inbound routing, replies, audit, readiness, and operator visibility."
>
> **Dev:** "Where should channel config and lifecycle rules live?"
> **Domain expert:** "In the **Runtime channel capability**. The registry stores enabled state; the capability owns channel semantics."
>
> **Dev:** "Where should Slack and Email final reply behavior live?"
> **Domain expert:** "In the **Inbound response dispatcher**. HTTP and polling should route inbound events; channel adapters should own replies, progress, retry, and audit."
>
> **Dev:** "Should chat attachment indexing and artifact downloads live in HTTP because routes expose them?"
> **Domain expert:** "No — HTTP is the adapter. The **Chat artifact module** owns the workflow, and the **Artifact content policy** owns limits and safe content rules."
>
> **Dev:** "Can we enable Email with only SMTP configured?"
> **Domain expert:** "No — **Email channel parity** is all-or-nothing: an enabled Email channel must have both IMAP inbound and SMTP outbound configured."
>
> **Dev:** "Is a Slack message that asks Phantom to keep working just a run?"
> **Domain expert:** "No — it creates an **Autonomous assignment**. Runs are execution attempts inside that assignment, and scheduler jobs only wake it up."
>
> **Dev:** "Can an autonomous assignment just keep working forever?"
> **Domain expert:** "No — v1 uses **Bounded autonomous execution** with explicit wakeup, runtime, budget, tool, approval, and notification limits."
>
> **Dev:** "Should autonomous behavior be a yes/no setting?"
> **Domain expert:** "No — use an **Assignment autonomy level**. `execute` can continue work; `evolve` can change Phantom/project internals; `operate` can affect external operations."
>
> **Dev:** "Is an assignment blocked while waiting for its next scheduled wakeup?"
> **Domain expert:** "No — that is `waiting`. `blocked` means Phantom does not know how to proceed without new information or access."
>
> **Dev:** "Can we just use runs as autonomous assignments?"
> **Domain expert:** "No — a run is one execution attempt. The **Autonomous assignment** is the durable parent with objective, policy, lifecycle, summary, wakeups, and terminal reason."
>
> **Dev:** "Can subagents quietly keep working after the coordinator run ends?"
> **Domain expert:** "No — subagents are execution helpers. Durable long-lived work must be represented as an **Autonomous assignment** or explicit child assignment."
>
> **Dev:** "Does every Slack mention become an autonomous assignment?"
> **Domain expert:** "No — **Assignment intake** defaults Slack mentions to one-shot runs unless the message carries persistence intent or a configured policy says otherwise."
>
> **Dev:** "Where do wakeup, runtime, and self-evolution limits live?"
> **Domain expert:** "In **Assignment policy**, not only in prompts. The policy is durable, auditable, and checked by the assignment runtime."
>
> **Dev:** "Can Phantom autonomously change a file if it cannot roll the change back?"
> **Domain expert:** "No — autonomous mutations require an **Autonomous mutation ledger** entry with before/after evidence and rollback data or a before snapshot."
>
> **Dev:** "On wakeup, should Phantom just rerun the original prompt?"
> **Domain expert:** "No — the **Assignment step planner** reviews compact assignment state and chooses one inspectable next action."
>
> **Dev:** "Should every autonomous run post a new Slack message?"
> **Domain expert:** "No — use **Assignment notifications** in one assignment thread, preferring progress/status updates and milestone replies over noisy tool-level chatter."
>
> **Dev:** "How does an operator stop or redirect autonomous work?"
> **Domain expert:** "Through **Assignment controls** such as pause, cancel, change policy, force wakeup, add context, and roll back mutation."
>
> **Dev:** "Can Phantom split work into durable subproblems?"
> **Domain expert:** "Yes, as **Child assignments** with distinct objectives, inherited policy, and explicit depth/active-child caps."
>
> **Dev:** "Can Phantom decide an assignment is complete without asking?"
> **Domain expert:** "Yes, but completion needs evidence, verification, residual risks, and a reopen path if the operator says it is not done."
>
> **Dev:** "Should autonomous assignments start with a full web dashboard?"
> **Domain expert:** "No — v1 is admin/API-first with create, list, inspect, control, timeline, mutation ledger, and channel-intake service integration."
>
> **Dev:** "Should we implement broad autonomous self-evolution before assignment core?"
> **Domain expert:** "No — implement **Autonomous assignment** core first so mutation authority has an owner, policy, lifecycle, control surface, and audit context."
>
> **Dev:** "Can assignment events grow forever?"
> **Domain expert:** "No — use **Assignment event retention** so audit and milestone events persist, while high-frequency detail events are marked compactable and can be summarized later."
>
> **Dev:** "If slice one excludes Slack intake and autonomous mutation, are those out of scope?"
> **Domain expert:** "No — they are **Deferred assignment slices**. Slice one builds the durable assignment core so follow-up slices have a stable place to land."
>
> **Dev:** "What comes after assignment core?"
> **Domain expert:** "Proceed through **Deferred assignment slices** in order: wakeup planner, channel intake, mutation ledger, first delegated self-evolution execution, safe mutation adapter expansion, planner mutation markers, child execution, retention compaction, then operator UX."
>
> **Dev:** "Can we group Email conversations by subject?"
> **Domain expert:** "Only as a fallback — **Email thread identity** should use Message-ID, In-Reply-To, and References when those headers are present."
>
> **Dev:** "Does Email parity mean storing every attachment?"
> **Domain expert:** "No — **Email attachment parity** means metadata plus safe bounded ingestion; binaries can be skipped with an auditable reason unless a concrete workflow needs them."
>
> **Dev:** "Should memory work happen before Slack parity?"
> **Domain expert:** "No — after **Production proof**, prioritize **Slack parity**, then **Operator onboarding parity**, then **Managed memory parity**."
>
> **Dev:** "Can we count a feature as parity-complete once the happy path works?"
> **Domain expert:** "No — it must be a **Production-safe feature** with auth, limits, audit, visibility, recovery, isolation, and verification."

## Flagged ambiguities

- "production-level parity" was initially interpreted as operational parity only; resolved: it means Phantom feature parity minus Telegram plus production safety.
- "web chat parity" could mean cloning Phantom's browser protocol; resolved: it means matching user-visible behavior unless a compatibility consumer appears.
- "Slack parity" was previously described as basic inbound behavior; resolved: full Phantom Slack behavior is in scope, with feedback allowed to land after progress/status.
- "self-evolution" could mean proposal-only HITL mutation or unmanaged runtime mutation; resolved: target **Governed self-evolution**, with **Delegated autonomous self-evolution** for assignment-scoped autonomous mutation under policy, audit, rollback, and interruption controls.
- "plugin marketplace" is part of Phantom's feature set but not needed for this internal project; resolved: target **Internal tool parity** instead.
- "role/config/onboarding parity" could imply magic-link auth; resolved: target **Operator onboarding parity**, excluding magic-link parity unless the user base changes.
- "advanced memory" was vague; resolved: target **Managed memory parity** with lifecycle and quality controls, not just better vector search.
- "Docker smoke" was mixed into parity work; resolved: classify it as **Production proof**, not a Phantom feature gap.
- "channel parity" previously meant webhook and Slack only; resolved: all Phantom channels are in scope except Telegram unless explicitly carved out.
- "Email" was discovered during the non-Telegram channel recompare; resolved: Phantom ships it as a built-in channel, so it is in scope for **Channel parity**.
- "Email channel" could mean SMTP-only notifications; resolved: **Email channel parity** requires a **First-class runtime channel** with IMAP inbound and SMTP outbound.
- "Enabled Email" could mean inbound-only or outbound-only operation; resolved: **Email channel parity** requires both IMAP and SMTP when enabled.
- "Email thread" could mean a subject line or a provider mailbox thread; resolved: **Email thread identity** is header-first with sender plus normalized subject as fallback.
- "Email attachments" could mean storing all mailbox binaries; resolved: **Email attachment parity** is metadata-first with safe bounded content ingestion.
- "autonomous task" could conflict with runs or scheduler jobs; resolved: use **Autonomous assignment** for durable operator objectives pursued across multiple runs and wakeups.
- "autonomy" could imply indefinite independent operation; resolved: start with **Bounded autonomous execution** under explicit operator policy.
- "autonomy level" could be hidden in prompts or role names; resolved: use explicit **Assignment autonomy level** values.
- "assignment status" could be confused with run or scheduler status; resolved: use **Assignment lifecycle state** and keep `waiting` distinct from `blocked`.
- "assignment" could be implemented by overloading runs or scheduler jobs; resolved: make **Autonomous assignment** its own durable parent model.
- "subagent" could become hidden durable work; resolved: subagents are execution helpers unless explicitly promoted into child **Autonomous assignments**.
- "work on this" could mean one answer or durable initiative; resolved: use **Assignment intake** with explicit persistence intent first and policy defaults second.
- "autonomy limits" could live only in prompts; resolved: use durable **Assignment policy** as the enforceable control surface.
- "autonomous self-evolution" could hide important changes in logs or final answers; resolved: every applied mutation needs an **Autonomous mutation ledger** entry with rollback evidence.
- "autonomous loop" could mean repeatedly rerunning the original objective; resolved: use an **Assignment step planner** with one inspectable next action per wakeup.
- "progress updates" could become channel spam; resolved: use assignment-level **Assignment notifications** and one Slack thread per assignment.
- "operator control" could be ad hoc replies only; resolved: use explicit **Assignment controls** with API-first semantics.
- "child work" could be hidden inside subagents or vague side tasks; resolved: use **Child assignments** only for distinct durable sub-objectives with inherited policy caps.
- "completion" could mean Phantom silently stops; resolved: completion requires evidence, verification, residual risks, and operator reopen support.
- "assignment UI" could dominate the first slice; resolved: autonomous assignment v1 is admin/API-first with channel-intake integration.
- "autonomous mutation" could be implemented before durable ownership exists; resolved: build **Autonomous assignment** core first.
- "assignment event log" could imply unbounded retention; resolved: use **Assignment event retention** with audit/milestone/detail importance, compactable flags, and optional expiry metadata.
- "excluded from slice one" could be mistaken for cancelled scope; resolved: call follow-up autonomous capabilities **Deferred assignment slices**.
