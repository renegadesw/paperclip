# Pi coordination contract

Local Pi JSON and stdio RPC execution share the same run preparation. Transport
selects how a prompt and events move; it does not select the run environment,
coordination authority, connector grants, workspace permissions or instructions.
Both retain Pi's JSONL session storage. RPC waits for `agent_settled` before
capturing state and closing stdin.

The adapter registers the native `paperclip` tool when local execution has API,
company, agent and run authority. It supplies known company/issue routes, bearer
authentication and the run audit header. The existing API remains authoritative
for company access, checkout conflicts, review gates, assignments and wake-ups.
The extension does not create grants, bypass approval, retry writes, or follow
redirects. It bounds model-facing responses and returns API denials as tool
errors. Use assignment/status changes to hand off ready work, verify mutations,
and stop on checkout conflicts. Basic coordination does not require discovering
an MCP connection or reading the entire operational skill.

Assigned connector tools are registered before either transport starts. Prefer
an already available matching tool; use discovery only for missing tools.
Connector approval holds and provider tool errors remain errors in Pi results.

Embedded Vector runs project controller-owned environment variables in both
transports. Server database/broker configuration is not inherited by the child.
Engineering Pi retains built-ins and managed Git/gh launchers for agent-owned
workspace preparation. Each Git operation acquires the existing selected run
identity through Paperclip's broker, strips host credentials, and observes
operation-time trust/revocation checks. Engineering does not fall back to host
credentials. Shell rctl remains denied; use the assigned database connector.
Other engineering adapter types retain connector-only wrappers. Restricted Pi
profiles receive coordination/connector tools without enabling shell or file
built-ins.

Remote Pi targets retain their existing delivery limitations: this adapter does
not yet stage the local coordination or connector extensions remotely. This is
local JSON/RPC parity, not a claim of remote extension support.

Regression coverage includes the real adapter spawning recording Pi processes
in both modes, native API request construction and conflict handling, restricted
tool allowlists, gateway errors, managed launchers, credential isolation and
broker authorization. These tests do not establish live model efficiency or
successful production handoffs.
