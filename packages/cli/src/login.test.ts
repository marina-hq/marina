import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { describe, it } from "node:test";
import { closeLoginServer, waitForLoginCallback, type LoginProgress } from "./login.ts";

function callback(
  server: Server,
  url: string,
): { response: ServerResponse; status: () => number | null } {
  let responseStatus: number | null = null;
  const response = {
    setHeader: () => undefined,
    writeHead(status: number) {
      responseStatus = status;
      return response;
    },
    end(_body?: unknown, done?: () => void) {
      done?.();
      return response;
    },
  } as unknown as ServerResponse;
  server.emit("request", { url } as IncomingMessage, response);
  return { response, status: () => responseStatus };
}

describe("browser login callback", () => {
  it("force-closes browser connections during shutdown", async () => {
    let stopped = false;
    let connectionsClosed = false;
    const server = {
      close(done: () => void) {
        stopped = true;
        done();
        return server;
      },
      closeAllConnections() {
        connectionsClosed = true;
      },
    } as unknown as Server;

    await closeLoginServer(server);

    assert.equal(stopped, true);
    assert.equal(connectionsClosed, true);
  });

  it("reports progress and resolves only the matching callback", async () => {
    const server = new EventEmitter() as Server;
    const progress: LoginProgress[] = [];
    const code = waitForLoginCallback(
      server,
      "expected-state",
      (event) => progress.push(event),
      500,
    );

    const handled = callback(server, "/callback?state=expected-state&code=authorization-code");

    assert.equal(handled.status(), 200);
    assert.equal(await code, "authorization-code");
    assert.equal(progress[0]?.phase, "waiting");
    assert.equal(progress.at(-1)?.phase, "received");
  });

  it("fails after a bounded wait", async () => {
    const server = new EventEmitter() as Server;
    const keepAlive = setTimeout(() => undefined, 1000);
    try {
      await assert.rejects(
        waitForLoginCallback(server, "expected-state", () => undefined, 25),
        /timed out after 1 second/,
      );
    } finally {
      clearTimeout(keepAlive);
    }
  });
});
