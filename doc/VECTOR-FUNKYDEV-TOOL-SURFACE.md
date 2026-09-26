# Vector FunkyDev Tool Surface

This document records the audited 2026-09-25 boundary between native
FunkyDev and Vector's chat-only installations while Vector moves execution
from the vendored Agents runtime to Paperclip.

## What the current source actually does

The native `pinative` FunkyDev build enables Pi's complete built-in coding
surface: `read`, `bash`, `edit`, `write`, `grep`, `find`, and `ls`. It installs
`rctl` on the runtime user's `PATH`, including its MCP server entry point and
read-only database profiles, but no current native-install source mounts that
server into Pi with an MCP configuration. Today `rctl` is therefore reachable
through `bash`; calling it an active Pi MCP surface would be inaccurate.

The intended standing-agent extension surface in the vendored Agents source
also contains:

| Capability | Tools | Paperclip status |
| --- | --- | --- |
| Read-only Vault reference | `vault_search`, `vault_read` | Ported as a package asset; runtime selection requires the sealed engineering release manifest |
| Operator question | `ask_user` | Paperclip callback bridge packaged; Vector OS must provide the durable question executor before activation |
| Todos | `todo_add`, `todo_list`, `todo_update`, `todo_mark_done` | Paperclip callback bridge packaged; Vector OS must provide owner-scoped executors before activation |
| GitHub broker and publisher | `github_read`, `github_manage`, `github_api`, `github_repo`, `publish_branch` | Ported through the run-scoped Vector callback; the grant is bound to the session's server-resolved role and repository, and the parent holds the GitHub App credential |
| Personal memory | `memory_save`, `memory_search`, `memory_forget` | Paperclip callback bridge packaged; Vector OS must provide the three owner-scoped executors before activation |
| Voice marker | `speak` | Ported in the matching Vector OS release: sealed local extension for engineering/standard, existing tool-frame projection, and private per-turn voice context; physical-device playback still requires acceptance |
| LLM meter | no model-callable tool | Not ported: Paperclip owns its run usage/cost accounting |
| Vector `/os/mcp` | server-defined analyst tools | Not current FunkyDev behavior; it belongs to the `funky-analyst` path and must not be imported without an explicit Vector identity contract |

There is also a current-source mismatch worth preserving as evidence, not as
behavior. The `/fd` transport stamps sessions with `service=vector-os-fd`,
while the legacy `isChatService` extension gate recognizes only
`nexuslink-chat`, `rpilot`, and `funky`. Tests assert the intended extension
surface using `nexuslink-chat`, not the real `/fd` service value. Therefore the
only surface proven to reach an actual `/fd` session from current source is
Pi's built-ins (and the runtime user's ordinary environment); the other tools
are intended but not proven active. Paperclip does not copy that service-name
bug: the installation profile, not a request service string, owns the ceiling.

## Legacy parity

`packages/adapters/pi-local/src/server/fixtures/funkydev-legacy-tool-snapshot.json`
is a byte-for-byte copy of Vector OS
`contracts/FUNKYDEV_LEGACY_TOOL_SNAPSHOT.json`: the label, description and
JSON Schema of every legacy FunkyDev tool, plus each extension's
`before_agent_start` prompt addition, captured by executing the legacy
`agents/piext/*.ts` sources. `funkydev-legacy-tool-parity.test.ts` fails if
the callback bridge or the Vault extension drops a legacy tool or changes any
of that model-facing text, the task-tracker guideline, or the saved-notes
recall block. A callback refusal (`422 tool_refused`) is returned to the model
as a tool result, as the legacy extensions did, so it can correct the call.

## Paperclip engineering package

The fork ships `funkydev-vault-reference.ts` in the Pi adapter package. The
composite Vector release must copy those exact bytes under
`tool-assets/engineering`, declare the asset in
`PAPERCLIP_PI_TOOL_SURFACES.json`, seal both with `SHA256SUMS`, and render that
selected profile entry into `PAPERCLIP_VECTOR_PI_PACKAGED_EXTENSIONS` for the
Paperclip process. The entry is shaped as:

```json
{
  "profile": "engineering",
  "path": "/absolute/release/tool-assets/engineering/funkydev-vault-reference.ts",
  "sha256": "8dd309b9ed85d93b85329bc0b0c1965e3947cf650ee54b233149b1b53d60fbb9",
  "tools": ["vault_read", "vault_search"],
  "delivery": "local",
  "permissions": { "filesystem": true, "shell": false }
}
```

The deployment also sets `PI_VAULT_REFERENCE_ROOT` to an absolute, read-only
mount. The Pi adapter then:

1. verifies the manifest entry names the active `engineering` profile;
2. verifies the asset is a regular file whose bytes match the manifest digest;
3. accepts its explicit filesystem authority only because the profile is
   `engineering`;
4. loads the extension and adds only `vault_search` and `vault_read` to the
   effective tool selection; and
5. keeps Pi's native coding built-ins unless the individual engineering agent
   config narrows them.

The Vault extension accepts Markdown files only, caps file sizes and output,
and realpath-checks the requested note so a symlink cannot escape the mounted
root. The package build copies the exact reviewed TypeScript extension into
`dist/vector-extensions`. Agent configuration cannot set the effective
deployment manifest.

## Why Standard and Funky cannot acquire it

Every non-empty Vector profile other than `engineering` is restricted,
including misspellings and future names. Restricted runs:

- always receive `--no-builtin-tools`;
- never execute the engineering-extension resolver;
- reject agent-configured env, extension/MCP/settings paths, command wrappers,
  and every mutable extra argument;
- start from a sterile managed Pi configuration directory; and
- may load only separately reviewed, deployment-owned restricted extensions
  named by the existing exact-path/SHA-256 allowlist.

An engineering asset presented to Standard, staging, production, demo, or an
unknown profile is rejected for profile mismatch. A restricted-profile asset
claiming filesystem or shell authority is also rejected. Merely setting
`PI_VAULT_REFERENCE_ROOT` never loads an extension. Focused tests assert those
negative contracts.

## Remaining compatibility seams

Do not copy the remaining legacy extensions until their authority exists on
the new path. Paperclip now supplies a private, run-scoped callback capability
for the approved todo, question, and memory tool names, but activation still
depends on matching Vector OS executors. The remaining minimum contracts are:

- Vector OS compatibility endpoints for memory, GitHub and task/todo calls, or
  replacements whose response and refusal semantics are intentionally mapped;
- bidirectional handling of Pi's `extension_ui_request` and
  `extension_ui_response` for `ask_user` (logging the event is not enough);
- deployment verification of the existing `speak` tool-frame projection for
  Tailchat/NexusLink/Funky clients; and
- an explicit decision whether FunkyDev should mount `/os/mcp`. Current source
  proves that bridge for the Funky analyst, not the native standing engineer.

Workspace scope remains an operating-system and Paperclip workspace concern.
Pi's `bash` cannot be safely jailed by a TypeScript path wrapper. The
engineering installation must continue to run as its dedicated unprivileged
runtime user with only intended repositories, credentials and mounts visible.
Restricted chat installations get no shell at all.
