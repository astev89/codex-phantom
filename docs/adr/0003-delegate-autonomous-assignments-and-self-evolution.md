# Delegate Autonomous Assignments and Self-Evolution

`codex-phantom` will use autonomous assignments as the durable unit of long-lived initiative: an operator-given objective that can continue across runs, scheduler wakeups, memory updates, channel notifications, and child assignments. Assignments are governed by explicit assignment policy, autonomy levels, lifecycle states, assignment-level notifications, operator controls, and an assignment step planner rather than by repeatedly rerunning the original prompt.

The project will support delegated autonomous self-evolution for assignments whose policy grants `evolve` or higher authority. This deliberately moves beyond proposal-only HITL self-evolution: Phantom may autonomously modify prompts, memory policy, tools, roles, runtime configuration, and project files when the assignment delegates that authority, but every autonomous mutation must record rationale, authorizing policy, risk, before/after evidence, affected resources, verification, notification, and rollback data in an autonomous mutation ledger.

This decision favors Ghostwriter-style hands-off autonomy over strict per-change human approval while keeping governance as policy, audit, rollback, budget limits, and operator interruption. Ambient unrestricted mutation remains out of scope; broad mutation authority is assignment-scoped, inspectable, bounded, and reversible.
