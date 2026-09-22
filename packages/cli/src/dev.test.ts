import assert from "node:assert/strict";
import test from "node:test";
import { get } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bridgeInvoke, BridgeError } from "./dev/bridge.ts";
import { devChromeSnippet, injectDevChrome } from "./dev/chrome.ts";
import { cronMatches } from "./dev/cron.ts";
import { readDevManifest } from "./dev/manifest.ts";
import { LocalStorage } from "./dev/storage.ts";
import { createDevBinding } from "./dev/binding.ts";

const at = (iso: string) => new Date(iso);

test("app previews require manifest declarations and resolve an omitted handle from the app's own bindings", async () => {
  const calls: Record<string, unknown>[] = [];
  const binding = createDevBinding({
    manifest: {
      entrypoint: "app.ts",
      runtime: {},
      jobs: {},
      connections: { postgres: [{ connection: "orders", operations: ["query.read"] }] },
    },
    database: null,
    storage: null,
    jobs: null,
    bridge: {
      apiUrl: "https://api.example.test",
      token: "fictional",
      fetcher: async (_url, init) => {
        calls.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return Response.json({ value: { rows: [] } });
      },
    },
  });
  for (const input of [
    { connector: "postgres", connection: "payroll", operation: "query.read" },
    { connector: "postgres", connection: "orders", operation: "schema.search" },
    { connector: "bigquery", operation: "query.read" },
  ]) {
    const result = await binding.invoke({
      protocolVersion: 1,
      requestId: "test",
      service: "connections",
      operation: "invoke",
      input,
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, "UNDECLARED");
  }
  assert.equal(
    (
      await binding.invoke({
        protocolVersion: 1,
        requestId: "test",
        service: "capabilities",
        operation: "invoke",
        input: { capability: "mail.send" },
      })
    ).ok,
    false,
  );
  assert.equal(calls.length, 0);
  assert.equal(
    (
      await binding.invoke({
        protocolVersion: 1,
        requestId: "test",
        service: "connections",
        operation: "invoke",
        input: { connector: "postgres", operation: "query.read", args: { sql: "select 1" } },
      })
    ).ok,
    true,
  );
  assert.equal(calls[0]?.connection, "orders");
});

test("cron matcher covers stars, numbers, lists, ranges, and steps", () => {
  assert.equal(cronMatches("* * * * *", at("2026-09-01T10:30:00Z")), true);
  assert.equal(cronMatches("30 10 * * *", at("2026-09-01T10:30:00Z")), true);
  assert.equal(cronMatches("31 10 * * *", at("2026-09-01T10:30:00Z")), false);
  assert.equal(cronMatches("*/15 * * * *", at("2026-09-01T10:45:00Z")), true);
  assert.equal(cronMatches("*/15 * * * *", at("2026-09-01T10:44:00Z")), false);
  assert.equal(cronMatches("0 9-17 * * 1-5", at("2026-09-01T13:00:00Z")), true); // a Tuesday
  assert.equal(cronMatches("0 9-17 * * 1-5", at("2026-09-06T13:00:00Z")), false); // a Sunday
  assert.equal(cronMatches("0 0 1,15 * *", at("2026-09-15T00:00:00Z")), true);
  assert.equal(cronMatches("bad cron", at("2026-09-01T00:00:00Z")), false);
});

test("local storage round-trips objects with metadata and lists with cursors", async () => {
  const store = new LocalStorage(mkdtempSync(join(tmpdir(), "marina-dev-storage-")));
  const put = await store.put({
    key: "reports/q3.txt",
    body: "hello",
    contentType: "text/plain",
    metadata: { source: "test" },
  });
  assert.equal(put.size, 5);
  assert.equal(put.contentType, "text/plain");
  const got = store.get("reports/q3.txt");
  assert.ok(got);
  assert.equal(Buffer.from(got.body as Uint8Array).toString(), "hello");
  assert.deepEqual(got.metadata, { source: "test" });
  assert.equal(store.get("missing.txt"), null);

  await store.put({ key: "reports/q4.txt", body: "x" });
  await store.put({ key: "notes.md", body: "y" });
  const page = store.list({ prefix: "reports/", limit: 1 });
  assert.equal(page.objects.length, 1);
  assert.equal(page.truncated, true);
  const rest = store.list({ prefix: "reports/", cursor: page.cursor });
  assert.equal(rest.objects[0]?.key, "reports/q4.txt");
  assert.equal(rest.truncated, false);

  store.delete("notes.md");
  assert.equal(store.get("notes.md"), null);
  await assert.rejects(store.put({ key: "../escape.txt", body: "no" }), /escapes/);
});

test("dev chrome injects before </body> and appends otherwise", () => {
  const snippet = devChromeSnippet({ appName: "Finance <dash>", userLabel: "maya@acme.com" });
  assert.match(snippet, /Finance &lt;dash&gt;/);
  const page = injectDevChrome("<html><body><h1>hi</h1></body></html>", snippet);
  assert.ok(page.indexOf(snippet) < page.indexOf("</body>"));
  assert.ok(injectDevChrome("plain text", snippet).endsWith(snippet));
});

const deps = (response: Response) => ({
  apiUrl: "https://api.example.test",
  token: "cli-token",
  fetcher: (async (url: string | URL | Request, init?: RequestInit) => {
    assert.equal(String(url), "https://api.example.test/v1/dev/runtime");
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer cli-token");
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    assert.equal(body.service, "connections");
    assert.equal(body.connector, "mercury");
    return response;
  }) as typeof fetch,
});

test("the bridge maps control-plane errors to runtime codes and never invents values", async () => {
  const input = {
    service: "connections" as const,
    input: { session: "s", connector: "mercury", operation: "accounts.list", args: {} },
  };
  await assert.rejects(
    bridgeInvoke(
      deps(
        Response.json({ error: { code: "forbidden", message: "no dev access" } }, { status: 403 }),
      ),
      input,
    ),
    (error: BridgeError) =>
      error.payload.code === "UNDECLARED" && /no dev access/.test(error.payload.message),
  );
  const value = await bridgeInvoke(deps(Response.json({ ok: true, value: { items: [1] } })), input);
  assert.deepEqual(value, { items: [1] });
});

test("the dev manifest requires an entrypoint and explicit connection ids", () => {
  const dir = mkdtempSync(join(tmpdir(), "marina-dev-manifest-"));
  writeFileSync(join(dir, "marina.json"), JSON.stringify({ name: "X" }));
  assert.throws(() => readDevManifest(dir), /entrypoint/);
  writeFileSync(
    join(dir, "marina.json"),
    JSON.stringify({
      entrypoint: "src/worker.ts",
      connections: { mercury: [{ capabilities: ["accounts.list"] }] },
    }),
  );
  assert.throws(() => readDevManifest(dir), /"connection" id/);
  writeFileSync(
    join(dir, "marina.json"),
    JSON.stringify({
      entrypoint: "src/worker.ts",
      runtime: { db: "v1" },
      connections: {
        mercury: [{ connection: "example_account", operations: ["accounts.list"] }],
      },
    }),
  );
  const manifest = readDevManifest(dir);
  assert.equal(manifest.entrypoint, "src/worker.ts");
  assert.deepEqual(manifest.connections.mercury, [
    { connection: "example_account", operations: ["accounts.list"] },
  ]);
  void mkdirSync;
});

test("the embedded database applies migrations once and answers queries", async () => {
  const { LocalDatabase } = await import("./dev/db.ts");
  const project = mkdtempSync(join(tmpdir(), "marina-dev-db-"));
  mkdirSync(join(project, "marina", "migrations"), { recursive: true });
  writeFileSync(
    join(project, "marina", "migrations", "001_init.sql"),
    "create table notes (id serial primary key, body text not null);",
  );
  const db = await LocalDatabase.open(join(project, ".marina", "dev", "db"));
  assert.deepEqual(await db.applyMigrations(project), ["001_init.sql"]);
  assert.deepEqual(await db.applyMigrations(project), []);
  await db.query("insert into notes (body) values ($1)", ["hello"]);
  const result = await db.query("select id, body from notes order by id", []);
  assert.equal(result.rowCount, 1);
  assert.deepEqual(result.rows[0], { id: 1, body: "hello" });
  const [first, second] = await db.transaction([
    { text: "insert into notes (body) values ($1)", params: ["two"] },
    { text: "select count(*)::int as total from notes", params: [] },
  ]);
  assert.equal(first?.rowCount, 1);
  assert.deepEqual(second?.rows[0], { total: 2 });
});

test("the dev host serves a real app through the local binding with chrome injected", async () => {
  const { startDevHost } = await import("./dev/host.ts");
  const project = mkdtempSync(join(tmpdir(), "marina-dev-host-"));
  mkdirSync(join(project, "src"), { recursive: true });
  writeFileSync(
    join(project, "src", "worker.ts"),
    [
      // The fixture imports the runtime supplied by the local dev host.
      [
        "import { defineApp } ",
        ["fr", "om"].join(""),
        " ",
        JSON.stringify("@marina/runtime"),
        ";",
      ].join(""),
      "export default defineApp({",
      "  async fetch(request, marina) {",
      "    const url = new URL(request.url);",
      '    if (url.pathname === "/origin") return Response.json({ origin: url.origin });',
      '    if (url.pathname === "/job") {',
      '      const run = await marina.jobs.enqueue("test-job", {});',
      "      return Response.json(await marina.jobs.get(run.id));",
      "    }",
      '    if (url.pathname === "/save") {',
      '      const saved = await marina.storage.put("greeting.txt", "hi");',
      "      return Response.json(saved);",
      "    }",
      '    return new Response("<html><body><h1>ok</h1></body></html>", {',
      '      headers: { "content-type": "text/html" },',
      "    });",
      "  },",
      "  jobs: { testJob: async () => {} },",
      "});",
      "",
    ].join("\n"),
  );
  const manifest = {
    entrypoint: "src/worker.ts",
    runtime: { storage: "v1" as const, jobs: "v1" as const },
    connections: {},
    jobs: { "test-job": { handler: "testJob" } },
  };
  const { LocalStorage: Store } = await import("./dev/storage.ts");
  const { DevJobRunner } = await import("./dev/jobs.ts");
  const jobs = new DevJobRunner(
    manifest,
    { workspaceId: "workspace-1", appId: "local-dev" },
    () => undefined,
  );
  const binding = createDevBinding({
    manifest,
    storage: new Store(join(project, ".marina", "dev", "storage")),
    database: null,
    jobs,
    bridge: { apiUrl: "https://api.example.test", token: "unused" },
  });
  const port = 39_000 + Math.floor(Math.random() * 1000);
  const host = await startDevHost({
    projectDir: project,
    buildDir: join(project, ".marina", "dev", "build"),
    manifest,
    binding,
    port,
    identity: {
      userId: "user-1",
      workspaceId: "workspace-1",
      userLabel: "maya@acme.com",
      appName: "Host test",
    },
    log: () => undefined,
  });
  jobs.attachApp(host.fetchApp);
  try {
    const page = await fetch(`http://localhost:${String(port)}/`);
    const html = await page.text();
    assert.match(html, /<h1>ok<\/h1>/);
    assert.match(html, /local dev · maya@acme\.com/);
    const origin = await fetch(`http://127.0.0.1:${String(port)}/origin`);
    assert.deepEqual(await origin.json(), { origin: `http://127.0.0.1:${String(port)}` });
    const foreign = await new Promise<number | undefined>((done, reject) => {
      get(
        `http://127.0.0.1:${String(port)}/`,
        { headers: { host: "foreign.example" } },
        (response) => {
          response.resume();
          done(response.statusCode);
        },
      ).on("error", reject);
    });
    assert.equal(foreign, 403);

    const saved = await fetch(`http://localhost:${String(port)}/save`);
    const body = (await saved.json()) as { key: string; size: number };
    assert.equal(body.key, "greeting.txt");
    assert.equal(body.size, 2);

    const jobResponse = await fetch(`http://localhost:${String(port)}/job`);
    assert.equal(jobResponse.status, 200);
    const job = (await jobResponse.json()) as { id: string; name: string; state: string };
    assert.match(job.id, /^[0-9a-f-]{36}$/);
    assert.equal(job.name, "test-job");
    assert.ok(["running", "succeeded"].includes(job.state));
  } finally {
    await host.close();
  }
});

test("marina.ai bridges generate calls to the control plane", async () => {
  const manifest = {
    entrypoint: "app.ts",
    name: "AI test",
    runtime: { ai: "v1" as const },
    connections: {},
    jobs: {},
  };
  const calls: unknown[] = [];
  const binding = createDevBinding({
    manifest,
    storage: null,
    database: null,
    jobs: null,
    bridge: {
      apiUrl: "https://api.example.test",
      token: "token-1",
      fetcher: async (_url: unknown, init?: { body?: unknown }) => {
        calls.push(JSON.parse(String(init?.body)));
        return Response.json({ ok: true, value: { text: "hello from the bridge" } });
      },
    },
  });
  const response = await binding.invoke({
    protocolVersion: 1,
    requestId: "ai-1",
    service: "ai",
    operation: "generate",
    input: { model: "fast", messages: [{ role: "user", content: "Say hello." }] },
  });
  assert.deepEqual(response, { ok: true, value: { text: "hello from the bridge" } });
  assert.deepEqual(calls[0], {
    service: "ai",
    args: { model: "fast", messages: [{ role: "user", content: "Say hello." }] },
  });

  const undeclared = createDevBinding({
    manifest: { ...manifest, runtime: {} },
    storage: null,
    database: null,
    jobs: null,
    bridge: { apiUrl: "https://api.example.test", token: "token-1" },
  });
  const denied = await undeclared.invoke({
    protocolVersion: 1,
    requestId: "ai-2",
    service: "ai",
    operation: "generate",
    input: {},
  });
  assert.equal(denied.ok, false);
  if (!denied.ok) assert.match(denied.error.message, /runtime\.ai: "v1"/);
});

test("local manifests normalize legacy operations and reject ambiguous authority", () => {
  const dir = mkdtempSync(join(tmpdir(), "marina-dev-operations-"));
  const read = (binding: unknown) => {
    writeFileSync(
      join(dir, "marina.json"),
      JSON.stringify({ entrypoint: "app.ts", connections: { bigquery: [binding] } }),
    );
    return readDevManifest(dir).connections;
  };
  assert.deepEqual(read({ connection: "analytics", operations: ["query.read"] }), {
    bigquery: [{ connection: "analytics", operations: ["query.read"] }],
  });
  assert.throws(() => read({ connection: "analytics", capabilities: ["query.read"] }));
  for (const binding of [
    { connection: "analytics" },
    { connection: "analytics", operations: ["query.read"], capabilities: ["schema.search"] },
    { connection: "analytics", operations: ["query.read", "query.read"] },
    { connection: "analytics", capabilities: ["query.read", "query.read"] },
    { connection: "analytics", operations: [] },
    null,
  ])
    assert.throws(() => read(binding));
});

test("local grants keep the production shape and require the manifest declaration", async () => {
  const base = {
    storage: null,
    database: null,
    jobs: null,
    bridge: { apiUrl: "https://api.example.test", token: "token-1" },
    origin: "http://localhost:5990",
  };
  const request = {
    protocolVersion: 1,
    requestId: "grant-1",
    service: "grants",
    operation: "create",
    input: { path: "/api/builds/42/manifest.plist", methods: ["GET"], expiresIn: 600 },
  };
  const declared = createDevBinding({
    ...base,
    manifest: { entrypoint: "app.ts", runtime: { grants: "v1" }, jobs: {}, connections: {} },
  });
  const granted = await declared.invoke(request);
  assert.equal(granted.ok, true);
  if (granted.ok) {
    const value = granted.value as { url: string; token: string };
    const url = new URL(value.url);
    assert.equal(url.origin, "http://localhost:5990");
    assert.equal(url.pathname, "/api/builds/42/manifest.plist");
    assert.equal(url.searchParams.get("marina_grant"), value.token);
  }

  for (const path of [
    "//other.example/x",
    "/api/../admin",
    "/__marina/chrome",
    "/api/%2e%2e/x",
    `/${"a".repeat(1024)}`,
  ]) {
    const refused = await declared.invoke({ ...request, input: { ...request.input, path } });
    assert.equal(refused.ok, false, path);
  }

  const undeclared = createDevBinding({
    ...base,
    manifest: { entrypoint: "app.ts", runtime: {}, jobs: {}, connections: {} },
  });
  const denied = await undeclared.invoke(request);
  assert.equal(denied.ok, false);
  if (!denied.ok) assert.match(denied.error.message, /runtime\.grants: "v1"/);
});

test("local storage matches production ranges, streams, head, and checksums", async () => {
  const { createHash } = await import("node:crypto");
  const store = new LocalStorage(mkdtempSync(join(tmpdir(), "marina-dev-storage-")));
  await store.put({
    key: "builds/1",
    body: new Response("0123456789").body as ReadableStream<Uint8Array>,
    size: 10,
    sha256: createHash("sha256").update("0123456789").digest("hex"),
  });
  assert.equal(store.head("builds/1")?.size, 10);
  assert.equal(store.head("builds/none"), null);

  const ranged = store.get("builds/1", { range: { offset: 2, length: 3 } });
  assert.equal(Buffer.from(ranged?.body as Uint8Array).toString(), "234");
  assert.deepEqual(ranged?.range, { offset: 2, length: 3 });
  const suffix = store.get("builds/1", { range: { suffix: 4 }, stream: true });
  assert.equal(await new Response(suffix?.body as ReadableStream).text(), "6789");
  assert.throws(() => store.get("builds/1", { range: { offset: 10 } }), /beyond the object/);

  await assert.rejects(
    store.put({ key: "builds/2", body: "tampered", sha256: "0".repeat(64) }),
    /does not match sha256/,
  );
  await assert.rejects(
    store.put({
      key: "builds/3",
      body: new Response("short").body as ReadableStream<Uint8Array>,
      size: 50,
    }),
    /length does not match size/,
  );
  await assert.rejects(
    store.put({
      key: "builds/4",
      body: new Response("longer than declared").body as ReadableStream<Uint8Array>,
      size: 4,
    }),
    /length does not match size/,
  );
  assert.equal(store.head("builds/4"), null);
});
