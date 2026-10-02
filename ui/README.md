# @paperclipai/ui

Published static assets for the Paperclip board UI.

## What gets published

The npm package contains the production build under `dist/`. It does not ship the UI source tree or workspace-only dependencies.

## Storybook

Storybook config, stories, and fixtures live under `ui/storybook/`.

```sh
pnpm --filter @paperclipai/ui storybook
pnpm --filter @paperclipai/ui build-storybook
```

## Typical use

Install the package, then serve or copy the built files from `node_modules/@paperclipai/ui/dist`.

## Mounting below the origin root

`PAPERCLIP_UI_BASE_PATH` is a build-time setting for serving the board below a
same-origin path prefix. It must be an absolute URL path; origins, query
strings, fragments, and dot segments are rejected. The default remains `/`.

```sh
PAPERCLIP_UI_BASE_PATH=/__paperclip/ pnpm --filter @paperclipai/ui build
```

The resulting artifact keeps history routes, API calls, WebSockets, service
worker scope, plugin UI resources, and static assets below that prefix. The
HTTP reverse proxy must remove the prefix before forwarding to Paperclip's
root-mounted server routes and must return the SPA index for deep-link paths.
## Editor dependency identity

Keep the root and workspace overrides for `@codemirror/state`,
`@codemirror/view`, and `@lezer/common` aligned. CodeMirror requires shared
extension identity, while Lezer parsers and syntax highlighters require shared
`NodeProp` IDs. Multiple Lezer copies can crash code-block highlighting with
`tags is not iterable`. `src/lib/codemirror-single-instance.test.ts` checks the
installed dependency graph and highlights sample code through the editor's real
language dependencies. GitHub Actions owns regeneration of `pnpm-lock.yaml`.
