# Vector engineering upstream integration — 2026-10-01

This update is for the direct t480/FunkyDev engineering setup. It does not
activate a release, apply live database migrations, resume agents, or authorize
staging or production deployment. Publish this branch with CI skip markers;
no PR or workflow dispatch is part of this update.

## Sources and coordination

- Repository: `renegadesw/paperclip`.
- Engineering integration branch: `vector/engineering-upstream-20261001`.
- Connector repair baseline: `fix/personal-pat-run-credentials`,
  `cc8bf4f4c7536d77c251f5594975064342ab34bb`.
- Upstream default branch: `paperclipai/paperclip:master`,
  `41c18aa443fe791fa67b27eef28fd7239f5e9d5d`.
- Initial upstream merge: `67ebed8a5271713181b110a6f8c4fd5561b1deb9`;
  the final upstream advance updates Storybook only.
- Existing connector repair session: `01a0f617-4858-7ff3-a256-1cb557a7ad58`.
  Its clean, pushed repair commits are included as ancestors. Final identity
  naming repair: `0ea25a79a9b7adc6a7126d5333be47149b1481b3`; engineering
  startup identity repair: `33d0e70f1dc74f8974dd5f66e56e8a5b1a4d6314`; gateway
  discovery/selection repair: `41ea207955b58d40a643772cb14e1bda9d3fedbd`. Its installed dev
  overlay and the primary local checkout are not changed by this integration.

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

The user selected pushing only `vector/engineering-upstream-20261001`.
`vector/main` and the canonical checkout remain at
`d554c4789ed3930f8a53ac9fdf6503b3187097da` for this task. No PR, workflow
dispatch, merged-upstream dev installation or live migration is included.

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
No tests, protection checks, deployment gates or runtime stop guards were removed.
