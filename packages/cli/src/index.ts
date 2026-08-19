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
  saveToken,
  writeLink,
} from "./config.ts";
import { DEMO_MANIFEST, packDemo } from "./demo.ts";
import { loginWithBrowser } from "./login.ts";
import {
  bold,
  dim,
  failure,
  green,
  isJsonMode,
  note,
  red,
  result,
  say,
  setJsonMode,
} from "./output.ts";
import { pack } from "./pack.ts";
import { readManifest, resolveAppName } from "./manifest.ts";
import { autoInstallSkills, installSkills } from "./skills.ts";
import { availableUpdate } from "./update.ts";

// Exit codes are part of the contract (agents read them):
//   0 ok · 1 error · 2 unauthenticated · 3 refused
const HELP = `${bold("marina")} — deploy internal apps

  marina setup                   sign in with Clerk in your browser
      --token mar_…              save an existing API key (headless fallback)
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
  marina versions [--app <slug>] version history
  marina rollback [--to <hash>]  publish a previous version again
  marina secrets                 list env vars and secrets for the app
  marina secrets set K=V         set one (--plain for a non-secret var)
  marina secrets rm K            remove one
  marina list                    apps in your workspace
  marina open                    open this project's app

  ${dim("--json  machine-readable result on stdout, progress on stderr")}
  ${dim(`API: ${apiUrl()} (override with MARINA_API)`)}`;
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

async function deploy(dirArg: string | undefined, flags: { name?: string; app?: string }) {
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
    packed = pack(dir);
  }

  for (const secret of packed.skippedSecrets) say(dim(`skipped ${secret} — secrets stay local`));
  say(
    `uploading ${bold(name)} ${dim(`(${String(packed.fileCount)} files, ${String(Math.round(packed.totalBytes / 1024))} KB)`)}`,
  );

  let started;
  try {
    started = await api.startDeploy(packed.zip, name, target);
  } catch (error) {
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
  const deployed = await api.pollDeploy(started.id);

  if (deployed.status === "refused" && deployed.refusal) {
    say(`${red("refused")} ${deployed.refusal.message}`);
    if (deployed.refusal.action) say(`        ${deployed.refusal.action}`);
    if (deployed.build_log) {
      say(dim("---- build log (tail) ----"));
      say(dim(deployed.build_log.split("\n").slice(-20).join("\n")));
    }
    failure("refused", deployed.refusal.message, {
      refusal: deployed.refusal,
      build_log: deployed.build_log,
    });
    process.exit(3);
  }
  if (deployed.status === "failed") {
    failure("failed", deployed.error ?? "unknown error");
    process.exit(1);
  }

  // Write the manifest back so the next deploy needs no flags at all.
  const slug = deployed.app_slug ?? "";
  if (dir && (!link || link.app !== slug || link.name !== name)) {
    writeLink(dir, { app: slug, name });
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
  result({
    command: "deploy",
    status: "succeeded",
    app: slug,
    version: deployed.version_number,
    state: deployed.version_state,
    url: deployed.url,
    version_url: deployed.version_url,
    preparation: deployed.preparation,
    live: published,
    demo: dirArg === "demo",
  });
}

async function status(appFlag?: string) {
  const app = targetApp(appFlag);
  const [detail, deploys] = await Promise.all([api.getApp(app), api.listDeploys(app, 1)]);
  const last = deploys[0];

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
    say(`  last deploy: ${outcome}${last.refusal ? ` — ${last.refusal.message}` : ""}`);
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

async function deploys(appFlag?: string) {
  const app = targetApp(appFlag);
  const rows = await api.listDeploys(app);
  if (rows.length === 0) say("no deploys yet");
  for (const row of rows) {
    const mark = row.status === "succeeded" ? green("ok") : red(row.status);
    const why = row.refusal ? ` — ${row.refusal.message}` : row.error ? ` — ${row.error}` : "";
    say(`${mark}  ${dim(row.created_at)} ${dim(`via ${row.source}`)}${why}`);
  }
  result({ command: "deploys", app, deploys: rows });
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

async function secrets(appFlag: string | undefined, argv: string[], plain: boolean) {
  const app = targetApp(appFlag);
  const [action, argument] = argv;

  if (action === "set") {
    const eq = argument?.indexOf("=") ?? -1;
    if (!argument || eq < 1) {
      failure("invalid_input", "usage: marina secrets set KEY=value");
      process.exit(1);
    }
    const key = argument.slice(0, eq);
    await api.setEnv(app, key, argument.slice(eq + 1), !plain);
    say(`${green("ok")} set ${bold(key)}${plain ? "" : dim(" (secret)")}`);
    result({ command: "secrets.set", app, key, kind: plain ? "plain" : "secret" });
    return;
  }
  if (action === "rm") {
    if (!argument) {
      failure("invalid_input", "usage: marina secrets rm KEY");
      process.exit(1);
    }
    await api.deleteEnv(app, argument);
    say(`${green("ok")} removed ${bold(argument)}`);
    result({ command: "secrets.rm", app, key: argument, removed: true });
    return;
  }

  const rows = await api.listEnv(app);
  if (rows.length === 0) say("nothing set");
  for (const row of rows) {
    say(
      `${bold(row.key)}  ${row.kind === "secret" ? dim("secret — write-only") : (row.value ?? "")}`,
    );
  }
  result({ command: "secrets.list", app, env: rows });
}

async function main() {
  // Parse failures happen before values.json is available. Detect this one
  // universal flag up front so even a typo still returns machine JSON.
  setJsonMode(process.argv.slice(2).includes("--json"));
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      token: { type: "string" },
      name: { type: "string" },
      app: { type: "string" },
      to: { type: "string" },
      plain: { type: "boolean" },
      agent: { type: "string" },
      json: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  setJsonMode(values.json === true);
  const command = positionals[0];

  if (values.help || !command) {
    say(HELP);
    result({ command: "help", usage: HELP.replaceAll(ANSI_ESCAPE, "") });
    return;
  }
  shouldCheckForUpdates = true;

  let skillBootstrap: ReturnType<typeof autoInstallSkills> | null = null;
  if (command !== "skills") {
    try {
      skillBootstrap = autoInstallSkills();
      for (const installed of skillBootstrap.installed) {
        if (installed.status === "installed") {
          say(dim(`installed Marina skill for ${installed.agent}`));
        }
      }
      if (skillBootstrap.updatesAvailable.length > 0) {
        const agent =
          skillBootstrap.updatesAvailable.length > 1 ? "all" : skillBootstrap.updatesAvailable[0];
        say(
          dim(
            `Marina skill update available — run marina skills install --agent ${agent ?? "all"}`,
          ),
        );
      }
    } catch {
      say(dim("could not install the Marina agent skill; run marina skills install later"));
    }
  }

  switch (command) {
    case "setup":
    case "login": {
      const token = values.token ?? process.env.MARINA_TOKEN;
      if (token) {
        saveToken(token);
      } else {
        const signedIn = await loginWithBrowser((url) => {
          say("Opening your browser to sign in…");
          say(dim(url));
        });
        saveToken(signedIn.token);
      }
      say(`${green("ok")} signed in ${dim(`(${apiUrl()})`)}`);
      if (skillBootstrap?.detected.length === 0) {
        say(
          dim("no Codex or Claude installation detected — use marina skills install --agent later"),
        );
      }
      result({
        command: "setup",
        signed_in: true,
        api: apiUrl(),
        profile: profilePath(),
        skills: skillBootstrap?.installed ?? [],
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
    case "deploy":
      await deploy(positionals[1], values);
      return;
    case "status":
      await status(values.app);
      return;
    case "deploys":
    case "deployments":
      await deploys(values.app);
      return;
    case "versions":
      await versions(values.app);
      return;
    case "rollback":
      await rollback(values.app, values.to);
      return;
    case "secrets":
      await secrets(values.app, positionals.slice(1), values.plain === true);
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
    const message = `Marina CLI ${update.latest} is available (current ${update.current}) — ${update.command}`;
    note(isJsonMode() ? message : dim(message));
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
