---
name: marina-deploy
description: Build, deploy, inspect, and recover applications on Marina Cloud with the Marina CLI. Use when a user asks to publish a project to Marina, create a first Marina demo, check whether a Marina deployment is live, diagnose a failed or refused deploy, inspect versions, or roll an app back.
---

# Marina Deploy

Use the Marina CLI to deploy the user's project. Run commands with `--json` and
follow the returned result until the app is live.

## Deploy

1. Inspect the project and run its relevant local checks.
2. Install the CLI if needed: `npm install -g @marina-cloud/cli`.
3. If unauthenticated, run `marina setup` and let the user finish browser sign-in.
4. Run `marina deploy --json` from the project directory.
5. Return the live URL only when the result has `ok: true`, `state: "published"`,
   `live: true`, and a non-null `url`.

If it returns a failure or refusal, use the returned message and build log to
fix the project, verify it locally, and retry. Never bypass a refusal or
describe an unpublished or failed version as live.

Marina may recover an ambiguous or failed static build through its publishing
agent. Inspect the returned `preparation` report and `build_log`: the agent can
minimally repair and retry the build. Marina requires a successful build and
mechanically verified output before publication.

Static source detection is deterministic: a non-empty `scripts.build` wins
over root `index.html`; without a build script, root `index.html` is served
as-is. Deploy the project root and let Marina build it. A finished output
directory (for example, `marina deploy dist`) is refused when it belongs to a
project that declares a build; deploy that project's source instead.

Every accepted upload returns a `deploy_id`, including a first deploy refused
before an app exists. Inspect that durable attempt with:

```sh
marina deploys <deploy-id> --json
```

An archive or security refusal may have a null `build_log` because no build was
run; the refusal and action are still preserved on the deploy attempt.

## Edit an existing app

Use `marina checkout <dashboard-url-or-id> --dir <new-directory> --json` to get
the latest shared editable source. Source retrieval requires effective edit
access. Use the app's workspace when signing in. Checkout never replaces a
nonempty directory, installs dependencies, or runs scripts.

Keep the generated `.marina/project.json` identity and source baseline intact.
`marina pull --json` reconciles shared changes while preserving local edits.
When it reports conflicts, inspect its base/local/incoming paths, reconcile the
working files, and run `marina pull --continue --json`. A null side means deletion
or absence. Never manually advance `base_revision` to bypass a conflict.

Submit with `marina deploy --json`. Inspect `source_sync` too: if Marina prepared
different source, local reconciliation may need attention even though the deploy
succeeded. Proposed versions require publisher review. An update keeps the
existing app's URL, shares, and production data.

For a distinct app, use `marina copy <dashboard-url-or-id> --name <name>
--dir <new-directory> --json`. It requires edit access and creates a private,
unpublished copy of the live version. `--version <id>` stays pinned; `--editable`
explicitly copies shared editable source. It carries source and migrations, not
production rows, runtime objects, grants, credentials, schedules, or conversations.
Use a frontend project's own development command, or `marina dev` for a Marina
server entrypoint.

## Develop locally

Discover company data with `marina connections list --json` and inspect a
connection with `marina connections describe <connector/id> --json`. Use the
returned input schemas and declare only the read operations the app needs.
Personal connections resolve each viewer's own credential after deployment;
a viewer must connect their own account, and background jobs cannot use them.

`marina dev` runs the app on this machine with the production runtime
contract: local storage and an embedded Postgres (the app's
`marina/migrations` apply on start), while `marina.connections` calls bridge to
Marina under the signed-in user's dev-scoped grants. A denied bridged call names the missing grant — an
organization admin adds it from the connection's Dev access control. Use
`--port <port>` to change the listen port and `--schedules` to run scheduled
jobs locally. `marina.ai` bridges too; per-developer usage is metered.

For apps with `runtime.db: "v1"`, keep `marina dev` running and inspect its
database with `marina db tables --json`, `marina db schema <table> --json`, or
`marina db query '<sql>' --json`. Use `--dir <project>` from another directory,
`--params '<json-array>'` for parameters, and `--file <path>` for one SQL
statement from a file. Reads default to 100 rows; `--limit` permits up to 1000.
Use `--write` only for intended local data changes. Without `--app`, these
commands always inspect local data, including in a linked project.

For deployed data, explicitly pass `--app <slug-or-id>` to `db tables`,
`db schema <table>`, or `db query '<sql>'`. This uses the current Marina profile
and requires edit access to that app (owner, workspace admin, editor, or
publisher) and a read-scoped API key. Remote inspection is read-only; the
server fixes the app schema and retains credentials. Use unqualified table
names. Editors can inspect all app records, including viewer-filtered data.
`--params`, `--file`, and `--limit` also work remotely; `rowCount` counts returned
rows and `truncated` means more exist. Remote writes, migrations, and reset are
not supported. `--dir` and `--schema` are local options only.

New migrations apply on reload; `marina db migrations --json` shows their
status and `marina db migrate --json` applies them explicitly. Add new migration
files rather than changing applied ones. `marina db reset --yes` deletes local
database records and reapplies migrations, preserving local file storage.

## App keys for automation

When CI or another non-browser caller must call the app, declare scopes in
`marina.json` (`"access": { "scopes": { "builds:publish": "Publish builds" } }`,
which requires an `entrypoint`), deploy, then create a key:
`marina keys create --app <slug> --name <name> --scope <scope> --json`. The
secret is returned once; store it in the caller's secret store. Callers send
`Authorization: Bearer <key>`. The app receives `x-platform-principal: app-key`
and `x-platform-scopes`, and must check the scope for each endpoint. Keys
cannot deploy; list them with `marina keys --app <slug> --json` and revoke with
`marina keys revoke <key-id> --app <slug>`.

## Temporary links without sign-in

When a request without a browser session must reach one route (an iOS
installation manifest or IPA, an Apple profile service callback), declare
`"runtime": { "grants": "v1" }` and call
`marina.grants.create({ path, methods, expiresIn, maxBodyBytes })` from a
signed-in request. It returns `{ url, token, expiresAt }`; the link opens only
that exact path, with no other query parameters, for at most 15 minutes. A GET
link also answers HEAD and range requests. The app receives
`x-platform-principal: grant` and no user identity, and must still validate
what the link delivers.

## Large files

With `runtime.storage`, `marina.storage.get` returns at most 64 MiB in memory.
For larger objects use `getStream(key, { range })`, `head(key)`, and
`put(key, stream, { size, sha256 })` (streamed puts up to 1 GiB). Requests to
an app carry at most 100 MB of body and share 128 MB of memory, so upload big
artifacts in parts (for example 8 MiB, each with `sha256`) and serve them by
streaming the parts in order. `docs/runtime-storage.md` in the Marina repo
lists every limit.

## Create a demo

For a first demo, run `marina deploy demo --json`. This deploys the bundled
Hello Marina collage app directly. Treat it like any other deploy: return its
URL only after the result says it is published and live.

## Inspect or recover

```sh
marina status --app <slug> --json
marina deploys --app <slug> --json
marina deploys <deploy-id> --json
marina logs --app <slug>
marina versions --app <slug> --json
marina rollback --app <slug> --to <hash> --json
```

`marina logs` always returns structured JSON. Use it to inspect deployment
events, runtime invocations, console output, and exceptions. Follow
`next_cursor` when older entries are needed.

Identify the intended published version before rolling back, then confirm the
result with `marina status --json`.
