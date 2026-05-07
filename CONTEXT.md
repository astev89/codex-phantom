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
Agent-proposed or agent-applied changes to its own behavior, memory, tools, prompts, or configuration under explicit policy, audit, approval, and rollback controls.
_Avoid_: Unrestricted self-mutation

**Internal tool parity**:
Phantom plugin capability reduced to internal, governed tool bundles and dynamic tools without a public marketplace.
_Avoid_: Plugin marketplace, public marketplace

**Operator onboarding parity**:
Matching Phantom's role/config/setup readiness through internal operator setup flows without requiring magic-link authentication.
_Avoid_: Magic-link parity

**Managed memory parity**:
Matching Phantom's advanced memory lifecycle, including contradiction handling, supersession, scheduled consolidation, promote/prune behavior, decay, reinforcement, and hybrid retrieval.
_Avoid_: Smarter memory, advanced memory

**Production proof**:
Executable evidence that production claims hold in a real deployment-like environment, separate from Phantom feature parity.
_Avoid_: Parity feature, feature gap

**Channel parity**:
Matching Phantom channel capabilities across Slack, Web Chat, signed webhook, and any future discovered channels except Telegram.
_Avoid_: Telegram parity

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
- **Governed self-evolution** excludes unrestricted mutation of prompts, tools, auth, channel policy, runtime config, or filesystem state.
- **Internal tool parity** is part of **Production-level parity**.
- **Internal tool parity** excludes Phantom's public marketplace model because `codex-phantom` is an internal project.
- **Operator onboarding parity** is part of **Production-level parity**.
- **Operator onboarding parity** includes YAML-first roles/config and first-run setup checks, but does not require Phantom's magic-link auth.
- **Managed memory parity** is part of **Production-level parity**.
- **Managed memory parity** prioritizes contradiction/supersession and scheduled consolidation before retrieval tuning.
- **Production proof** validates **Production-level parity** but is not itself a Phantom feature.
- **Channel parity** is part of **Production-level parity**.
- **Channel parity** explicitly excludes Telegram and defaults future discovered Phantom channels to in scope unless carved out.
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
> **Domain expert:** "Only through **Governed self-evolution**: propose, audit, approve when risky, and keep rollback possible."
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
> **Dev:** "Is running the Docker smoke script a parity feature?"
> **Domain expert:** "No — it is **Production proof** that the production-safe implementation actually works."
>
> **Dev:** "Can we ignore Telegram when comparing channels?"
> **Domain expert:** "Yes — **Channel parity** excludes Telegram, but other Phantom channels default to in scope."
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
- "self-evolution" could mean unrestricted self-mutation; resolved: parity target is **Governed self-evolution**, not unmanaged runtime mutation.
- "plugin marketplace" is part of Phantom's feature set but not needed for this internal project; resolved: target **Internal tool parity** instead.
- "role/config/onboarding parity" could imply magic-link auth; resolved: target **Operator onboarding parity**, excluding magic-link parity unless the user base changes.
- "advanced memory" was vague; resolved: target **Managed memory parity** with lifecycle and quality controls, not just better vector search.
- "Docker smoke" was mixed into parity work; resolved: classify it as **Production proof**, not a Phantom feature gap.
- "channel parity" previously meant webhook and Slack only; resolved: all Phantom channels are in scope except Telegram unless explicitly carved out.
