export const type = "pi_local";
export const label = "Pi";

export const SANDBOX_INSTALL_COMMAND = "npm install -g @earendil-works/pi-coding-agent@1.0.0";

export const models: Array<{ id: string; label: string }> = [];

export const agentConfigurationDoc = `# pi_local agent configuration

Adapter: pi_local

Use when:
- You want Paperclip to run Pi (the AI coding agent) locally as the agent runtime
- You want provider/model routing in Pi format (--provider <name> --model <id>)
- You want Pi session resume across heartbeats via --session
- You need Pi's tool set (read, bash, edit, write, grep, find, ls)

Don't use when:
- You need webhook-style external invocation (use openclaw_gateway or http)
- You only need one-shot shell commands (use process)
- Pi CLI is not installed on the machine

Core fields:
- cwd (string, optional): default absolute working directory fallback for the agent process (created if missing when possible)
- instructionsFilePath (string, optional): absolute path to a markdown instructions file appended to system prompt via --append-system-prompt (restricted Vector profiles admit only a regular file inside <release>/paperclip/profile-assets/<profile>/ of the release pinned by PAPERCLIP_VECTOR_PI_COMMAND)
- promptTemplate (string, optional): user prompt template passed via -p flag
- promptMode ("compact" | "full", optional): Vector task prompts default to compact on engineering/standard; compact uses deployment role instructions and a single wake brief, full restores generic heartbeat templates. Chat, review/recovery context, connector authority, and non-Vector defaults are preserved.
- model (string, required): Pi model id in provider/model format (for example xai/grok-4)
- thinking (string, optional): thinking level (off, minimal, low, medium, high, xhigh)
- command (string, optional): defaults to "pi"
- executionMode (string, optional): "json" (upstream-compatible default) or "rpc"; Vector deployments select "rpc"
- builtinTools (string array, optional): built-in Pi tools to enable from read, bash, edit, write, grep, find, ls; omit for all, or set [] for zero built-ins
- env (object, optional): KEY=VALUE environment variables

Operational fields:
- timeoutSec (number, optional): run timeout in seconds
- graceSec (number, optional): SIGTERM grace period in seconds

Notes:
- Pi supports multiple providers and models. Use \`pi --list-models\` to list available options.
- Paperclip requires an explicit \`model\` value for \`pi_local\` agents.
- Sessions are stored in ~/.pi/paperclips/ and resumed with --session.
- All built-in tools (read, bash, edit, write, grep, find, ls) are enabled by default. Set \`builtinTools: []\` to pass Pi's explicit \`--no-builtin-tools\` switch.
- When \`PAPERCLIP_VECTOR_PROFILE\` is \`standard\`, \`staging\`, \`production\`, or \`demo\`, the deployment ceiling disables all tools and ambient extension, skill, prompt-template, theme, context-file, and settings discovery. The \`engineering\` profile may use its configured coding surface; any other non-empty profile value fails closed to the restricted policy.
- Restricted profiles reject mutable runtime-loading config, env, command wrappers, and extra arguments. They run with a sterile managed Pi agent directory and explicitly mount only Paperclip's bundled operational skill. A deployment-owned, exact-path/SHA-256 extension allowlist exists for future packaged read-only bridges and is empty by default.
- Agent instructions are appended to Pi's system prompt via --append-system-prompt. In json mode the user task is sent via -p; in rpc mode it is sent as a prompt command and stdin remains open until agent_settled.
- PAPERCLIP_PI_EXECUTION_MODE may set the deployment-wide default when an agent does not specify executionMode.
- On a Vector installation (any non-empty \`PAPERCLIP_VECTOR_PROFILE\`), a conversation turn whose wake carries only complete, user-authored pending comments reaches Pi like the legacy \`pi --mode rpc\` chat: the user prompt is those comment bodies verbatim (blank-line joined, plus the native image note), and the system prompt is the instructions file (or, on restricted profiles, the admitted persona/role) plus connector skill docs, without the Paperclip wake payload, task markdown, heartbeat/bootstrap templates, session handoff, or instructions path directive. Workload launches, recoveries, interaction answers, truncated/fallback-fetch batches, and non-conversation runs keep the Paperclip prompt.
`;
