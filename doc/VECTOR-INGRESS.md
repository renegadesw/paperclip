# Vector OS internal ingress

The Vector fork exposes an optional service-only API that lets Vector OS keep
its public `/os` and `/v1` contracts while Paperclip owns conversation tasks and
agent runs. It does not replace or extend Paperclip board or agent-key auth.

The routes exist only when `PAPERCLIP_VECTOR_INGRESS_SECRET` is set to an
independent random secret of at least 32 characters and the server has admitted
a complete Vector runtime scope. Every request must also arrive directly from a
loopback socket. `X-Forwarded-For` is deliberately not trusted for this check.
The signed request company and agent must match the configured company and
allowed-agent set. Supplied installation/profile fields must match as well.

## Signing

Send:

- `X-Vector-Timestamp`: current Unix time in seconds
- `X-Vector-Signature`: `v2=<lowercase hex HMAC-SHA256>`

The signature input is the following newline-separated string:

```text
paperclip-vector-ingress/v2
<PAPERCLIP_VECTOR_INSTALLATION_ID>
<PAPERCLIP_VECTOR_PROFILE>
<PAPERCLIP_VECTOR_COMPANY_ID>
<sorted comma-separated PAPERCLIP_VECTOR_ALLOWED_AGENT_IDS>
<timestamp>
<uppercase HTTP method>
<exact request path>
<lowercase hex SHA-256 of the exact request body bytes>
```

Sign that input with `PAPERCLIP_VECTOR_INGRESS_SECRET`. The default accepted
This prevents the same signed body from being replayed under a different
installation/profile authority even if a secret is accidentally shared. The
default accepted clock skew is 60 seconds. It can be set from 1 through 300 seconds with
`PAPERCLIP_VECTOR_INGRESS_MAX_CLOCK_SKEW_SECONDS`.

Runs and comments are attributed to
`PAPERCLIP_VECTOR_INGRESS_RESPONSIBLE_USER_ID` (`local-board` by default),
while the hashed external session remains the conversation owner key. In an
authenticated deployment, set this to a real Paperclip user with access to the
target companies so user-owned AI connections and audit attribution resolve
correctly.

## API

All routes are under `/api/internal/vector/v1`.

`POST /turns` accepts `companyId`, `agentId`, `externalSessionId`,
`clientRequestId`, `body`, optional `attachmentIds`, and an optional
`launchContext`. The external session
identifier is stored only as a stable SHA-256-derived conversation owner. The
response includes the Paperclip company, agent, issue, comment, wake request,
and run identifiers. Replaying the same `clientRequestId` with the same body
and attachments returns the original result; changing either is `409`.

`launchContext` is reserved for Vector database-authorized workloads. It carries
the workload key, queue, task/attempt identity, SHA-256 of the lease token,
role, model policy, exact tool names, restricted-builtin declaration, dynamic
system prompt, and bounded execution metadata. Paperclip accepts it only with a
complete owner scope and only when it exactly matches the target agent's
release-provisioned workload contract. The raw lease token remains in Vector OS
and never enters Paperclip. The admitted system prompt is added to Pi's system
prompt for that run; the canonical context is also retained with the run and
comment so retries cannot change it behind the same request ID.

`POST /sessions/reset` accepts the same scope and a `clientRequestId`. It queues
Paperclip's existing `/new` conversation command, preserving visible history
while rotating only that task's provider session.

`POST /sessions/cancel` accepts the same scope and an optional `runId`. It may
cancel only a queued or running heartbeat whose company, agent, and issue all
match that exact conversation. A foreign or stale run ID is `409`.

Attachment IDs must already belong to the resolved Paperclip issue and company.
The normal Paperclip attachment binding and conflict checks remain authoritative.

Transcript projection is an intentionally reduced surface. Error commands and
provider error text are not returned. Tool arguments, partial results, and
results are recursively redacted for secret-bearing fields and bearer/private
authority patterns, with bounded depth, entry count, strings, and total budget.
