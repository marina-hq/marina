globalThis.fetch = async (input, init = {}) => {
  const url = new URL(typeof input === "string" ? input : input.url);
  const method = init.method ?? "GET";
  if (method === "GET" && url.pathname === "/.well-known/marina") {
    const headers = new Headers(init.headers);
    if (
      headers.get("x-marina-client") !== "cli" ||
      !/^\d+\.\d+\.\d+$/.test(headers.get("x-marina-client-version") ?? "")
    ) {
      return new Response(null, { status: 400 });
    }
    return Response.json({
      schema_version: 1,
      api_url: "https://api.example.test",
      dashboard_url: "https://marina.cloud",
      clients: { cli: { latest_version: "0.0.3" } },
    });
  }
  if (method === "POST" && url.pathname === "/v1/deploys") {
    return Response.json({ deploy: { id: "deploy-demo" } }, { status: 202 });
  }
  if (method === "GET" && url.pathname === "/v1/deploys/deploy-demo") {
    const failed = process.env.MARINA_TEST_DEPLOY_FAILURE === "1";
    const refused = process.env.MARINA_TEST_DEPLOY_REFUSAL === "1";
    return Response.json({
      deploy: {
        id: "deploy-demo",
        status: refused ? "refused" : failed ? "failed" : "succeeded",
        refusal: refused
          ? { code: "archive_too_large", message: "artifact refused", action: "trim it" }
          : null,
        error: failed ? "build failed" : null,
        build_log: failed ? "unsafe-build-log\u001b]0;spoofed\u0007\u009b31m" : null,
        app_slug: refused ? null : "hello-marina",
        version_number: refused ? null : 1,
        version_state: refused ? null : "published",
        preparation: null,
        url: refused ? null : "https://hello-marina.marina-apps.com",
        version_url: null,
      },
    });
  }
  if (method === "GET" && url.pathname === "/v1/apps/hello-marina/logs") {
    return Response.json({
      logs: [
        {
          id: "log-1",
          invocation_id: "invocation-1",
          ts: "2026-08-21T12:00:00.000Z",
          kind: "console",
          level: "error",
          message: "unsafe-runtime-log\u001b]8;;https://example.test\u0007\u009b31m",
          exception_name: "",
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
      next_cursor: null,
    });
  }
  throw new Error(`unexpected test request: ${method} ${url.pathname}`);
};
