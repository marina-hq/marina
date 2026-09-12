import { resolve } from "node:path";
import { parseArgs } from "node:util";
import * as api from "./api.ts";
import { ApiError } from "./api.ts";
import {
  apiUrl,
  clearToken,
  getToken,
  profilePath,
  readLink,
  readProfile,
  resolveControlPlane,
  saveToken,
  writeLink,
} from "./config.ts";
import { DEMO_MANIFEST, packDemo } from "./demo.ts";
import { loginWithBrowser } from "./login.ts";
import {
  bold,
  createProgress,
  dim,
  failure,
  green,
  isJsonMode,
  note,
  red,
  result,
  say,
  setJsonMode,
  terminalSafeText,
} from "./output.ts";
import { buildOutputParent, pack } from "./pack.ts";
import { readManifest, resolveAppName } from "./manifest.ts";
import { installSkills } from "./skills.ts";
import { availableUpdate } from "./update.ts";

// Exit codes are part of the contract (agents read them):
//   0 ok · 1 error · 2 unauthenticated · 3 refused
const HELP = `${bold("marina")} — deploy internal apps

  marina setup                   sign in through Marina in your browser
      --skills                   install the Marina deployment skill
      --deploy-demo              deploy Hello Marina after signing in
  marina logout                  remove the saved credential
  marina profile                 show where this CLI is signed in
  marina skills install          install or update the Marina deployment skill
      --agent <agent>            codex, claude, or all (default: detected agents)
  marina deploy [dir]            zip the directory and deploy it
  marina deploy demo             deploy the bundled Hello Marina demo
      --name <name>              override marina.json, package.json, or directory name
      --app <slug>               deploy into an existing app
  marina status [--app <slug>]   what is live, and how the last deploy went
  marina deploys [--app <slug>]  recent deploy attempts, including refusals
  marina deploys <deploy-id>     inspect one attempt, even before an app exists
  marina logs [--app <slug>]     structured JSON runtime invocations, console output, and errors
      --level <level>            debug, info, log, warn, or error
      --limit <count>            1–200 entries (default: 100)
      --cursor <cursor>          continue from a prior result
  marina versions [--app <slug>] version history
  marina rollback [--to <hash>]  publish a previous version again
  marina dev [dir]               run this app locally against Marina
      --port <port>              listen port (default: 5990)
      --schedules                run scheduled jobs on their local timers
  marina ai models               models marina.ai can generate with, and who pays
  marina list                    apps in your workspace
  marina open                    open this project's app

  ${dim("--json  machine-readable result on stdout, progress on stderr")}`;
const ANSI_ESCAPE = new RegExp(`${String.fromCodePoint(27)}\\[[0-9;]*m`, "g");
let shouldCheckForUpdates = false;

/** Which app a command acts on: --app, else this directory's link. */
function targetApp(flag?: string): string {
  const linked = readLink(resolve("."))?.app;
  const app = flag ?? linked;
  if (!app) {
    failure("no_app", "no app here — pass --app <slug>, or deploy from a linked project");
    process.exit(1);
  }
  return app;
}

const shortDigest = (digest: string | null): string => digest?.slice(7, 14) ?? "—";

function deployAttemptHint(deployId: string, hasBuildLog: boolean): void {
  if (isJsonMode()) return;
  const command = `marina deploys ${terminalSafeText(deployId)} --json`;
  note(
    dim(
      `${hasBuildLog ? "build log omitted from terminal; " : ""}retrieve structured JSON with: ${command}`,
    ),
  );
}

interface DeployResult {
  command: "deploy";
  status: "succeeded";
  deploy_id: string;
  app: string;
  version: number | null;
  state: string | null;
  url: string | null;
  version_url: string | null;
  build_log: string | null;
  preparation: api.PreparationReport | null;
  live: boolean;
  demo: boolean;
}

async function deploy(
  dirArg: string | undefined,
  flags: { name?: string; app?: string },
  emitResult = true,
): Promise<DeployResult> {
  let dir: string | null = null;
  let link: ReturnType<typeof readLink> = null;
  let target: string | undefined;
  let name: string;
  let packed: ReturnType<typeof pack>;

  if (dirArg === "demo") {
    if (flags.app) {
      failure("invalid_input", "the demo creates a new app; do not pass --app");
      process.exit(1);
    }
    packed = packDemo();
    name = flags.name?.trim() || DEMO_MANIFEST.name;
  } else {
    dir = resolve(dirArg ?? ".");
    link = readLink(dir);
    target = flags.app ?? link?.app;
    const manifest = readManifest(dir);
    name = resolveAppName(dir, flags.name, manifest, link?.name);
    const builtFrom = buildOutputParent(dir);
    if (builtFrom) {
      const refusal = {
        code: "prebuilt_output",
        message: `${dir} looks like the build output of ${builtFrom}, not source.`,
        action: "Deploy the project root; Marina runs the build itself.",
      };
      failure("refused", refusal.message, { refusal });
      if (!isJsonMode()) note(`        ${terminalSafeText(refusal.action)}`);
      process.exit(3);
    }
    packed = pack(dir);
  }

  for (const secret of packed.skippedSecrets)
    say(dim(`skipped ${secret} — credential files are never deployed`));
  const progress = createProgress();
  const size = `${String(packed.fileCount)} files, ${String(Math.round(packed.totalBytes / 1024))} KB`;
  progress.update("uploading", `Uploading ${name} (${size})`);

  let started;
  try {
    started = await api.startDeploy(packed.zip, name, target, link?.base_revision);
  } catch (error) {
    progress.clear();
    // The linked app is gone (deleted, or a different Marina). Say so, since
    // "app not found" from a command with no app argument is a riddle.
    if (error instanceof ApiError && error.code === "not_found" && link) {
      failure(
        "link_stale",
        `this project is linked to "${link.app}", which no longer exists — delete .marina/project.json to deploy it as a new app`,
      );
      process.exit(1);
    }
    throw error;
  }
  const deployedAt = Date.now();
  let deployed: api.DeployStatus;
  try {
    deployed = await api.pollDeploy(started.id, (current) => {
      if (current.status !== "queued" && current.status !== "building") return;
      const elapsed = Math.max(1, Math.round((Date.now() - deployedAt) / 1000));
      const message = current.build_message
        ? `${terminalSafeText(current.build_message)} (${String(elapsed)}s)`
        : current.status === "queued"
          ? `Waiting for a deploy worker (${String(elapsed)}s)`
          : `Building and verifying (${String(elapsed)}s)`;
      progress.update(current.status, message);
    });
  } finally {
    progress.clear();
  }

  if (deployed.status === "refused" && deployed.refusal) {
    failure("refused", deployed.refusal.message, {
      deploy_id: deployed.id,
      refusal: deployed.refusal,
      build_log: deployed.build_log,
      build_phase: deployed.build_phase,
      build_message: deployed.build_message,
    });
    if (!isJsonMode() && deployed.refusal.action) {
      note(`        ${terminalSafeText(deployed.refusal.action)}`);
    }
    deployAttemptHint(deployed.id, deployed.build_log !== null);
    process.exit(3);
  }
  if (deployed.status === "failed") {
    failure("failed", deployed.error ?? "unknown error", {
      deploy_id: deployed.id,
      build_log: deployed.build_log,
      build_phase: deployed.build_phase,
      build_message: deployed.build_message,
    });
    deployAttemptHint(deployed.id, deployed.build_log !== null);
    process.exit(1);
  }

  // Write the manifest back so the next deploy needs no flags at all.
  const slug = deployed.app_slug ?? "";
  if (
    dir &&
    (!link ||
      link.app !== slug ||
      link.name !== name ||
      link.base_revision !== (deployed.source_revision ?? undefined))
  ) {
    writeLink(dir, {
      app: slug,
      name,
      ...(deployed.source_revision ? { base_revision: deployed.source_revision } : {}),
    });
  }

  const published = deployed.version_state === "published";
  say(
    `${green("ok")} ${bold(name)} v${String(deployed.version_number ?? "?")} ${
      published ? green("live") : `${deployed.version_state ?? ""} — awaiting review`
    }`,
  );

  // If Marina had to change the source to make it build, say so plainly and
  // itemise it — that's the whole reason the version waits for a human.
  const prep = deployed.preparation;
  if (prep && prep.transformation !== "none") {
    say(`   ${bold("Marina prepared this project:")} ${prep.summary}`);
    for (const change of prep.changes)
      say(`     ${dim("changed")} ${change.path} — ${change.summary}`);
    for (const limitation of prep.limitations) say(`     ${red("note")} ${limitation}`);
  }
  if (published) {
    if (deployed.url) say(`   ${deployed.url}`);
  } else {
    if (deployed.version_url) say(`   try this version: ${deployed.version_url}`);
    say(dim("   a publisher can approve it from the Marina inbox"));
  }
  const payload: DeployResult = {
    command: "deploy",
    status: "succeeded",
    deploy_id: deployed.id,
    app: slug,
    version: deployed.version_number,
    state: deployed.version_state,
    url: deployed.url,
    version_url: deployed.version_url,
    build_log: deployed.build_log,
    preparation: deployed.preparation,
    live: published,
    demo: dirArg === "demo",
  };
  if (emitResult) result(payload);
  return payload;
}

async function status(appFlag?: string) {
  const app = targetApp(appFlag);
  const [detail, history] = await Promise.all([api.getApp(app), api.listDeploys(app, 1)]);
  const last = history[0];

  say(`${bold(detail.app.name)} ${dim(`(${detail.app.slug})`)}`);
  say(`  ${detail.app.current_version_id ? green(detail.app.status) : dim("nothing published")}`);
  if (detail.app.current_version_id) say(`  ${detail.url}`);
  if (detail.app.archived_at) say(`  ${red("archived")} — it isn't serving`);
  if (last) {
    const outcome =
      last.status === "succeeded"
        ? green("succeeded")
        : last.status === "queued" || last.status === "building"
          ? last.status
          : red(last.status);
    const version = last.version_number == null ? "" : ` v${String(last.version_number)}`;
    say(`  last deploy: ${outcome}${version}${last.refusal ? ` — ${last.refusal.message}` : ""}`);
  }
  result({
    command: "status",
    app: detail.app.slug,
    name: detail.app.name,
    status: detail.app.status,
    live: detail.app.current_version_id !== null,
    archived: detail.app.archived_at !== null,
    url: detail.url,
    last_deploy: last ?? null,
  });
}

function deployOutcome(attempt: Pick<api.DeployStatus, "status" | "refusal" | "error">): string {
  return attempt.refusal?.message ?? attempt.error ?? attempt.status;
}

async function deploys(appFlag?: string, deployId?: string) {
  if (deployId) {
    const attempt = await api.getDeploy(deployId);
    const mark = attempt.status === "succeeded" ? green("ok") : red(attempt.status);
    say(`${mark} ${dim(attempt.id)} — ${terminalSafeText(deployOutcome(attempt))}`);
    if (attempt.build_log) deployAttemptHint(attempt.id, true);
    result({ command: "deploys.show", deploy: attempt });
    return;
  }
  const app = targetApp(appFlag);
  const rows = await api.listDeploys(app);
  if (rows.length === 0) say("no deploys yet");
  for (const row of rows) {
    const mark = row.status === "succeeded" ? green("ok") : red(row.status);
    const why = row.refusal
      ? ` — ${terminalSafeText(row.refusal.message)}`
      : row.error
        ? ` — ${terminalSafeText(row.error)}`
        : "";
    const version = row.version_number == null ? "" : ` v${String(row.version_number)}`;
    say(`${mark}${version}  ${dim(row.created_at)} ${dim(`via ${row.source}`)}${why}`);
  }
  const failedWithLog = rows.find((row) => row.status !== "succeeded" && row.build_log);
  if (failedWithLog) deployAttemptHint(failedWithLog.id, true);
  result({ command: "deploys", app, deploys: rows });
}

const LOG_LEVELS = new Set<api.RuntimeLogLevel>(["debug", "info", "log", "warn", "error"]);

async function logs(
  appFlag: string | undefined,
  flags: { level?: string; limit?: string; cursor?: string },
) {
  const app = targetApp(appFlag);
  const parsedLimit = flags.limit === undefined ? 100 : Number(flags.limit);
  if (!Number.isInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > 200) {
    failure("invalid_input", "--limit must be an integer from 1 to 200");
    process.exit(1);
  }
  if (flags.level && !LOG_LEVELS.has(flags.level as api.RuntimeLogLevel)) {
    failure("invalid_input", "--level must be debug, info, log, warn, or error");
    process.exit(1);
  }

  const response = await api.listRuntimeLogs(app, {
    limit: parsedLimit,
    cursor: flags.cursor,
    level: flags.level as api.RuntimeLogLevel | undefined,
  });
  result({
    command: "logs",
    app,
    logs: response.logs,
    next_cursor: response.nextCursor,
  });
}

async function versions(appFlag?: string) {
  const app = targetApp(appFlag);
  const [rows, detail] = await Promise.all([api.listVersions(app), api.getApp(app)]);
  for (const version of rows) {
    const current = version.id === detail.app.current_version_id;
    say(
      `${current ? green("current") : dim(shortDigest(version.artifact_digest))}  v${String(version.number)}  ${version.title} ${dim(version.state)}`,
    );
  }
  result({
    command: "versions",
    app,
    current_version_id: detail.app.current_version_id,
    versions: rows,
  });
}

/** Roll back by shipping an old version again — history is never rewritten. */
async function rollback(appFlag: string | undefined, to: string | undefined) {
  const app = targetApp(appFlag);
  const [rows, detail] = await Promise.all([api.listVersions(app), api.getApp(app)]);
  const published = rows.filter((v) => v.state === "published");

  const target = to
    ? published.find((v) => shortDigest(v.artifact_digest) === to || v.artifact_digest === to)
    : published.find((v) => v.id !== detail.app.current_version_id);

  if (!target) {
    failure(
      "not_found",
      to ? `no published version matching ${to}` : "no earlier published version to roll back to",
    );
    process.exit(1);
  }

  const shipped = await api.restoreVersion(target.id);
  say(
    `${green("ok")} rolled back to ${shortDigest(target.artifact_digest)} — shipped as v${String(shipped.number)}`,
  );
  say(`   ${detail.url}`);
  result({
    command: "rollback",
    app,
    restored_from: target.artifact_digest,
    version: shipped.number,
    url: detail.url,
  });
}

async function main() {
  // Parse failures happen before values.json is available. Detect this one
  // universal flag up front so even a typo still returns machine JSON.
  setJsonMode(process.argv.slice(2).includes("--json"));
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      name: { type: "string" },
      app: { type: "string" },
      to: { type: "string" },
      level: { type: "string" },
      limit: { type: "string" },
      cursor: { type: "string" },
      agent: { type: "string" },
      port: { type: "string" },
      schedules: { type: "boolean" },
      dir: { type: "string" },
      skills: { type: "boolean" },
      "deploy-demo": { type: "boolean" },
      json: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  const command = positionals[0];
  // Runtime log bodies have no human renderer. Their command always returns a
  // single structured document, even when --json was omitted.
  setJsonMode(values.json === true || command === "logs");

  if (values.help || !command) {
    say(HELP);
    result({ command: "help", usage: HELP.replaceAll(ANSI_ESCAPE, "") });
    return;
  }
  await resolveControlPlane();
  shouldCheckForUpdates = true;

  switch (command) {
    case "setup":
    case "login": {
      if (!process.env.MARINA_TOKEN) {
        let lastReportedRemaining = -1;
        const signedIn = await loginWithBrowser(
          (url) => {
            say("Opening your browser to sign in…");
            say(dim(url));
          },
          (progress) => {
            if (progress.phase === "waiting") {
              const remainingSeconds = Math.ceil(progress.remainingMs / 1000);
              if (lastReportedRemaining < 0) {
                say(
                  dim(
                    `Waiting for browser authorization (${String(Math.ceil(remainingSeconds / 60))} minute timeout)…`,
                  ),
                );
                lastReportedRemaining = remainingSeconds;
              } else if (remainingSeconds <= lastReportedRemaining - 15) {
                const minutes = Math.floor(remainingSeconds / 60);
                const seconds = String(remainingSeconds % 60).padStart(2, "0");
                say(dim(`Still waiting… ${String(minutes)}:${seconds} remaining`));
                lastReportedRemaining = remainingSeconds;
              }
            } else if (progress.phase === "received") {
              say(dim("Authorization received. Completing sign-in…"));
            }
          },
        );
        saveToken(signedIn.token);
      }
      say(`${green("ok")} signed in ${dim(`(${apiUrl()})`)}`);
      const installed = values.skills ? installSkills(values.agent) : undefined;
      for (const skill of installed ?? []) {
        say(`${green("ok")} ${skill.status} Marina skill for ${skill.agent} ${dim(skill.path)}`);
      }
      const demo = values["deploy-demo"]
        ? await deploy("demo", { name: values.name }, false)
        : undefined;
      result({
        command: "setup",
        signed_in: true,
        api: apiUrl(),
        profile: profilePath(),
        ...(installed ? { skills: installed } : {}),
        ...(demo ? { deploy: demo } : {}),
      });
      return;
    }
    case "logout": {
      clearToken();
      const environmentToken = Boolean(process.env.MARINA_TOKEN);
      say(
        environmentToken
          ? `${green("ok")} profile credential removed; MARINA_TOKEN is still set`
          : `${green("ok")} signed out`,
      );
      result({
        command: "logout",
        signed_in: environmentToken,
        profile: profilePath(),
        environment_token: environmentToken,
      });
      return;
    }
    case "dev": {
      const { runDev } = await import("./dev/index.ts");
      try {
        await runDev({
          dir: values.dir ?? positionals[1],
          port: values.port,
          schedules: values.schedules === true,
        });
      } catch (error) {
        failure("dev_failed", (error as Error).message);
        process.exitCode = 1;
      }
      return;
    }
    case "profile": {
      const profile = readProfile();
      const source = process.env.MARINA_TOKEN ? "environment" : profile.token ? "profile" : null;
      say(`${getToken() ? green("signed in") : dim("signed out")} ${dim(`(${apiUrl()})`)}`);
      say(dim(profilePath()));
      result({
        command: "profile",
        signed_in: getToken() !== null,
        source,
        api: apiUrl(),
        profile: profilePath(),
      });
      return;
    }
    case "skills": {
      if (positionals[1] !== "install") {
        failure("invalid_input", "usage: marina skills install [--agent codex|claude|all]");
        process.exit(1);
      }
      const installed = installSkills(values.agent);
      for (const skill of installed) {
        say(`${green("ok")} ${skill.status} Marina skill for ${skill.agent} ${dim(skill.path)}`);
      }
      result({ command: "skills.install", skills: installed });
      return;
    }
    case "ai": {
      if (positionals[1] !== "models") {
        failure("invalid_input", "usage: marina ai models");
        process.exit(1);
      }
      const view = await api.aiModels();
      say(`${bold("fast")}   ${view.aliases.fast ?? dim("(broker unreachable)")}`);
      say(`${bold("smart")}  ${view.aliases.smart ?? dim("(broker unreachable)")}`);
      if (view.models.length === 0) {
        say(dim("no library models offered on this deployment"));
      }
      for (const model of view.models) say(`  ${model}`);
      const billing =
        view.billing === "workspace"
          ? "generations bill this workspace's OpenRouter account (BYOK)"
          : view.billing === "platform"
            ? "generations bill Marina's platform key — connect OpenRouter to use your own"
            : "no AI billing key: connect OpenRouter in Settings → Connections";
      say(dim(billing));
      result({ command: "ai.models", ...view });
      return;
    }
    case "deploy":
      await deploy(positionals[1], values);
      return;
    case "status":
      await status(values.app);
      return;
    case "deploys":
    case "deployments":
      await deploys(values.app, positionals[1]);
      return;
    case "logs":
      await logs(values.app, values);
      return;
    case "versions":
      await versions(values.app);
      return;
    case "rollback":
      await rollback(values.app, values.to);
      return;
    case "list": {
      const apps = await api.listApps();
      if (apps.length === 0) say("no apps yet — `marina deploy` one");
      for (const app of apps) {
        say(
          `${app.emoji}  ${bold(app.name)} ${dim(`(${app.slug})`)} ${app.status}${app.version === null ? "" : dim(` v${String(app.version)}`)}  ${dim(app.url)}`,
        );
      }
      result({ command: "list", apps });
      return;
    }
    case "open": {
      const app = targetApp(values.app);
      // The real address; the gateway's auth handshake handles sign-in.
      const url = await api.getAppUrl(app);
      if (!isJsonMode()) {
        const { spawn } = await import("node:child_process");
        spawn(process.platform === "darwin" ? "open" : "xdg-open", [url], { detached: true });
      }
      say(url);
      result({ command: "open", app, url });
      return;
    }
    default:
      failure("unknown_command", `unknown command: ${command}`);
      if (!isJsonMode()) say(HELP);
      process.exit(1);
  }
}

async function run(): Promise<void> {
  await main();
  if (!shouldCheckForUpdates) return;
  const update = await availableUpdate();
  if (update) {
    const detail = `Marina CLI ${update.latest} is available (current ${update.current}) — ${update.command}`;
    note(isJsonMode() ? detail : `${bold("Update available:")} ${detail}`);
  }
}

run().catch((error: unknown) => {
  if (error instanceof ApiError) {
    failure(error.code, error.message);
    process.exit(error.status === 401 ? 2 : error.code === "invalid_input" ? 3 : 1);
  }
  failure("error", (error as Error).message);
  process.exit(1);
});
