# Governed Self-Evolution

Governed self-evolution lets Codex Phantom propose changes to its own behavior without mutating production state directly. This is the parity path for adaptive prompts, memory policy, tools, roles, and runtime configuration.

## Proposal Scope

Supported proposal targets:

- `prompt`
- `memory_policy`
- `tool`
- `role`
- `configuration`

Every proposal records a title, rationale, risk class, structured proposed change metadata, optional operator/agent identity, and timestamps. Risk classes are `low`, `medium`, `high`, and `critical`.

Direct mutation remains out of scope for this slice. Proposal payloads that request immediate apply behavior, such as `applyNow: true` or `mutationMode: "direct"`, are rejected.

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

## Agent Tool

The in-process tool `self_evolution.propose` creates the same durable proposal record with `proposedBy: "agent"`. It does not approve, apply, write files, change prompts, update config, or alter tool policy. Future approval/apply work must add explicit policy checks, rollback metadata, and operator-visible audit before any proposal can affect runtime behavior.
