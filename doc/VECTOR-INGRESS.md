# Vector OS internal ingress

The Vector fork exposes an optional service-only API that lets Vector OS keep
its public `/os` and `/v1` contracts while Paperclip owns conversation tasks and
agent runs. It does not replace or extend Paperclip board or agent-key auth.

The routes exist only when `PAPERCLIP_VECTOR_INGRESS_SECRET` is set to an
independent random secret of at least 32 characters. Every request must also
arrive directly from a loopback socket. `X-Forwarded-For` is deliberately not
trusted for this check.

## Signing

Send:

- `X-Vector-Timestamp`: current Unix time in seconds
- `X-Vector-Signature`: `v1=<lowercase hex HMAC-SHA256>`

The signature input is the following newline-separated string:

```text
paperclip-vector-ingress/v1
<timestamp>
<uppercase HTTP method>
<exact request path>
<lowercase hex SHA-256 of the exact request body bytes>
```

Sign that input with `PAPERCLIP_VECTOR_INGRESS_SECRET`. The default accepted
clock skew is 60 seconds. It can be set from 1 through 300 seconds with
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
`clientRequestId`, `body`, and optional `attachmentIds`. The external session
identifier is stored only as a stable SHA-256-derived conversation owner. The
response includes the Paperclip company, agent, issue, comment, wake request,
and run identifiers. Replaying the same `clientRequestId` with the same body
and attachments returns the original result; changing either is `409`.

`POST /sessions/reset` accepts the same scope and a `clientRequestId`. It queues
Paperclip's existing `/new` conversation command, preserving visible history
while rotating only that task's provider session.

`POST /sessions/cancel` accepts the same scope and an optional `runId`. It may
cancel only a queued or running heartbeat whose company, agent, and issue all
match that exact conversation. A foreign or stale run ID is `409`.

Attachment IDs must already belong to the resolved Paperclip issue and company.
The normal Paperclip attachment binding and conflict checks remain authoritative.

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
  set. Agent configuration cannot add a tool.

Paperclip binds a SHA-256 digest of the authority handle plus the installation profile
and external-session scope to the exact company, agent, conversation, and active
run. It then mints a random callback bearer for that run and injects only the
callback URL, bearer, and approved tool names into the Pi process. The callback
does not accept caller-selected scope. Paperclip reconstructs the bound scope,
signs the exact body with the bridge secret, and sends it to Vector OS over
literal loopback with redirects disabled.

Callback grants and replay state are memory-only. A Paperclip restart invalidates
all callback bearers; the persisted run binding hash remains as a fail-closed
scope fence. The current foundation does not reconnect a surviving Pi process.
The run must be recovered or recreated by later lifecycle wiring.

Tool request IDs are intentionally at-most-once. Paperclip consumes the request
ID before the Vector OS fetch, and Vector OS also rejects a repeated ID. An
ambiguous transport failure is not retried with the same ID because a mutating
tool may already have executed. Higher-level recovery must inspect state before
issuing a new request ID.

This commit establishes the secure callback contract and Pi injection. It does
not install a FunkyDev filesystem extension, mount the Vector OS handler, resolve
real authority handles, or connect a product tool executor. Therefore it does
not make the path end-to-end functional by itself.
