# Local rctl database connection

The Vector engineering profile uses one agent tool path: assigned Paperclip
connections. GitHub and Jira use the existing Vector connector broker. Database
work uses an approved local-stdio template for rctl. Agents do not use a second
rctl CLI or shell GitHub credential path.

The rctl database server exposes `db_profiles`, `db_query`, `db_schema`, `db_exec`,
`db_exec_file`, and `db_copy`. It retains rctl profile permissions, statement
limits, transactions, streaming copy, and dry-run support. The database server
excludes shell, filesystem, credential-management, and unrelated provider tools.
SQL files must exist at an absolute path on the trusted execution host.

Use rctl commit `e0712cd18eb4856e54cae96b2b79524bdf1b507d` or a compatible
release. Register an approved template with `/usr/bin/env` and these arguments:

```text
PATH=/home/funkydev/.local/bin:/usr/local/bin:/usr/bin:/bin
HOME=/home/funkydev
USER=funkydev
LOGNAME=funkydev
XDG_CONFIG_HOME=/home/funkydev/.config
/home/funkydev/.local/bin/rctl
--database-stdio
```

These paths are specific to the engineering host. Use the actual runtime user's
paths on another host. Set them in the approved template instead of inheriting
all environment variables. rctl's script launcher needs `uv` on this PATH.

Create a `local_stdio` connection that references the approved template. Its
`authKind` is `none`: credentials remain in the trusted host's existing rctl
profile store. This does not create a public unauthenticated database endpoint.
Paperclip controls agent assignments, enabled tools, approval policy, and call
audit. Review the six catalog entries through the normal Apps finish API.

Check actual agent-scoped calls to `db_profiles` and a constant-only
`db_query` before reporting access as verified. Listing tools or passing a
connector health check does not prove a database query works. Verify writes
with temporary objects on a test profile; do not mutate production to test setup.

The engineering profile retains native local editing, build, and test tools.
Their shell environment denies direct `git`, `gh`, and `rctl` command names.
These wrappers guide tool routing; they do not provide an operating-system
sandbox against arbitrary executable paths.
