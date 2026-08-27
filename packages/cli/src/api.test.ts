import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { listApps, pollDeploy, type DeployStatus } from "./api.ts";

const originalFetch = globalThis.fetch;
const originalToken = process.env.MARINA_TOKEN;

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalToken === undefined) delete process.env.MARINA_TOKEN;
  else process.env.MARINA_TOKEN = originalToken;
});

describe("deploy polling", () => {
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
});

describe("app listing", () => {
  it("returns only the portable user-facing app contract", async () => {
    process.env.MARINA_TOKEN = "mar_test";
    globalThis.fetch = async () =>
      Response.json({
        apps: [
          {
            id: "app-1",
            slug: "notes",
            emoji: "📝",
            name: "Notes",
            status: "live",
            version: 3,
            url: "https://notes.example",
            type: "dynamic",
            folder_id: "folder-1",
          },
        ],
      });

    assert.deepEqual(await listApps(), [
      {
        slug: "notes",
        emoji: "📝",
        name: "Notes",
        status: "live",
        version: 3,
        url: "https://notes.example",
      },
    ]);
  });
});
