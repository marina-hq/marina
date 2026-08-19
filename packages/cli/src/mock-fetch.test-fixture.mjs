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
      api_url: "https://marina-direct-api.example.run.app",
      dashboard_url: "https://marina.cloud",
      clients: { cli: { latest_version: "0.0.3" } },
    });
  }
  if (method === "POST" && url.pathname === "/v1/deploys") {
    return Response.json({ deploy: { id: "deploy-demo" } }, { status: 202 });
  }
  if (method === "GET" && url.pathname === "/v1/deploys/deploy-demo") {
    return Response.json({
      deploy: {
        id: "deploy-demo",
        status: "succeeded",
        refusal: null,
        error: null,
        build_log: null,
        app_slug: "hello-marina",
        version_number: 1,
        version_state: "published",
        preparation: null,
        url: "https://hello-marina.marina-apps.com",
        version_url: null,
      },
    });
  }
  throw new Error(`unexpected test request: ${method} ${url.pathname}`);
};
