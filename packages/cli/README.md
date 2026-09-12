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
