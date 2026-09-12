import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bridgeInvoke, BridgeError } from "./dev/bridge.ts";
import { devChromeSnippet, injectDevChrome } from "./dev/chrome.ts";
import { cronMatches } from "./dev/cron.ts";
import { readDevManifest } from "./dev/manifest.ts";
import { LocalStorage } from "./dev/storage.ts";

const at = (iso: string) => new Date(iso);

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

test("local storage round-trips objects with metadata and lists with cursors", () => {
  const store = new LocalStorage(mkdtempSync(join(tmpdir(), "marina-dev-storage-")));
  const put = store.put({
    key: "reports/q3.txt",
    body: "hello",
    contentType: "text/plain",
    metadata: { source: "test" },
  });
  assert.equal(put.size, 5);
  assert.equal(put.contentType, "text/plain");
  const got = store.get("reports/q3.txt");
  assert.ok(got);
  assert.equal(Buffer.from(got.body).toString(), "hello");
  assert.deepEqual(got.metadata, { source: "test" });
  assert.equal(store.get("missing.txt"), null);

  store.put({ key: "reports/q4.txt", body: "x" });
  store.put({ key: "notes.md", body: "y" });
  const page = store.list({ prefix: "reports/", limit: 1 });
  assert.equal(page.objects.length, 1);
  assert.equal(page.truncated, true);
  const rest = store.list({ prefix: "reports/", cursor: page.cursor });
  assert.equal(rest.objects[0]?.key, "reports/q4.txt");
  assert.equal(rest.truncated, false);

  store.delete("notes.md");
  assert.equal(store.get("notes.md"), null);
  assert.throws(() => store.put({ key: "../escape.txt", body: "no" }), /escapes/);
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
        mercury: [{ connection: "example_account", capabilities: ["accounts.list"] }],
      },
    }),
  );
  const manifest = readDevManifest(dir);
  assert.equal(manifest.entrypoint, "src/worker.ts");
  assert.deepEqual(manifest.connections.mercury, [
    { connection: "example_account", capabilities: ["accounts.list"] },
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
    capabilities: [],
    connections: {},
    jobs: { "test-job": { handler: "testJob" } },
  };
  const { LocalStorage: Store } = await import("./dev/storage.ts");
  const { createDevBinding } = await import("./dev/binding.ts");
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
  const { createDevBinding } = await import("./dev/binding.ts");
  const manifest = {
    entrypoint: "app.ts",
    name: "AI test",
    runtime: { ai: "v1" as const },
    capabilities: [],
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
