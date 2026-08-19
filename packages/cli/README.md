# Marina Cloud CLI

Deploy small internal apps to Marina Cloud.

Source code and Marina's deployment skill live in the
[marina-hq/marina](https://github.com/marina-hq/marina) repository.

```sh
npm install -g @marina-cloud/cli
marina setup
marina deploy
```

`marina setup` opens Clerk in the browser and delivers the resulting API key
directly back to the CLI. For unattended environments, `MARINA_TOKEN` or
`marina setup --token mar_…` is the explicit fallback.

The saved credential lives in `~/.marina/profile` with user-only permissions.
Use `marina profile` to inspect the active profile and `marina logout` to remove
its credential.

Install Marina deployment skills with:

```sh
marina skills install
marina skills install --agent codex
```

The CLI checks npm at most once per day and prints an advisory update command
when a newer release is available. It never updates itself.

## Agent-friendly output

Every command accepts `--json`. Standard output contains exactly one versioned
JSON result; progress stays on standard error.

```sh
marina list --json
marina status --app my-tool --json
marina deploy --json
```

Successful results have `schema_version: 1` and `ok: true`. Failures have
`ok: false` and a stable `error.code`; exit codes distinguish errors,
authentication failures, and deployment refusals.

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
  "icon": "⛵",
  "type": "static"
}
```

For names, the CLI uses `--name`, then `marina.json`, then `package.json`, then
the directory name. `.marina/project.json` only links the directory to an app
after its first deploy; do not commit it.
