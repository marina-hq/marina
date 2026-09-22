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

## Edit or copy an existing app

```sh
marina checkout https://marina.cloud/acme/apps/orders --dir orders --json
cd orders
marina pull --json
marina deploy --json
```

Checkout requires edit access, including owner, administrator, editor, or
publisher access. It downloads the latest shared editable source into a new or
empty folder, without running installation scripts. The folder is bound to that
app and workspace, so switching your CLI profile cannot redirect a deployment.
Private Studio drafts are not included. Frontend apps use their own development
command; apps with a Marina server entrypoint use `marina dev`.

`marina pull` preserves local changes and merges independent file changes.
If both sides changed a file, its base, local, and incoming contents are retained
under `.marina/source/pending`. Reconcile the working files, then run
`marina pull --continue --json`. A null conflict side means the file was absent.
Deployment is blocked until reconciliation finishes. Keep `.marina` local and
never rewrite `base_revision` to bypass a stale-source refusal.

A successful deploy fetches the canonical source Marina prepared, preserving
edits made during the build. Check `source_sync` in the result; source conflicts
can still need attention after the deployment itself succeeds. Publisher review
continues to determine when a proposed version goes live.

To create a separate private, unpublished app in the same workspace:

```sh
marina copy https://marina.cloud/acme/apps/orders --name "Regional orders" --dir regional-orders --json
```

Copying also requires edit access. It defaults to the live version; `--version
<id>` pins a specific version, and `--editable` explicitly selects shared editable
source. Source and migrations are copied. Production data, runtime storage,
shares, credentials, private conversations, and active jobs are not inherited.
Company connection declarations require authorization for the new app.

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

## Use managed secrets and outbound HTTPS

Declare the secret names an app may read and the HTTPS hosts it may call in
`marina.json`:

```json
{
  "schema": 1,
  "entrypoint": "src/worker.ts",
  "runtime": { "secrets": ["PAYMENTS_API_KEY"] },
  "egress": { "hosts": ["api.payments.example"] }
}
```

Set and rotate values without placing them in source or deployment archives:

```sh
printf %s "$PAYMENTS_API_KEY" | marina secrets set PAYMENTS_API_KEY --app my-tool
marina secrets --app my-tool --json
marina secrets delete PAYMENTS_API_KEY --app my-tool
```

`marina secrets set` also accepts `--file <path>`. Listing returns names and
update times, never values. Dynamic app code reads a declared value through
`await marina.secrets.get("PAYMENTS_API_KEY")`; a missing value returns `null`.
Local `marina dev` can read it when the linked app's live version declares the
same name and the signed-in developer has edit access.

Outbound calls use the standard Web `fetch()` API. `egress.hosts` is deny by
default: omit it or use `[]` for no network access, list hostnames to allow them
and their subdomains, or use `["*"]` to allow public HTTPS destinations. HTTP,
private networks, and Marina endpoints remain blocked. Marina records the
destination hostname, method, status, and outcome in runtime logs without URL
paths, queries, headers, bodies, or secret values.

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

## Give automation access with app keys

An app key lets CI or another non-browser caller call one app with scopes the
app declares. Declare them in `marina.json`, then deploy:

```json
{
  "schema": 1,
  "entrypoint": "src/worker.ts",
  "access": {
    "scopes": {
      "builds:read": "Read the previous successful build",
      "builds:publish": "Upload artifacts and publish builds"
    }
  }
}
```

A workspace admin or the app's creator manages its keys:

```sh
marina keys create --app my-tool --name "GitHub Actions" --scope builds:read --scope builds:publish --json
marina keys --app my-tool --json
marina keys revoke <key-id> --app my-tool
```

`create` returns the secret once; store it in the caller's secret store.
`--expires-days <1-365>` sets an optional lifetime. Callers send
`Authorization: Bearer <key>` to the app's address. The app receives
`x-platform-principal: app-key` and the key's scopes in `x-platform-scopes`, and
checks the scope each endpoint needs. A key cannot open other apps or deploy,
and a revoked key stops working within 30 seconds.

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
