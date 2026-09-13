import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { me } from "../api.ts";
import { apiUrl, getToken } from "../config.ts";
import { bold, dim, green, say } from "../output.ts";
import { createDevBinding } from "./binding.ts";
import { startDevControl } from "./control.ts";
import { LocalDatabase } from "./db.ts";
import { startDevHost, type DevHost } from "./host.ts";
import { DevJobRunner } from "./jobs.ts";
import { readDevManifest } from "./manifest.ts";
import { LocalStorage } from "./storage.ts";

const DEFAULT_PORT = 5990;

export interface DevCommandOptions {
  dir?: string;
  port?: string;
  schedules?: boolean;
}

export async function runDev(options: DevCommandOptions): Promise<void> {
  const token = getToken();
  if (!token) {
    throw new Error("not signed in — run `marina setup` first");
  }
  const projectDir = resolve(options.dir ?? ".");
  const manifest = readDevManifest(projectDir);
  const port = options.port ? Number(options.port) : DEFAULT_PORT;
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("--port must be a number between 1 and 65535");
  }

  const identity = await me();
  const appName = manifest.name ?? "Marina app";
  say(`${bold("marina dev")} · ${appName}`);

  const declared = Object.entries(manifest.connections).flatMap(([connector, bindings]) =>
    bindings.map((binding) => `${connector}/${binding.connection}`),
  );
  if (declared.length > 0) {
    say(
      dim(
        `connections: ${declared.join(", ")} — bridged to ${apiUrl()} as ${identity.user.email}; grants are checked per call`,
      ),
    );
  }

  const devDir = join(projectDir, ".marina", "dev");
  const storage =
    manifest.runtime.storage === "v1" ? new LocalStorage(join(devDir, "storage")) : null;
  let database: LocalDatabase | null = null;
  const control = await startDevControl(projectDir, () => database);
  let host: DevHost | undefined;
  let jobs: DevJobRunner | null = null;
  try {
    if (manifest.runtime.db === "v1") {
      database = await LocalDatabase.open(join(devDir, "db"));
      const applied = await database.applyMigrations(projectDir);
      const total = existsSync(join(projectDir, "marina", "migrations"))
        ? ""
        : " (no marina/migrations yet)";
      say(
        `${green("ok")} db — embedded Postgres ready, ${String(applied.length)} migrations applied${total}`,
      );
    }
    jobs =
      manifest.runtime.jobs === "v1"
        ? new DevJobRunner(
            manifest,
            { workspaceId: identity.workspace.id, appId: "local-dev" },
            (line) => {
              say(dim(line));
            },
          )
        : null;

    const binding = createDevBinding({
      manifest,
      storage,
      database,
      jobs,
      bridge: { apiUrl: apiUrl(), token },
    });

    host = await startDevHost({
      projectDir,
      beforeReload: async () => {
        const applied = await database?.applyMigrations(projectDir);
        if (applied?.length) say(dim(`db: applied ${applied.join(", ")}`));
      },
      buildDir: join(devDir, "build"),
      manifest,
      binding,
      port,
      identity: {
        userId: identity.user.id,
        workspaceId: identity.workspace.id,
        userLabel: identity.user.email,
        appName,
      },
      log: (line) => {
        say(dim(line));
      },
    });
    jobs?.attachApp(host.fetchApp);
    if (jobs && options.schedules) {
      jobs.startSchedules();
      say(dim("schedules: on"));
    } else if (jobs && Object.values(manifest.jobs).some((job) => job.schedule)) {
      say(dim("schedules: off — pass --schedules to run them locally"));
    }
    if (manifest.runtime.ai === "v1") {
      say(dim("marina.ai: bridged to Marina; usage is metered"));
    }

    say(
      `${green("→")} http://localhost:${String(port)}  ${dim(`(signed in as ${identity.user.email})`)}`,
    );
    if (database)
      say(dim("database: marina db tables | schema <table> | query <sql> | migrations"));
    // Serve until interrupted. Remove both handlers on shutdown so repeated
    // programmatic starts don't retain listeners from earlier sessions.
    await new Promise<void>((stop) => {
      const shutdown = () => {
        process.removeListener("SIGINT", shutdown);
        process.removeListener("SIGTERM", shutdown);
        stop();
      };
      process.once("SIGINT", shutdown);
      process.once("SIGTERM", shutdown);
    });
  } finally {
    jobs?.stop();
    await host?.close();
    await control.close();
    await database?.close();
  }
}
