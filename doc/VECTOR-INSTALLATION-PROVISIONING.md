# Vector installation provisioning

Vector's native release may provision one installation-owned company and a
stable agent roster before the Paperclip server starts. The supported entrypoint is:

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

- `engineering` provisions exactly the FunkyDev engineer and no Funky workload catalog;
- `standard` provisions exactly the Standard Chat agent and no Funky workload catalog;
- `staging` provisions exactly Funky analyst, Scout, and Advisor plus all seven
  current Vector workload contracts.

The optional `workloads` catalog records the exact relationship between stable
Vector workload keys and roster agents. Paperclip-owned work may use ordinary
issues. A workload whose authority remains Vector's database must declare
`runtimeAuthority: "vector_lease_triple"` and a credential-free, default-off
bridge contract. Its imported `vector_jobs` schedule must also remain disabled.
The canonical catalog digest and each agent's assigned workload keys are stored
in agent metadata, so an edited task/tool/schedule mapping is immutable drift
instead of a silent behavioral change.

Reconciliation is intentionally strict:

- first application creates the company and complete roster atomically;
- retry returns the same company and agent IDs without creating duplicates;
- a name owned by another stable ID is an identity collision;
- an immutable field difference is drift and aborts provisioning;
- an operator-owned field is preserved only when its name appears in that
  entity's explicit `mutableFields` list;
- selected-profile, effective-tool-policy, path, and digest mismatches fail
  before database mutation;
- failures print only `Vector provisioning failed` from the CLI boundary.

This entrypoint provisions only the declared company, agents, and workload
contract metadata. It does not claim or settle Vector tasks, enable imported
schedules, create Paperclip routines for Vector lease queues, import historical
transcripts, or add the remaining FunkyDev callback-backed tools. See
`VECTOR-ROSTER-WORKLOAD-PARITY.md` for the exact current mapping and cutover
gaps.
