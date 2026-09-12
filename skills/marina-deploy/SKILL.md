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

## Develop locally

`marina dev` runs the app on this machine with the production runtime
contract: local storage and an embedded Postgres (the app's
`marina/migrations` apply on start), while `marina.capabilities` and
`marina.connections` calls bridge to Marina under the signed-in user's
dev-scoped grants. A denied bridged call names the missing grant — an
organization admin adds it from the connection's Dev access control. Use
`--port <port>` to change the listen port and `--schedules` to run scheduled
jobs locally. `marina.ai` bridges too; per-developer usage is metered.

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
