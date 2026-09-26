# Vector Pi Profile Isolation

Vector deployments use `PAPERCLIP_VECTOR_PROFILE` to separate the engineering
runtime used by FunkyDev from the chat-only runtimes used by Standard, staging,
production, and demo surfaces.

## Profile contract

- An unset profile retains upstream Paperclip behavior.
- `engineering` retains the configured Pi coding surface. It may use built-in
  tools, configured Paperclip skills, extensions, and MCP according to the
  deployment's engineering configuration. Its sealed release manifest may
  select the fork's packaged FunkyDev extensions.
- Every other non-empty profile is restricted. This includes `standard`,
  `staging`, `production`, `demo`, misspellings, and future profile names that
  have not received an explicit policy.

For a restricted profile the adapter enforces the boundary immediately before
Pi is launched:

1. Pi receives `--no-tools`, `--no-extensions`, `--no-skills`,
   `--no-prompt-templates`, `--no-themes`, `--no-context-files`, and
   `--no-approve`.
2. Pi runs with a fresh managed `PI_CODING_AGENT_DIR`, so user, host, and
   project settings cannot reintroduce packages, extensions, tools, or MCP.
3. Mutable `extraArgs`/`args` are rejected. This avoids betting the boundary on
   the current Pi flag parser or on a fixed list of future extension flags.
4. Mutable config fields for extensions, skills, custom tools, MCP, alternate
   settings/agent directories, prompt-template resources, themes, and
   filesystem-backed instructions are rejected.
5. Any non-empty agent `config.env` is rejected. This check runs against the
   persisted agent adapter config before Paperclip derives its controller-owned
   run/workspace environment, so normal run identity and scratch metadata do
   not make every restricted run fail. Provider credentials, endpoints, and
   other required values must come from the deployment process environment;
   unknown future loader variables therefore fail closed too.
6. The executable must equal `PAPERCLIP_VECTOR_PI_COMMAND` when that deployment
   pin is set; otherwise it must be `pi`. An agent cannot substitute a wrapper.
7. Runtime skill paths/selections supplied through agent config are ignored.
   The adapter builds a private skill directory from the fork's bundled skill
   catalog and explicitly mounts only the legacy Paperclip operational skill.
   Pi's `--no-skills` still permits this explicit `--skill` path, preserving the
   control-plane prompt contract without ambient skill discovery. This is
   verified against the pinned Pi 0.84.1 resource loader: `noSkills` removes
   discovered settings/project skills but retains CLI `additionalSkillPaths`.

These controls are a process-launch ceiling. They do not rely on prompt text,
agent role names, company permissions, or frontend behavior. Vector OS remains
responsible for assigning the correct deployment profile to each installed
runtime; Paperclip enforces the resulting Pi launch surface.

## Packaged extension hook

Restricted profiles expose no extension tools by default. A future
Vector-owned, read-only bridge may be enabled only from the Paperclip server
process environment with `PAPERCLIP_VECTOR_PI_PACKAGED_EXTENSIONS`. Agent config
and adapter env cannot set the effective allowlist.

The value is a JSON array:

```json
[
  {
    "profile": "standard",
    "path": "/opt/vector/paperclip/extensions/vector-chat.js",
    "sha256": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    "tools": ["vector_chat_read"],
    "permissions": { "filesystem": false, "shell": false }
  }
]
```

Each path must be absolute and identify a regular file. Its bytes must match the
declared SHA-256 before Pi starts, and the declared profile must equal the
running profile. Every asset explicitly declares filesystem and shell
authority; restricted profiles reject either authority. Only the listed tool
names are passed through Pi's tool allowlist. A malformed entry, missing file,
profile mismatch, forbidden authority, or digest mismatch fails the run closed.
Vector OS's sealed `PAPERCLIP_PI_TOOL_SURFACES.json` and release-local
`tool-assets/<profile>` are the source of these entries; Paperclip does not
maintain a second hidden extension list.

## Non-goals

- Pi's native coding tools remain the FunkyDev filesystem surface. This change
  ports only the self-contained read-only Vault extension. Callback-bound
  legacy tools and MCP candidates remain blocked as inventoried in
  [Vector FunkyDev Tool Surface](./VECTOR-FUNKYDEV-TOOL-SURFACE.md).
- It does not decide which Vector host receives which profile.
- It does not make Standard, staging, production, or demo agents capable of
  executing Paperclip skill binaries; `--no-tools` prevents that execution.
- It does not treat a successful unit test as installed or deployed behavior.
