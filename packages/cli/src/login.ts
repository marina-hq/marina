import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { hostname } from "node:os";
import { dashboardUrl } from "./config.ts";
import { exchangeCliLogin } from "./api.ts";

const LOGIN_TIMEOUT_MS = 5 * 60_000;
const PROGRESS_INTERVAL_MS = 1000;

export type LoginProgress =
  | { phase: "waiting"; elapsedMs: number; remainingMs: number }
  | { phase: "received" };

const page = (title: string, message: string) => `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>${title}</title><style>
body{margin:0;display:grid;place-items:center;min-height:100vh;font:15px/1.5 system-ui,sans-serif;color:#142238;background:#faf9f7}
main{text-align:center;padding:32px}h1{font-size:22px;margin:0 0 6px}p{margin:0;color:#667085}
</style></head><body><main><h1>${title}</h1><p>${message}</p></main></body></html>`;

export const closeLoginServer = (server: Server): Promise<void> =>
  new Promise((resolve) => {
    // Browsers may keep the localhost callback connection alive after the
    // response is flushed. Stop accepting connections first, then close any
    // remaining ones so saving the credential cannot get stuck here.
    server.close(() => resolve());
    server.closeAllConnections();
  });

function openBrowser(url: string): void {
  const command =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "explorer.exe"
        : "xdg-open";
  const child = spawn(command, [url], { detached: true, stdio: "ignore" });
  child.on("error", () => undefined);
  child.unref();
}

function timeoutLabel(timeoutMs: number): string {
  if (timeoutMs % 60_000 === 0) {
    const minutes = timeoutMs / 60_000;
    return `${String(minutes)} minute${minutes === 1 ? "" : "s"}`;
  }
  const seconds = Math.ceil(timeoutMs / 1000);
  return `${String(seconds)} second${seconds === 1 ? "" : "s"}`;
}

export function waitForLoginCallback(
  server: Server,
  expectedState: string,
  onProgress: (progress: LoginProgress) => void,
  timeoutMs = LOGIN_TIMEOUT_MS,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const waiting = () => {
      const elapsedMs = Date.now() - startedAt;
      onProgress({
        phase: "waiting",
        elapsedMs,
        remainingMs: Math.max(0, timeoutMs - elapsedMs),
      });
    };
    waiting();
    const progress = setInterval(waiting, PROGRESS_INTERVAL_MS);
    progress.unref();
    const timer = setTimeout(() => {
      clearInterval(progress);
      reject(
        new Error(
          `browser login timed out after ${timeoutLabel(timeoutMs)} — run \`marina setup\` to try again`,
        ),
      );
    }, timeoutMs);
    timer.unref();

    server.on("request", (request, response) => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (url.pathname !== "/callback") {
        response.writeHead(404).end();
        return;
      }
      response.setHeader("cache-control", "no-store");
      response.setHeader("content-type", "text/html; charset=utf-8");
      response.setHeader("connection", "close");
      const state = url.searchParams.get("state");
      const code = url.searchParams.get("code");
      const error = url.searchParams.get("error");
      if (state !== expectedState) {
        response.writeHead(400);
        response.end(page("Login failed", "The callback did not match this CLI session."));
        return;
      }
      clearTimeout(timer);
      clearInterval(progress);
      if (error || !code) {
        response.writeHead(400);
        response.end(
          page("Login cancelled", "You can close this window and return to the terminal."),
          () =>
            reject(
              new Error(
                error === "access_denied" ? "browser login cancelled" : "browser login failed",
              ),
            ),
        );
        return;
      }
      onProgress({ phase: "received" });
      response.writeHead(200);
      response.end(
        page("Marina CLI is signed in", "You can close this window and return to the terminal."),
        () => resolve(code),
      );
    });
  });
}

export async function loginWithBrowser(
  onOpen: (url: string) => void,
  onProgress: (progress: LoginProgress) => void = () => undefined,
): Promise<{ token: string; name: string; prefix: string }> {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const state = randomBytes(32).toString("base64url");
  const server = createServer();

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("could not start login callback");
    const callback = `http://127.0.0.1:${String(address.port)}/callback`;
    const authorize = new URL("/cli/login", dashboardUrl());
    authorize.searchParams.set("callback_uri", callback);
    authorize.searchParams.set("code_challenge", challenge);
    authorize.searchParams.set("state", state);
    authorize.searchParams.set(
      "device_name",
      `Marina CLI on ${hostname().split(".")[0]}`.slice(0, 80),
    );

    const codePromise = waitForLoginCallback(server, state, onProgress);
    onOpen(authorize.toString());
    openBrowser(authorize.toString());
    const code = await codePromise;
    return await exchangeCliLogin(code, verifier);
  } finally {
    await closeLoginServer(server);
  }
}
