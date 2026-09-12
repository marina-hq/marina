import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { getDeploy, listRuntimeLogs, pollDeploy, startDeploy, type DeployStatus } from "./api.ts";

const originalFetch = globalThis.fetch;
const originalToken = process.env.MARINA_TOKEN;

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalToken === undefined) delete process.env.MARINA_TOKEN;
  else process.env.MARINA_TOKEN = originalToken;
});

describe("deploy polling", () => {
  it("sends the linked app's opaque base revision with the upload", async () => {
    process.env.MARINA_TOKEN = "mar_test";
    globalThis.fetch = async (_input, init) => {
      assert.ok(init?.body instanceof FormData);
      assert.equal(init.body.get("app"), "pto-tracker");
      assert.equal(init.body.get("base_revision"), "a".repeat(40));
      assert.equal(init.body.get("source"), "cli");
      return Response.json({ deploy: { id: "deploy-1" } });
    };

    await startDeploy(new Uint8Array([1, 2, 3]), "PTO Tracker", "pto-tracker", "a".repeat(40));
  });

  it("reports each observed state while waiting for completion", async () => {
    process.env.MARINA_TOKEN = "mar_test";
    const states: DeployStatus["status"][] = ["queued", "building", "succeeded"];
    let call = 0;
    globalThis.fetch = async (_input, init) => {
      const headers = new Headers(init?.headers);
      assert.equal(headers.get("x-marina-client"), "cli");
      assert.match(headers.get("x-marina-client-version") ?? "", /^\d+\.\d+\.\d+$/);
      assert.match(headers.get("user-agent") ?? "", /^marina-cli\/\d+\.\d+\.\d+$/);
      return new Response(
        JSON.stringify({
          deploy: {
            id: "deploy-1",
            status: states[call++] ?? "succeeded",
            refusal: null,
            error: null,
            build_log: null,
            app_slug: "hello-marina",
            version_number: 1,
            version_state: "published",
            preparation: null,
            source_revision: "a".repeat(40),
            url: "https://hello.example",
            version_url: null,
          },
        }),
        { headers: { "content-type": "application/json" } },
      );
    };

    const observed: DeployStatus["status"][] = [];
    const deployed = await pollDeploy("deploy-1", (progress) => observed.push(progress.status));

    assert.equal(deployed.status, "succeeded");
    assert.deepEqual(observed, ["queued", "building", "succeeded"]);
  });

  it("retrieves a pre-app attempt directly by deploy id", async () => {
    process.env.MARINA_TOKEN = "mar_test";
    globalThis.fetch = async (input) => {
      const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
      assert.equal(url.pathname, "/v1/deploys/deploy%20before%20app");
      return Response.json({
        deploy: {
          id: "deploy before app",
          status: "refused",
          refusal: { code: "build_failed", message: "no build", action: "fix it" },
          error: null,
          build_log: "build output",
          app_slug: null,
          version_number: null,
          version_state: null,
          preparation: null,
          url: null,
          version_url: null,
        },
      });
    };

    const deploy = await getDeploy("deploy before app");
    assert.equal(deploy.status, "refused");
    assert.equal(deploy.app_slug, null);
    assert.equal(deploy.build_log, "build output");
  });
});

describe("runtime logs", () => {
  it("sends pagination and level filters and preserves the next cursor", async () => {
    process.env.MARINA_TOKEN = "mar_test";
    globalThis.fetch = async (input) => {
      const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
      assert.equal(url.pathname, "/v1/apps/notes%20app/logs");
      assert.equal(url.searchParams.get("limit"), "25");
      assert.equal(url.searchParams.get("cursor"), "next page");
      assert.equal(url.searchParams.get("level"), "error");
      return Response.json({
        logs: [
          {
            id: "log-1",
            invocation_id: "invocation-1",
            ts: "2026-08-20T12:00:00.000Z",
            kind: "exception",
            level: "error",
            message: "boom",
            exception_name: "TypeError",
            outcome: "exception",
            request_method: "GET",
            request_path: "/",
            response_status: 500,
            ray_id: "ray-1",
            colo: "SJC",
            sequence: 1,
            truncated: false,
          },
        ],
        next_cursor: "older",
      });
    };

    const response = await listRuntimeLogs("notes app", {
      limit: 25,
      cursor: "next page",
      level: "error",
    });
    assert.equal(response.logs[0]?.message, "boom");
    assert.equal(response.nextCursor, "older");
  });
});
