# Vector engineering upstream integration — 2026-10-01

This update is for the direct t480/FunkyDev engineering setup. It does not
activate a release, apply live database migrations, resume agents, or authorize
staging or production deployment. Publish this branch with CI skip markers;
the initial handoff included no PR or workflow dispatch. The owner later
authorized [RD-451](https://oxygenxl.atlassian.net/browse/RD-451) and a PR in
the fork, ready for review, with work stopped before merge. The earlier no-CI
rule remains until the owner resolves the PR-triggered review workflow.

## Sources and coordination

- Repository: `renegadesw/paperclip`.
- Engineering integration branch: `vector/engineering-upstream-20261001`.
- Connector repair baseline: `fix/personal-pat-run-credentials`,
  `cc8bf4f4c7536d77c251f5594975064342ab34bb`.
- Upstream default branch: `paperclipai/paperclip:master`,
  `427e0484059c33fdfd98263e2d6f4c3a27a7e156`.
- Initial upstream merge: `67ebed8a5271713181b110a6f8c4fd5561b1deb9`;
  the subsequent `41c18aa443fe791fa67b27eef28fd7239f5e9d5d` and
  `f07f8d959970d95b22a4084fcd27b648309c5162` advances update Storybook
  development dependencies only. Dependencies, typecheck and build were
  refreshed after those advances. The final refresh through `427e04840` adds
  release-note corrections and a managed-checkout skill import boundary fix.
- Existing connector repair session: `01a0f617-4858-7ff3-a256-1cb557a7ad58`.
  Its clean, pushed repair commits are included as ancestors. Final identity
  naming repair: `0ea25a79a9b7adc6a7126d5333be47149b1481b3`; engineering
  startup identity repair: `33d0e70f1dc74f8974dd5f66e56e8a5b1a4d6314`; gateway
  discovery/selection repair: `41ea207955b58d40a643772cb14e1bda9d3fedbd`. Its installed dev
  overlay and the primary local checkout are not changed by this integration.
  Board retry authority repair `e47bd3869ba485418fbf9ea763021a7dfa99173c` is
  also merged: verified board retries receive fresh run-bound authority while
  ingress handles and mismatched or active predecessors remain fail closed.
  Final Pi completion repair `c785b4cc4acdae287de9ce5922b67cd7aa828a24` is
  included: a provider length stop is incomplete work, including thinking-only
  output and an agent-end-only terminal envelope. It must not appear successful.
  On-demand search repair `ebf8c09913ad441448e0d68c491f7e7c576684f4` is
  included. Search matches connection IDs and action words across spaces,
  hyphens and underscores. Company scope and execution policy checks remain.

## Compatibility decisions

- Retain the loopback Vector connector broker and its GitHub App installation
  identity, alongside the separate personal GitHub credential and grant.
- Port canonical personal secret paths and dedicated agent binding paths into
  upstream's extracted credential helpers. Setup and reconnect use upstream's
  transactional credential writer; health, discovery and invocation share its
  ownership checks. Existing grant bindings remain usable until reconciliation.
- Keep both GitHub identities distinguishable in Pi tool names and descriptions,
  retaining the short connection ID and action while preserving canonical
  gateway names and upstream Google Chat descriptions.
- Preserve both assigned GitHub connections during engineering run startup.
  Other profiles retain the existing GitHub identity selection policy. Upstream
  native identity contexts and immutable assignment digest checks are retained.
- Keep engineering GitHub and database access through assigned connectors.
  The launcher still denies shell `git`, `gh` and `rctl` and does not mint a
  shell credential capability for an engineering run.
- Keep cached personal/per-agent catalogs discoverable after a credential-less
  health sweep. Invocation still resolves the selected connector grant and
  denies missing grants. Engineering avoids single-identity GitHub remapping;
  other profiles and upstream guest-run restrictions retain their policy.
- Keep the rctl DB connector configuration and grants. No rctl source or
  persistent connector configuration is modified here.
- Combine upstream prompt composition and stop proof with Vector Pi RPC,
  release instructions, image redaction and plain conversation behavior.
- Preserve the board's URL prefix while adopting upstream API error handling,
  adapter branding and private-response service worker protections.

## Permanent Paperclip Cloud prohibition

The owner requires engineering to exercise the same policy as production.
Paperclip Cloud is disabled in source for every profile; no saved preference
or environment opt-in can restore it. The shared policy has no hosted default.

- Connector destinations must be explicit HTTP/HTTPS IP loopback origins
  (`127.0.0.1` or `::1`). Missing URLs, DNS names, hosted overrides and hosted
  stored identities fail before I/O; enrollment refuses them before creating
  keys. Broker POSTs refuse redirects, including enrollment callbacks.
- Keep the local Vector broker, its `/__connector/` relay, callback paths,
  sealed claims and grant handling. A `production` connector protocol label
  is valid with a local broker and does not imply Paperclip Cloud.
- Runtime telemetry and hosted announcements are permanently disabled.
  Telemetry has no Paperclip or AWS fallback; direct client construction is
  limited to an explicit IP loopback diagnostics endpoint and refuses redirects.
- Feedback trace uploads always fail with `PAPERCLIP_CLOUD_DISABLED`; the
  upload transport is removed. Local feedback and downloadable bundles remain.
- Cloud portfolio requests return 403; lifecycle notification transport is
  removed. Restrictive managed-instance company/security floors remain.
- Startup refuses Paperclip Cloud tenant credentials, control-plane origins
  and nonlocal connector broker URLs. GitHub, PAT, rctl and operator-selected
  observability providers remain separate from the first-party Cloud policy.

Privacy review: this change removes outgoing first-party collection. It adds
no events, dimensions or payload fields, so the generated telemetry contract
is unchanged. The telemetry README documents the fork's delivery policy.
This is source validation; the integration branch is not installed on t480.

## Migration compatibility

The installed Vector fork owns migration names `0280` through `0287`. Upstream
independently used those numbers. Keep the Vector filenames, SQL contents and
timestamps; relocate the fourteen incoming upstream migrations to `0288`
through `0301`, preserving their SQL contents and timestamps. Existing history
continues to resolve by SQL checksum. Update source/test references to incoming
filenames and generate the combined `0301` schema snapshot with drizzle-kit.

The `vector-embedded` startup check remains read-only and fails closed when
migrations are pending. A future dev activation must use the explicit migration
path after reviewing the current dev overlay and database state. No migrations
were applied to t480 or rp5 by this task.

## Verification

- Frozen dependency install under Node 25.9.0 and pnpm 9.15.4.
- Full workspace typecheck, build and UI token gates.
- Complete UI/database suites: 7,356 passed.
- Final connector identity and gateway suites: 137 passed; after the final
  gateway repair, combined gateway/runtime/cloud-bypass/launcher suites: 167 passed.
- Merged engineering runtime/GitHub identity regressions: 32 passed.
- Full Pi adapter source suite: 196 passed, one skipped across 17 files.
- Serialized server suites: all 149 files passed, 2,763 tests, including the
  stopped-process recovery suite under the isolated editor environment below.
- All 286 pre-existing migration SQL files and journal entries unchanged.
- Focused compatibility tests: 472 passed after conflict repairs.
- Other workspace projects: 3,348 passed, 27 skipped across the original run
  and environment-isolated retries; shared 836 passed, skills catalog 20 passed.
- General server suite: 15,000 passed, two failures, 87 skipped on the broad
  run. Both failing files then passed unchanged in isolation: 17 tests. The
  clone fixture encountered the host Git URL rewrite described below; the
  load fixture observed 497 of 498 expected joins plus an `ECONNRESET`
  rejection during the broad run.
  Its isolated retry passed the original exact 500-response, two-scan and
  health-latency assertions. The broad command therefore exited nonzero; this
  handoff records the successful narrow retries rather than claiming it was green.
- Preservation coverage includes cloud bypass, GitHub installations/grants,
  credential bindings, tool authorization, stop/recovery, native safe
  replacement, embedded migration policy, schema drift and board prefix.
- Disposable database upgrade from the exact repair baseline: all fourteen
  upstream migrations applied; eleven idle/paused/terminated agent states,
  both GitHub grant identities, two credential ownership records and three
  connector configurations remained unchanged. There were no heartbeat runs.
  Startup refused the unmigrated schema without changing those records.

Live connector evidence belongs to the repair session and its dev overlay;
local compatibility tests do not prove that this updated branch is installed.
That session separately owns any user-authorized live agent proof.

## Cloud prohibition follow-up verification

- All 156 final Cloud policy, enrollment, signing/sealing, local broker relay,
  real HTTP redirect refusal, gateway, board authority and managed-skill
  boundary checks pass across thirteen server files.
- Thirteen compatibility suites pass: 443 checks cover both GitHub identities,
  launcher restrictions, rctl tool authority, local feedback, managed-instance
  security floors and stopped-process recovery. The subsequent retry merge is
  separately covered by the board authority integration checks above.
- Full workspace typecheck passes after all source merges.
- Shared suite: 853 pass, one fails. The unchanged worktree-lock fixture races
  its lease worker's initial timestamp refresh (`mtime` becomes fresh before
  the fixture can assert it is stale). Its isolated retry also fails. The exact
  two unmodified source/test files extracted from pre-change `164cd62da`
  reproduce the failure in a disposable directory. This is not a green whole
  shared suite; neither lock behavior nor its assertion was weakened here.
- The focused shared Cloud policy and telemetry tests pass: 62 checks.
- No live database, configuration, reporting line or agent state is changed
  by this source integration. Live repair-only test runs remain owned by the
  existing connector session.

## Final connector-session follow-up

The final parser repair changes only Pi terminal-response classification and
its tests. After importing it, all seventeen Pi source files pass: 198 checks
pass and one is skipped. The gateway, local-broker and Cloud-config suites pass
again: 62 checks across three files. Full workspace typecheck passes again.
The subsequent search repair passed full workspace typecheck. Its combined
gateway/local-broker/Cloud-config run passed 146 checks and failed one unchanged
resource-proxy fixture with a socket hang-up. The entire gateway file then
passed unchanged in isolation: all 85 checks, including connection-ID/action
search and no-match cases. No assertion or timeout was relaxed.
The preceding final stopped-process recovery run passed all 331 checks at
`800bdd06c`; the parser follow-up does not change heartbeat recovery logic.

## Local test environment

Use Node 25.9.0 and pnpm 9.15.4. The stable runner creates canonical temporary
paths and isolated Paperclip configuration. Direct Vitest retries used the same
canonical `TMPDIR` convention; macOS `/var` aliases otherwise fail worktree path
containment fixtures. No containment guard was relaxed.

`npx` injects `EDITOR=vi`; the strict diagnostic redactor intentionally treats
unknown inherited environment values as opaque credentials. Use
`EDITOR=paperclip-local-test-editor` for the diagnostic fixture so the token `vi`
does not redact the word `service`. The credential redactor is unchanged.

The clone fixture was rerun with `GIT_CONFIG_GLOBAL=/dev/null` and
`GIT_CONFIG_NOSYSTEM=1` because this host rewrites GitHub HTTPS URLs to SSH.
Those settings were scoped to that fixture; host configuration is unchanged.
Host credential-helper tests run with the normal Git environment.

## Delivery boundary

The initial authorization selected pushing only
`vector/engineering-upstream-20261001`. The owner subsequently requested
RD-451 and a linked, non-draft fork PR targeting `vector/main`, with work
stopped before merge. This source follow-up uses the RD key in its commit
without renaming the existing integration branch or rewriting its history.
`vector/main` and the canonical checkout remain at
`d554c4789ed3930f8a53ac9fdf6503b3187097da` for this task. There is no merge,
workflow dispatch, integration runtime installation or live migration. PR
creation is prepared pending the owner's decision about the inherited
`pull_request_target` review workflow, which ignores CI skip markers.

The connector session independently updated its repair-only t480 dev overlay.
Its autonomous coordinator proved distinct organization and personal GitHub
calls, DB profile discovery and a `SELECT 1` probe. At the source handoff it
was still completing its owner-authorized inventory/review run; this task
neither resumed nor cancelled that run. This is evidence for the repair overlay,
not live proof of the upstream integration branch.

Commands used for the local gates:

```sh
pnpm install --frozen-lockfile
pnpm -r typecheck
pnpm test:run
pnpm test:run:serialized --shard-index 0 --shard-count 2
pnpm test:run:serialized --shard-index 1 --shard-count 2
pnpm test:run:general --group general-workspaces-a
pnpm test:run:general --group general-workspaces-b
pnpm exec vitest run packages/adapters/pi-local/src --exclude '**/dist/**'
pnpm build
```

Interrupted groups were resumed from their failed file under the isolated test
environment above; targeted repair tests were rerun after each imported repair.
Hosted Cloud transport tests are replaced with prohibition checks; local broker
signing, sealing and ownership coverage remains. No authorization, containment,
migration or runtime stop guards or deployment gates were weakened.
