# Native connector library authority

Vector's native runtime can reuse the connector gateway library without starting
Paperclip's scheduler or creating heartbeat runs. `createToolGatewayService`
accepts an optional, private `nativeSessionResolver`. It is configured by the
parent process, never an HTTP request or tool argument.

For every `native:<session-id>` operation, the resolver checks the current native
session, owner, organization, immutable source-agent mapping and installation
ownership. The returned execution uses the original source agent's assignments,
policies and credential grants, `actorType=agent`, and `runId=null`. Its actual
native session, installation and canonical owner identifiers are included in
the audit metadata. The retained Vector ingress used the source installation's
board principal for connector grants, separately from the conversation owner.
The resolver preserves that existing active company membership as the tool
principal. It never creates memberships, changes grants or substitutes another
user's authorization when the installed source membership is unavailable.
The resolver must refuse paused, stopped, held, terminated or revoked sessions.

Native discovery and execution allow only connected REST, remote MCP and local
MCP tools. Paperclip self, plugin, chat, fixture and orchestration tools are
excluded from lookup as well as discovery. Nested legacy `run_tool` calls cannot
escape this restriction. The native caller searches the permitted descriptors
and invokes their actual tool names directly.

All existing connector policy, grant selection, approval, argument validation,
content protection, transport and credential handling remains in the gateway.
An approval requirement is returned as pending; this adapter never approves it.
The native console needs an explicit approval integration to act on that ledger.

The native overlay is built from this independent source revision and placed as
`native-tool-gateway.js` beside the installed gateway. The original pinned
Paperclip archive and `tool-gateway.js` remain unchanged for rollback. The sealed
artifact records the independent source SHA, compatible archive SHA, source and
module hashes, and compiler version. There is no schema change in this fork.
