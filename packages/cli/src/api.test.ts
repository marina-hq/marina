import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { pollDeploy, type DeployStatus } from "./api.ts";

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
    globalThis.fetch = async () =>
      new Response(
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

    const observed: DeployStatus["status"][] = [];
    const deployed = await pollDeploy("deploy-1", (progress) => observed.push(progress.status));

    assert.equal(deployed.status, "succeeded");
    assert.deepEqual(observed, ["queued", "building", "succeeded"]);
  });
});
