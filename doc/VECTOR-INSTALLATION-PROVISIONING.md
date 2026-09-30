# Vector installation provisioning

Vector's native release may provision one installation-owned company and a
stable agent roster before the Paperclip server starts. Provisioning also creates the durable
installation/profile/company ownership binding used by startup admission. The
supported entrypoint is:

```text
server/dist/vector-provision.js
```

This is an offline, pre-activation contract. It uses Paperclip's company and
agent services inside one database transaction; it does not write Paperclip
tables from the deployment repository and it does not use the interactive
hiring workflow.

The command reads all input from its environment. `DATABASE_URL` is the only
secret input. The manifest, selected profile, staged release root, stable
`current` release root, and effective deployment-owned tool policy are passed
through `PAPERCLIP_VECTOR_*` variables. No credentials belong in the manifest,
argv, stdout receipt, or error output.

The manifest pins stable UUIDs, installation/profile identity, Pi adapter type,
RPC execution mode, model, thinking level, workspace, release-owned
instructions, runtime heartbeat policy, permissions, and the deployment tool
policy for the root agent and any additional roster agents. Every instructions
asset is checked against its manifest SHA-256 in the staged release. Stored
adapter paths point through the installation's stable `current` symlink so they
survive release-directory renames and rollback. Supported profiles are
`engineering`, `standard`, and `staging`; only engineering may declare ambient
Pi built-ins or extensions.

Roster shape is profile-closed rather than a shared superset:

- `engineering` provisions the FunkyDev software org and no Funky workload
  catalog: FunkyDev (role `engineer`) is the primary agent and reports to no
  agent; every other seat (for example department managers, their engineers,
  and QA) must report to an agent declared before it;
- `standard` provisions exactly the Standard Chat agent and no Funky workload catalog;
- `staging` and `production` (the Funky server profiles) provision exactly
  Funky analyst, Scout, and Advisor plus all eight Funky workload contracts.

The optional `workloads` catalog records the exact relationship between stable
Vector workload keys and roster agents. The canonical catalog digest and each
agent's assigned workload contracts (including each workload's declared tool
surface) are stored in agent metadata, so an edited task/tool/schedule mapping
is immutable drift instead of a silent behavioral change.

On the Funky server profiles every workload is native Paperclip work
(`promptSource: "paperclip_issue"`, `runtimeAuthority: "paperclip"`, no
bridge, no Vector jobs schedule or lease recovery sweep). Provisioning seeds
one ordinary issue-creating routine per workload, `origin_kind =
vector_research_workload` and `origin_id` = the workload key, with sealed
title, description (the agent's instructions for one run), assignee,
`skip_if_active` and `skip_missed`, and a schedule trigger in
America/New_York:

| workload | assignee | cron | trigger at seed |
| --- | --- | --- | --- |
| `current_scout`, `macro_scout`, `demand_scout` | Funky Scout | `20 8 * * *` | enabled |
| `advisor` | Funky Advisor | `40 8 * * *` | enabled |
| `synthesis` | Funky Scout | `20 9 * * *` | enabled |
| `curation` | Funky Scout | `50 9 * * *` | enabled |
| `dmv_review` | Funky Advisor | `30 7 * * *` | disabled |
| `dmv_audit_back_triage` | Funky Advisor | `0 8 * * *` | disabled |

Trigger enablement and routine pause/archive are the operator's; every other
routine and trigger field is sealed. The only Vector jobs schedule Paperclip
still dispatches is `fa_rollup_query_themes` (demand scout's input). The two
Vector queue pumps (`vector_workload_dispatch`) and the `fa_research_daily`,
`fa_research_lease_sweep`, `fa_task_lease_sweep`, `fa_dmv_review_daily` and
`fa_dmv_audit_back_triage_daily` schedule routines are no longer seeded; an
existing one is archived with its triggers disabled, and its run history kept.

Funky Scout and Funky Advisor have no Paperclip issue tools, so Paperclip
settles a research routine issue from its run when the run is released: a
succeeded run closes it `done` with a comment carrying the run's final
summary (redacted, truncated); a failed, cancelled, timed-out or interrupted
run marks it `blocked` with a comment carrying the error code and message. A
queued retry or other active run on the issue defers settlement. Stranded
issue recovery excludes these issues explicitly.

A run on a research routine issue binds run-scoped provider and tool authority
before it starts, through `PAPERCLIP_VECTOR_ROUTINE_AUTHORITY_URL`
(`POST /inbound/paperclip/v1/routine-runs/authority`, signature version
`vector-paperclip-routine-run-authority/v1`). The grant must stay inside the
workload's declared tool surface; a refusal, a wider grant, or a missing
endpoint fails the run instead of running it without its boundary.

Each agent may declare `reportsTo`, the id of its manager. It must name an
agent declared earlier in the manifest, which rules out self-references,
forward references, unknown ids, and cycles, and makes manifest order the
creation order: a manager is always created (or re-pointed) before its reports.
When the roster owns its hierarchy (always on engineering; on another profile
once any agent declares a manager) `reportsTo` is a sealed agent field: it is
set on create, rewritten on a revision upgrade, and a board edit of it is drift
at the same revision. A flat roster that never declares it is unchanged: the
field is neither written nor asserted, and its roster digest is identical to
the one recorded before the field existed. A null `reportsTo` never enters the
roster digest.

A revision upgrade updates the kept agents in manifest order, creates the new
ones, and terminates agents this installation provisioned under an older
revision that the manifest no longer declares. Operator-owned adapterConfig
keys and grants attached to an agent (such as FunkyDev's GitHub connection)
are not provisioning fields and survive the upgrade. The receipt's `agentIds`
lists the whole roster in manifest order; `agentId` is the primary agent.

Reconciliation is intentionally strict:

- first application creates the company, ownership binding, and complete roster atomically;
- retry returns the same company and agent IDs without creating duplicates;
- a name owned by another stable ID is an identity collision;
- an installation ID, profile, or company ownership mismatch is immutable drift;
- an immutable field difference is drift and aborts provisioning;
- an operator-owned field is preserved only when its name appears in that
  entity's explicit `mutableFields` list;
- selected-profile, effective-tool-policy, path, and digest mismatches fail
  before database mutation;
- failures print only `Vector provisioning failed` from the CLI boundary.

This entrypoint provisions only the declared company, agents, workload
contract metadata, and the Funky routines above. It does not claim or settle
Vector tasks, enable imported Vector schedules, import historical transcripts,
or add the remaining FunkyDev callback-backed tools.
`VECTOR-ROSTER-WORKLOAD-PARITY.md` records the earlier lease-bridge mapping
that the native research routines replace.
