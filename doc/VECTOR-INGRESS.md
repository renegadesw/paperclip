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

## Run-scoped Vector tools (disabled by default)

A turn may also carry an opaque, non-secret `authorityHandle`. Paperclip accepts
that field only when the complete tool bridge configuration is present:

- `PAPERCLIP_VECTOR_TOOL_BRIDGE_URL` is the exact literal-loopback Vector OS
  endpoint `http://127.x.x.x:<port>/internal/paperclip/v1/tools/call`.
- `PAPERCLIP_VECTOR_TOOL_CALLBACK_URL` is the exact literal-loopback Paperclip
  callback `http://127.x.x.x:<port>/api/internal/vector/v1/tools/callback`.
- `PAPERCLIP_VECTOR_INSTALLATION_ID` and `PAPERCLIP_VECTOR_PROFILE` identify the
  installed release profile.
- `PAPERCLIP_VECTOR_TOOL_BRIDGE_SECRET` is an independent secret of at least 32
  characters. It is not the Vector ingress secret or a user bearer.
- `PAPERCLIP_VECTOR_PI_PACKAGED_EXTENSIONS` is the existing deployment-owned,
  hash-pinned extension manifest. Its strict `tools` lists are the maximum tool
  set. Agent configuration cannot add a tool. Only entries with
  `"delivery":"callback"` enter the run capability. Local entries, such as the
  Vault reader, remain outside the callback bridge.

Paperclip binds a SHA-256 digest of the authority handle plus the installation profile
and external-session scope to the exact company, agent, conversation, and active
run. It then mints a random callback bearer for that run and writes the callback
URL, bearer, and approved tool names to a run-private `0600` capability file in a
`0700` directory. Pi receives only the capability-file path. The packaged bridge
extension reads and unlinks the file once at module load. Paperclip removes the
directory after execution and omits the path from invocation metadata. Remote Pi
execution fails closed until it has an equivalent private delivery channel.

The callback does not accept caller-selected scope. Paperclip reconstructs the
bound scope, signs the exact body with the bridge secret, and sends it to Vector
OS over literal loopback with redirects disabled. Ordinary callbacks have a
30-second bound. The blocking `ask_user` continuation has a distinct 15-minute
bound and remains tied to run cancellation.

Callback grants and replay state are memory-only. A Paperclip restart invalidates
all callback bearers; the persisted run binding hash remains as a fail-closed
scope fence. The current foundation does not reconnect a surviving Pi process.
The run must be recovered or recreated by later lifecycle wiring.

Tool request IDs are intentionally at-most-once. Paperclip consumes the request
ID before the Vector OS fetch, and Vector OS also rejects a repeated ID. An
ambiguous transport failure is not retried with the same ID because a mutating
tool may already have executed. Higher-level recovery must inspect state before
issuing a new request ID.

## Run-scoped Vector model authority (disabled by default)

A turn may carry a second opaque, non-secret `providerAuthorityHandle`. It is
accepted only when signed Vector ingress and the complete provider bridge
configuration are enabled:

- `PAPERCLIP_VECTOR_PROVIDER_BRIDGE_URL` is the exact literal-loopback Vector OS
  endpoint `http://127.x.x.x:<port>/internal/paperclip/v1/providers/redeem`.
- `PAPERCLIP_VECTOR_PROVIDER_BRIDGE_SECRET` is an independent secret of at
  least 32 characters.
- `PAPERCLIP_VECTOR_INSTALLATION_ID` and `PAPERCLIP_VECTOR_PROFILE` bind the
  redemption to the installed runtime scope.

Paperclip retains the opaque handle only in process memory, persists only its
SHA-256 digest and session-scope marker on the exact run, and redeems it just
before adapter execution. The redemption request is exact-body HMAC signed and
binds installation, profile, company, agent, conversation, session, and run.
Vector OS returns a short-lived router URL and token. Paperclip validates the
expiry, fetches the router's runtime catalog without following redirects, and
writes one run-private Pi `models.json` in a `0700` managed directory with mode
`0600`. Pi receives only `PI_CODING_AGENT_DIR`; the opaque handle, bridge secret,
router token, and database credentials are not child environment variables or
invocation metadata. The managed directory is removed after execution.

Provider grants are memory-only and fail closed after a Paperclip restart. The
run cannot fall back to a deployment-wide provider credential when its provider
authority is missing, expired, mismatched, or unavailable. When the bridge is
enabled, a Vector-managed agent pinned to a `router/...` model requires this
authority on every run; a browser/session identity without a router grant is not
silently upgraded or allowed to use ambient provider credentials.

This commit establishes the secure callback contract and Pi injection. It does
not mount the Vector OS tool/provider handlers, mint real authority handles, or
connect a product tool executor/provider exchange. Therefore it does not make
the path end-to-end functional by itself.
