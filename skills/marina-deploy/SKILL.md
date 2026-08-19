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

## Create a demo

For a first demo, run `marina deploy demo --json`. This deploys the bundled
Hello Marina collage app directly. Treat it like any other deploy: return its
URL only after the result says it is published and live.

## Inspect or recover

```sh
marina status --app <slug> --json
marina deploys --app <slug> --json
marina versions --app <slug> --json
marina rollback --app <slug> --to <hash> --json
```

Identify the intended published version before rolling back, then confirm the
result with `marina status --json`.
