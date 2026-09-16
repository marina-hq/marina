import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdirSync, watch, writeFileSync, type FSWatcher } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Readable } from "node:stream";
import type { createDevBinding } from "./binding.ts";
import { devChromeSnippet, injectDevChrome } from "./chrome.ts";
import { DEV_RUNTIME_FILES } from "./embedded-runtime.ts";
import type { DevManifest } from "./manifest.ts";

/** The local host behind `marina dev`: materialize the exact runtime files
 * the deployment builders use, bundle the app the same way, and serve it
 * with a locally injected MARINA binding. App code is byte-identical to
 * production; only the binding differs. */

interface PlatformApp {
  fetch(request: Request, environment: unknown, context: unknown): Response | Promise<Response>;
}

export interface DevHostOptions {
  projectDir: string;
  buildDir: string;
  manifest: DevManifest;
  binding: ReturnType<typeof createDevBinding>;
  port: number;
  identity: { userId: string; workspaceId: string; userLabel: string; appName: string };
  log: (line: string) => void;
  beforeReload?: () => Promise<void>;
  /** Trusted host chrome; Studio supplies its own preview label. */
  chrome?: string;
  /** Trusted preview origin; local CLI requests use the loopback origin. */
  origin?: string;
}

function entrypointSource(projectDir: string, entrypoint: string): string {
  // Generate the app entrypoint beside the runtime files materialized below.
  return [
    `import app from ${JSON.stringify(resolve(projectDir, entrypoint))};`,
    ["import { adaptApp } ", ["fr", "om"].join(""), ' "./runtime/index.ts";'].join(""),
    "export default adaptApp(app);",
    "",
  ].join("\n");
}

async function bundle(options: DevHostOptions): Promise<PlatformApp> {
  for (const [name, source] of Object.entries(DEV_RUNTIME_FILES)) {
    const path = join(options.buildDir, "runtime", name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, source);
  }
  const entry = join(options.buildDir, "entrypoint.ts");
  writeFileSync(entry, entrypointSource(options.projectDir, options.manifest.entrypoint));
  const outfile = join(options.buildDir, "app.mjs");

  let esbuild: typeof import("esbuild");
  try {
    esbuild = await import("esbuild");
  } catch {
    throw new Error("esbuild could not load — reinstall the Marina CLI");
  }
  // The same flags the deployment builders use, so bundling behaves
  // identically on the laptop and in the build sandbox.
  await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    format: "esm",
    platform: "browser",
    conditions: ["workerd", "worker", "browser"],
    target: "es2022",
    external: ["cloudflare:*"],
    alias: {
      "@marina/runtime": join(options.buildDir, "runtime", "index.ts"),
      "marina:runtime": join(options.buildDir, "runtime", "index.ts"),
    },
    absWorkingDir: options.projectDir,
    outfile,
    logLevel: "silent",
  });
  const module = (await import(`${pathToFileURL(outfile).href}?v=${String(Date.now())}`)) as {
    default: PlatformApp;
  };
  if (typeof module.default?.fetch !== "function") {
    throw new Error("the app entrypoint does not export a Marina app (use defineApp)");
  }
  return module.default;
}

function toRequest(
  req: IncomingMessage,
  port: number,
  identity: DevHostOptions["identity"],
  origin?: string,
): Request {
  const url = new URL(
    req.url ?? "/",
    origin ?? `http://${req.headers.host ?? `localhost:${String(port)}`}`,
  );
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (typeof value === "string") headers.set(name, value);
    else if (Array.isArray(value)) headers.set(name, value.join(", "));
  }
  // The gateway strips inbound identity headers and signs its own; the local
  // host does the same for the signed-in developer.
  headers.set("x-platform-user-id", identity.userId);
  headers.set("x-platform-workspace-id", identity.workspaceId);
  headers.set("x-platform-connection-session", "marina-local-dev");
  const method = req.method ?? "GET";
  const body =
    method === "GET" || method === "HEAD"
      ? undefined
      : (Readable.toWeb(req) as unknown as ReadableStream<Uint8Array>);
  return new Request(url, {
    method,
    headers,
    ...(body ? { body, duplex: "half" } : {}),
  } as RequestInit);
}

async function writeResponse(
  response: Response,
  res: ServerResponse,
  chrome: string,
): Promise<void> {
  const headers: Record<string, string | string[]> = {};
  response.headers.forEach((value, name) => {
    headers[name] = value;
  });
  const cookies = response.headers.getSetCookie();
  if (cookies.length) headers["set-cookie"] = cookies;
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("text/html")) {
    const html = injectDevChrome(await response.text(), chrome);
    delete headers["content-length"];
    res.writeHead(response.status, headers);
    res.end(html);
    return;
  }
  res.writeHead(response.status, headers);
  if (!response.body) {
    res.end();
    return;
  }
  const reader = response.body.getReader();
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    res.write(next.value);
  }
  res.end();
}

export interface DevHost {
  port: number;
  fetchApp: (request: Request) => Promise<Response>;
  rebuild: () => Promise<void>;
  close: () => Promise<void>;
}

export async function startDevHost(options: DevHostOptions): Promise<DevHost> {
  mkdirSync(options.buildDir, { recursive: true });
  let app = await bundle(options);
  let reloadBlocked = false;
  const chrome =
    options.chrome ??
    devChromeSnippet({
      appName: options.identity.appName,
      userLabel: options.identity.userLabel,
    });

  const fetchApp = (request: Request): Promise<Response> =>
    Promise.resolve(
      reloadBlocked
        ? new Response("marina dev: database reload is incomplete; fix the migration and reload", {
            status: 503,
          })
        : app.fetch(request, { MARINA: options.binding }, { waitUntil: () => undefined }),
    );

  const server = createServer((req, res) => {
    const port = req.socket.localPort ?? options.port;
    const hosts = [`localhost:${String(port)}`, `127.0.0.1:${String(port)}`];
    if (port === 80) hosts.push("localhost", "127.0.0.1");
    if (
      !hosts.includes(req.headers.host ?? "") ||
      !req.url?.startsWith("/") ||
      req.url.startsWith("//")
    ) {
      res.writeHead(403).end("marina dev requires a local host");
      return;
    }
    Promise.resolve()
      .then(() => fetchApp(toRequest(req, port, options.identity, options.origin)))
      .then((response) => writeResponse(response, res, chrome))
      .catch((error: Error) => {
        res.writeHead(500, { "content-type": "text/plain" });
        res.end(`marina dev: ${error.message}`);
      });
  });
  await new Promise<void>((ready, failed) => {
    server.once("error", failed);
    server.listen(options.port, "127.0.0.1", () => {
      ready();
    });
  });

  let rebuilding: Promise<void> = Promise.resolve();
  const rebuild = () => {
    const next = rebuilding.then(async () => {
      const replacement = await bundle(options);
      // A migration batch can partially commit before a later file fails.
      // Once migrations start, stop serving the old app until reload succeeds.
      reloadBlocked = true;
      await options.beforeReload?.();
      app = replacement;
      reloadBlocked = false;
    });
    rebuilding = next.catch(() => undefined);
    return next;
  };
  let rebuildTimer: ReturnType<typeof setTimeout> | null = null;
  const watchers: FSWatcher[] = [];
  const scheduleRebuild = () => {
    if (rebuildTimer) clearTimeout(rebuildTimer);
    rebuildTimer = setTimeout(() => {
      rebuild()
        .then(() => {
          options.log("reloaded");
        })
        .catch((error: Error) => {
          options.log(
            reloadBlocked
              ? `reload failed — app paused until migrations succeed: ${error.message}`
              : `build failed — still serving the previous build: ${error.message}`,
          );
        });
    }, 150);
  };
  try {
    const watcher = watch(options.projectDir, { recursive: true }, (_event, file) => {
      const name = String(file ?? "");
      if (
        name.startsWith(".marina") ||
        name.startsWith("node_modules") ||
        name.startsWith(".git")
      ) {
        return;
      }
      scheduleRebuild();
    });
    watchers.push(watcher);
  } catch {
    options.log("file watching is unavailable — restart marina dev to pick up changes");
  }

  return {
    port: (server.address() as { port: number }).port,
    fetchApp,
    rebuild,
    close: async () => {
      for (const watcher of watchers) watcher.close();
      if (rebuildTimer) clearTimeout(rebuildTimer);
      await rebuilding;
      await new Promise<void>((done) => {
        server.close(() => {
          done();
        });
      });
    },
  };
}
