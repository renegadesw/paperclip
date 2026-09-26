# Vector installation provisioning

Vector's native release may provision one installation-owned company and root
agent before the Paperclip server starts. Provisioning also creates the durable
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
policy. The instructions asset is checked against its manifest SHA-256 in the
staged release. The stored adapter path points through the installation's
stable `current` symlink so it survives release-directory renames and rollback.

Reconciliation is intentionally strict:

- first application creates the company, ownership binding, and agent atomically;
- retry returns the same company and agent IDs without creating duplicates;
- a name owned by another stable ID is an identity collision;
- an installation ID, profile, or company ownership mismatch is immutable drift;
- an immutable field difference is drift and aborts provisioning;
- an operator-owned field is preserved only when its name appears in that
  entity's explicit `mutableFields` list;
- selected-profile, effective-tool-policy, path, and digest mismatches fail
  before database mutation;
- failures print only `Vector provisioning failed` from the CLI boundary.

This entrypoint provisions only the declared company and agent. It does not
import Vector Scout, Advisors, legacy tasks, routines, schedules, transcripts,
or the remaining FunkyDev callback-backed tools.
