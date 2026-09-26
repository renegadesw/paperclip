# Vector roster and workload parity

This is the first honest, credential-free port contract for Vector's existing
agent roster and background workloads. It was derived from Vector OS
`9e632d512b42ef29e6030d4ca707d389a81742ea` and Vector
`1b3c073708f9d6f3c1ac2bc960b1a3c4e442a5c6`.

The manifest can now provision every deterministic agent identity below with a
stable UUID, Pi RPC config, release-owned instruction digest, disabled timer
heartbeat, tool policy, and immutable workload-catalog digest. It deliberately
does not claim that a Paperclip routine is equivalent to Vector's lease queues.

## Agent parity

| Existing Vector role | Paperclip mapping | Prompt source | Tool policy | Current parity |
| --- | --- | --- | --- | --- |
| `funky-analyst` | stable `pi_local` agent | Vector OS composes the product persona and live client charter | product tool authority must arrive through the signed Vector bridge | identity/config representable; live turn bridge still required |
| `funky-scout` | stable `pi_local` agent | each Vector research/task claim supplies its DB-built prompt, charter, payload, and output contract | no Pi built-ins; research kinds are toolless | identity/config representable; claim execution still requires the lease bridge |
| `funky-advisor` | stable `pi_local` agent | Vector OS composes the selected Advisor identity, directives, charter, and turn | no ambient Pi built-ins; generic task grants are claim-scoped | identity/config representable; role-turn and task bridges still required |
| FunkyDev | stable `pi_local` engineering agent | release-owned `AGENTS.md` | engineering Pi built-ins plus the explicit Vault extension only | provisionable now |

The old `funky.current_scout`, `funky.macro_scout`,
`funky.demand_scout`, `funky.synthesis`, and `funky.curation` roles are disabled
history, not additional agents to recreate.

## Workload parity

| Workload | Shape / role | Schedule | Existing authority that must remain during bridge phase | Paperclip status |
| --- | --- | --- | --- | --- |
| `current_scout` | single shot / `funky-scout`, no tools; detachable; 300s lease, three attempts, 12k task budget | `fa_research_daily`, `20 8 * * *`, America/New_York, disabled | `os.research_tasks`, claim gates, lease triple, evidence receipt, settlement | cataloged as `research_task`; bridge required and default-off |
| `macro_scout` | single shot / `funky-scout`, no tools | same research schedule | same | same |
| `demand_scout` | single shot / `funky-scout`, no tools | same, plus its `fa_rollup_query_themes` dependency | same | same |
| `synthesis` | single shot / `funky-scout`, no tools | same | dependency completion/deadline rules and partial synthesis | same |
| `curation` | single shot / `funky-scout`, no tools | same | dependency order and fail-closed publish/hold settlement | same |
| `dmv_review` | single shot / `funky-scout`, no tools; not detachable; 900s lease, two attempts, 8k task budget | `fa_dmv_review_daily`, `30 7 * * *`, America/New_York, disabled | product/type/schedule gates, run reservation, evidence receipt, `dmv.review_settle`, escalation to `compliance-advisor` | cataloged as `generic_task`; bridge required and default-off |
| `dmv_audit_back_triage` | session / `funky-advisor`; detachable; 1200s lease, two attempts, 24k task budget | `fa_dmv_audit_back_triage_daily`, `0 8 * * *`, America/New_York, disabled | three read-tool grants, max two `reader` or `dmv-client-reader` children at depth one, evidence, `dmv.review_settle`, escalation to `compliance-advisor` | cataloged as `generic_task`; bridge required and default-off |

The research, generic-task, and query-theme schedule rows all ship disabled.
The research and generic lease-recovery schedules also remain Vector-owned:
`fa_research_lease_sweep` and `fa_task_lease_sweep`, both every five minutes.
The catalog preserves each schedule's `os` target function and JSON parameters,
not only its cron string. In particular, the two DMV schedule rows request 16k
and 48k run budgets and 180- and 240-minute deadlines. Vector's enqueue gate
narrows those requests to the task-type ceilings of 8k and 24k. Paperclip does
not apply either value.

The signed workload launch ingress validates the exact agent/workload mapping
and preserves the dynamic Vector system prompt, role, model policy, tool list,
execution metadata, and a non-reversible lease-token digest through the Pi run.
Vector OS remains the executable owner of claim, heartbeat, retry, detach,
cancellation, and settlement; Paperclip does not emulate those database
semantics with routines.

## Why these are not Paperclip routines yet

Paperclip issues already provide assignment, atomic checkout, heartbeat runs,
retries, budgets, and schedules. They do not currently reproduce this exact
Vector contract:

- the database evaluates feature, type, run-budget, lineage, readiness,
  evidence, and prompt gates before outbound model I/O;
- authorization is the exact `(task_id, attempt, lease_token)` claim and every
  heartbeat/tool/child/settlement call is bound to it;
- detached work keeps its attempt and provider session, releases its lease,
  and must be reclaimed before spawning;
- completion may be committed even when its HTTP response is lost, so transport
  failure cannot be converted into a false failure;
- type-specific settle functions promote structured results into domain tables;
- child work has separate depth, allowlist, parallelism, and parent-budget
  accounting.

Creating ordinary Paperclip cron routines for these rows would duplicate
schedules while dropping those guarantees. The migration therefore uses one
owner at a time: Vector remains authoritative for these queues until either
Paperclip gains equivalent primitives or the domain is intentionally redesigned.

## Narrow bridge contract

Each Vector-owned workload must declare a credential-free bridge mapping with
claim, heartbeat, complete, fail, and (where supported) detach paths. The bridge
is always provisioned `defaultEnabled: false`; configuration alone cannot begin
claiming work. The runtime must additionally bind the Paperclip installation,
company, agent, run, and Vector claim identity before provider startup. Tool and
settlement calls use the server-held claim authority, never model-supplied
identifiers.

The current endpoint families are:

- research: `/inbound/vector-agents/research/{claim,heartbeat,complete,fail,detach}`;
- generic tasks: `/inbound/vector-agents/tasks/{claim,heartbeat,complete,fail,detach}`.

## Remaining implementation gaps

1. Vector OS must emit the profile-specific multi-agent manifest and the exact
   workload catalog rather than only the current FunkyDev root-agent seed.
2. The Paperclip-side executor for the default-off bridge is not implemented in
   this change; until it is, no cataloged Vector workload can dispatch.
3. Funky analyst and Advisor interactive turns still need their signed,
   owner-scoped Vector ingress adapters and client-charter composition.
4. The generic task tool relay and in-turn child contract need run-scoped
   authority integration; listing tool names in the catalog grants nothing.
5. Existing `os.research_*`, `os.tasks`, attempt ledgers, `llm.sessions/frames`,
   and schedule history require an explicit import/union or retention decision.
6. Cutover needs adversarial two-installation tests, restored-Vector-database
   migration proof, exact schedule-owner fencing, and live end-to-end settlement
   evidence before any Vector scheduler is disabled.
