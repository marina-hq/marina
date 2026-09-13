# Marina Cloud CLI

Deploy small internal apps to Marina Cloud.

Source code and Marina's deployment skill live in the
[marina-hq/marina](https://github.com/marina-hq/marina) repository.

```sh
npm install -g @marina-cloud/cli
marina setup
marina deploy
```

For a complete first run, including the deployment skill and demo app:

```sh
npm install -g @marina-cloud/cli && marina setup --skills --deploy-demo --json
```

`marina setup` opens Marina in the browser and delivers the resulting API key
directly back to the CLI. For unattended environments, `MARINA_TOKEN` is the
process-only credential override.

The saved credential lives in `~/.marina/profile` with user-only permissions.
Use `marina profile` to inspect the active profile and `marina logout` to remove
its credential.

Install Marina deployment skills with:

```sh
marina skills install
marina skills install --agent codex
```

The CLI reads release metadata from Marina's control plane and prints an
advisory update command at most once per day when a newer release is available.
It never updates itself.

## Agent-friendly output

Every command accepts `--json`. Standard output contains exactly one versioned
JSON result; progress stays on standard error.

```sh
marina list --json
marina status --app my-tool --json
marina logs --app my-tool
marina deploy --json
```

Successful results have `schema_version: 1` and `ok: true`. Failures have
`ok: false` and a stable `error.code`; exit codes distinguish errors,
authentication failures, and deployment refusals.

`marina logs` always returns one structured JSON document, even without
`--json`; log bodies are never rendered as terminal text. It includes recent
deployment events, runtime invocations, console output, and exceptions. Use
`--level`, `--limit`, and `next_cursor` to filter or continue through older
entries. Build-log bodies are likewise omitted from human deploy output and
remain available in `deploy --json` and `deploys --json` results.

## Deploy a first demo

`marina deploy demo --json` deploys the bundled, interactive Hello Marina
cut-paper collage as a new app. Pass `--name` to override its name.

To deploy a real directory literally named `demo`, pass `./demo`.

## Develop and inspect local data

Discover available company connections and the operations they support:

```sh
marina connections list --json
marina connections describe postgres/orders --json
```

Discovery includes active connections you have Dev access to and personal
connections you can connect yourself. It returns operation input schemas and
a manifest example, without provider configuration or credentials. Keep only
the operations your app uses in its manifest.

Run `marina dev` in an app with a server entrypoint. Apps declaring
`runtime.db: "v1"` get embedded Postgres in `.marina/dev/db`, without Docker.
Keep development running and use a second terminal or your agent:

```sh
marina db tables --json
marina db schema annotations --json
marina db query 'select * from annotations' --limit 20 --json
marina db query 'select * from annotations where user_id = $1' --params '["example-user"]' --json
marina db migrations --json
marina db migrate --json
```

Use `--dir <project>` from another directory. These commands contact only that
project's running local development process and require no cloud connection.
Queries are read-only by default; use `--write` for intentional local changes.
`--file <path>` reads one SQL statement from a file, including a seed INSERT.
Inspection fetches at most `--limit` plus one rows from Postgres and returns at
most `--limit` rows (default 100, maximum 1000). `truncated` indicates more rows
are available. `rowCount` counts returned rows, or affected rows for a write
without `RETURNING`. SQL has a ten-second execution timeout.

New migrations apply when the app reloads; `marina db migrate` also applies
them explicitly. Reload validates the replacement app before starting migrations.
If a migration batch fails, the app pauses until a successful reload so the old
build cannot keep serving against a partially changed schema. Add new numbered
files rather than editing applied migrations.
To recreate just the local database and reapply migrations, use
`marina db reset --yes`. This removes local database records and preserves local
file storage. Keep `.marina/` out of source control.

## Inspect a deployed app's database

Pass an explicit `--app` slug or ID to inspect its live, app-owned database:

```sh
marina db tables --app my-tool --json
marina db schema annotations --app my-tool --json
marina db query 'select * from annotations where user_id = $1' --params '["example-user"]' --limit 20 --app my-tool --json
```

You need edit access to that app: its owner, a workspace admin, or an editor
or publisher share. View-only access is insufficient. Authorization is checked
on every request, and your API key must include the `read` permission.

Remote inspection is read-only and scoped to the selected app's database.
Use unqualified table names; Marina selects the app schema and keeps database
credentials on the server. Editors can inspect all records stored by the app,
including records its UI restricts to particular viewers. This does not grant
access to other apps or company data connectors.

Queries accept `--file`, `--params`, and `--limit` and have a ten-second execution
timeout. `rowCount` is the number of returned rows; `truncated` indicates more
are available. Results are bounded to 1000 rows and five MiB, with a two-MiB
per-row guard. Inspection records the actor and app in the audit trail without
SQL, parameters, or result data.

`--app` uses the signed-in Marina profile and returns `environment: production`
for the deployed app database. Without `--app`, commands always stay local,
even in a linked project. `--dir` and `--schema` are local options. Writes,
migration commands, and reset are local only; deploy new migrations through
the normal version review and publishing workflow.

## App manifest

Add `marina.json` at the project root to give the app a portable name and icon:

```json
{
  "schema": 1,
  "name": "My App",
  "icon": "⛵"
}
```

For names, the CLI uses `--name`, then `marina.json`, then `package.json`, then
the directory name. `.marina/project.json` only links the directory to an app
after its first deploy; do not commit it.

Run `marina deploy .` from a project root by default. A non-empty
`package.json` `scripts.build` makes Marina install dependencies, run
`npm run build`, and publish the generated output—even when the source project
also has root `index.html`. A package without a build script can still deploy
as-is when root `index.html` exists. Build output must contain `index.html` in
`dist`, `build`, `out`, `public`, or `.output/public`.

Deploy source, not build output. `marina deploy dist` is refused with exit
code 3 when the target is the build output of a project that declares a build;
deploy the project root instead, and Marina runs the build itself. The server
likewise refuses uploads that are recognizably build output.

When a declared build fails, Marina can ask its publishing agent to retry or
minimally repair the build; there is no path that publishes existing output
instead of building.
