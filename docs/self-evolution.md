# Governed Self-Evolution

Governed self-evolution lets Codex Phantom change its own behavior under explicit policy, audit, rollback, and operator-interruption controls. [ADR-0003](adr/0003-delegate-autonomous-assignments-and-self-evolution.md) extends the target model beyond proposal-only HITL: autonomous assignments may use delegated autonomous self-evolution when assignment policy grants `evolve` or higher authority.

The current implementation is still narrower than that target. Today, Codex Phantom can create auditable proposals, apply approved proposal-based operator-settings mutations through operator-authenticated APIs, and apply assignment-authorized autonomous operator-settings mutations for `evolve` assignments. Prompt, memory policy, tool, role, project-file, and broader configuration mutation classes remain future work.

## Proposal Scope

Supported proposal targets:

- `prompt`
- `memory_policy`
- `tool`
- `role`
- `configuration`

Every proposal records a title, rationale, risk class, structured proposed change metadata, optional operator/agent identity, and timestamps. Risk classes are `low`, `medium`, `high`, and `critical`.

Direct proposal mutation remains out of scope. Proposal payloads that request immediate apply behavior, such as `applyNow: true` or `mutationMode: "direct"`, are rejected because proposal review/apply remains separate from assignment-scoped delegated mutation.

## Operator APIs

Create a proposal:

```bash
curl -X POST http://localhost:3210/admin/self-evolution/proposals \
  -H "Authorization: Bearer $OPERATOR_BEARER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "target": "role",
    "title": "Allow verifier docs reads",
    "rationale": "Verifier agents need docs context for parity checks.",
    "riskClass": "medium",
    "proposedChange": {
      "summary": "Add docs/**/* to verifier file globs.",
      "fileGlobs": ["src/**/*", "tests/**/*", "docs/**/*"]
    }
  }'
```

List recent proposals:

```bash
curl http://localhost:3210/admin/self-evolution/proposals \
  -H "Authorization: Bearer $OPERATOR_BEARER_TOKEN"
```

Proposals also appear in `/admin/summary`, `/admin/timeline`, and `/admin/export?scope=governance`.

Review a proposal:

```bash
curl -X POST http://localhost:3210/admin/self-evolution/proposals/sep_123/approve \
  -H "Authorization: Bearer $OPERATOR_BEARER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"reviewedBy":"operator","notes":"Safe operator settings change."}'
```

Apply an approved proposal:

```bash
curl -X POST http://localhost:3210/admin/self-evolution/proposals/sep_123/apply \
  -H "Authorization: Bearer $OPERATOR_BEARER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"appliedBy":"operator"}'
```

High- and critical-risk proposals require an explicit confirmation flag:

```json
{ "appliedBy": "operator", "confirmHighRisk": true }
```

Rollback an applied proposal:

```bash
curl -X POST http://localhost:3210/admin/self-evolution/proposals/sep_123/rollback \
  -H "Authorization: Bearer $OPERATOR_BEARER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"rolledBackBy":"operator"}'
```

Current proposal apply support is intentionally narrow. Only `configuration` proposals with `proposedChange.operatorSettings` can apply. The mutation record captures `before`, `after`, and rollback metadata before the operator settings are changed. Prompt, memory policy, tool, role, project-file, and broader runtime configuration proposals remain auditable proposals until safe mutation classes are added for them.

Apply and rollback execution lives behind the self-evolution mutation module. HTTP routes validate operator requests and serialize responses; target adapters own mutation validation, before/after/rollback payload construction, failure audit, and rollback effects.

## Assignment-Authorized Autonomous Apply

Autonomous assignments with `autonomyLevel: "evolve"` can apply the first bounded delegated mutation class through assignment admin APIs. This path is separate from proposal apply and writes to the autonomous mutation ledger, not the proposal mutation table.

Apply an autonomous operator-settings mutation:

```bash
curl -X POST http://localhost:3210/admin/assignments/asgn_123/mutations/apply \
  -H "Authorization: Bearer $OPERATOR_BEARER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "target": "configuration",
    "mutationType": "operator_settings",
    "rationale": "Slow down operator-console refresh while autonomous work is active.",
    "proposedChange": {
      "operatorSettings": { "dashboardRefreshSeconds": 12 }
    }
  }'
```

Roll back an applied autonomous mutation:

```bash
curl -X POST http://localhost:3210/admin/assignments/asgn_123/mutations/asgnmut_123/rollback \
  -H "Authorization: Bearer $OPERATOR_BEARER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"actor":"operator"}'
```

The default assignment self-evolution policy allows only low- or medium-risk `configuration.operator_settings` mutations, and only assignments at `evolve` authority may use it. Unsupported classes and malformed settings are rejected without changing settings and are audited as failed autonomous mutation evidence when policy permits the attempt to reach the mutation executor.

## Agent Tool

The in-process tool `self_evolution.propose` creates the same durable proposal record with `proposedBy: "agent"`. In the current implementation, it does not approve, apply, write files, change prompts, update config, or alter tool policy. Proposal apply/rollback and assignment-authorized autonomous apply/rollback remain operator-authenticated HTTP actions; read-only MCP assignment mutation tools remain read-only.
