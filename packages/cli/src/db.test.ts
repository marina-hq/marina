import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createServer } from "node:net";
import { once } from "node:events";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { LocalDatabase } from "./dev/db.ts";
import { callDevDatabase, startDevControl } from "./dev/control.ts";

test("marina dev applies a new migration on reload and closes its database session on shutdown", async () => {
  const project = mkdtempSync(join(tmpdir(), "marina-dev-lifecycle-"));
  mkdirSync(join(project, "marina", "migrations"), { recursive: true });
  writeFileSync(
    join(project, "marina.json"),
    JSON.stringify({ schema: 1, entrypoint: "app.ts", runtime: { db: "v1" } }),
  );
  writeFileSync(
    join(project, "app.ts"),
    'export default { async fetch(request, marina) { return Response.json(await marina.db.query("select * from notes")); } };',
  );
  writeFileSync(
    join(project, "marina", "migrations", "001_notes.sql"),
    "create table notes (body text);",
  );
  const reservation = createServer();
  reservation.listen(0, "127.0.0.1");
  await once(reservation, "listening");
  const port = (reservation.address() as { port: number }).port;
  await new Promise<void>((done) => reservation.close(() => done()));
  const child = spawn(
    process.execPath,
    [resolve("dist/marina.mjs"), "dev", "--dir", project, "--port", String(port)],
    {
      env: {
        ...process.env,
        MARINA_TOKEN: "mar_test_only",
        MARINA_DISABLE_CONTROL_PLANE_DISCOVERY: "1",
        MARINA_DISABLE_UPDATE_CHECK: "1",
        NODE_OPTIONS: `--import=${resolve("src/mock-fetch.test-fixture.mjs")}`,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += String(chunk);
  });
  child.stderr.on("data", (chunk) => {
    output += String(chunk);
  });
  const exited = once(child, "exit");
  async function until(check: () => boolean) {
    for (let attempt = 0; attempt < 150; attempt++) {
      if (check()) return;
      if (child.exitCode !== null) throw new Error(output);
      await new Promise((done) => setTimeout(done, 100));
    }
    throw new Error(`development did not become ready: ${output}`);
  }
  try {
    await until(() => output.includes(`http://localhost:${port}`));
    writeFileSync(
      join(project, "marina", "migrations", "002_tags.sql"),
      "create table tags (name text);",
    );
    await until(() => output.includes("db: applied 002_tags.sql"));
    const tables = await callDevDatabase(project, { action: "tables" });
    assert.ok((tables.tables as { name: string }[]).some((table) => table.name === "tags"));
    await callDevDatabase(project, {
      action: "query",
      sql: "insert into notes values ('live')",
      write: true,
    });
    const live = (await (await fetch(`http://127.0.0.1:${port}/`)).json()) as { rows: unknown[] };
    assert.deepEqual(live.rows, [{ body: "live" }]);
    child.kill("SIGTERM");
    await exited;
    assert.equal(child.exitCode, 0, output);
    assert.equal(existsSync(join(project, ".marina", "dev", "control.json")), false);
    const reopened = await LocalDatabase.open(join(project, ".marina", "dev", "db"));
    try {
      assert.deepEqual((await reopened.query("select * from notes", [])).rows, [{ body: "live" }]);
    } finally {
      await reopened.close();
    }
  } finally {
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      await exited;
    }
    rmSync(project, { recursive: true, force: true });
  }
});

async function fixture() {
  const project = mkdtempSync(join(tmpdir(), "marina-db-inspection-"));
  const migrations = join(project, "marina", "migrations");
  mkdirSync(migrations, { recursive: true });
  writeFileSync(
    join(migrations, "001_notes.sql"),
    "create table notes (id serial primary key, body text not null);",
  );
  const db = await LocalDatabase.open(join(project, ".marina", "dev", "db"));
  await db.applyMigrations(project);
  const control = await startDevControl(project, () => db);
  return {
    project,
    migrations,
    db,
    async close() {
      await control.close();
      await db.close();
      rmSync(project, { recursive: true, force: true });
    },
  };
}

test("inspection reads the app's live database, bounds rows, and requires explicit writes", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  await f.db.query("insert into notes (body) values ($1), ($2)", ["one", "two"]);
  assert.deepEqual((await callDevDatabase(f.project, { action: "tables" })).tables, [
    { schema: "public", name: "notes", type: "BASE TABLE" },
  ]);
  const schema = await callDevDatabase(f.project, { action: "schema", table: "notes" });
  assert.equal((schema.columns as unknown[]).length, 2);
  assert.equal((schema.indexes as unknown[]).length, 1);
  const page = await callDevDatabase(f.project, {
    action: "query",
    sql: "select body from notes order by id",
    limit: 1,
  });
  assert.deepEqual(page, { rows: [{ body: "one" }], rowCount: 1, truncated: true });
  await assert.rejects(
    callDevDatabase(f.project, { action: "query", sql: "delete from notes" }),
    /read.only/,
  );
  await callDevDatabase(f.project, {
    action: "query",
    sql: "insert into notes (body) values ($1)",
    params: ["three"],
    write: true,
  });
  assert.deepEqual((await f.db.query("select count(*)::int as n from notes", [])).rows, [{ n: 3 }]);
  await assert.rejects(
    callDevDatabase(f.project, { action: "schema", table: "missing" }),
    /no local table/,
  );
  await assert.rejects(
    callDevDatabase(f.project, { action: "query", sql: "select 1", limit: 0 }),
    /limit/,
  );
});

test("inspection stops execution at the result boundary and preserves Postgres parameter types", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  // Evaluating a third row raises an error. A result slice after query() would
  // hit that error; bounded execution only asks Postgres for limit + 1 rows.
  const page = await f.db.inspect(
    "select case when n <= $1 then n else n / (n - n) end as value from generate_series(1, 1000000) n",
    [2],
    1,
    false,
  );
  assert.deepEqual(page, { rows: [{ value: 1 }], rowCount: 1, truncated: true });
  const typed = await f.db.inspect(
    "select $1::jsonb as data, $2::integer[] as ids, $3::date as day, null::integer as missing",
    [{ label: "hello" }, [2, 3], "2026-09-12"],
    10,
    false,
  );
  assert.deepEqual(typed.rows, [
    { data: { label: "hello" }, ids: [2, 3], day: "2026-09-12T00:00:00.000Z", missing: null },
  ]);
  const plan = await f.db.inspect("explain select * from notes", [], 1, false);
  assert.equal(plan.rows.length, 1);
  await assert.rejects(f.db.inspect("select 1 / 0", [], 1, false), /division by zero/);
  assert.deepEqual((await f.db.query("select 42 as recovered", [])).rows, [{ recovered: 42 }]);
});

test("bounded write results commit the complete statement and report affected rows without RETURNING", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const inserted = await f.db.inspect(
    "insert into notes(body) select 'note-' || n from generate_series(1, 100) n returning body",
    [],
    2,
    true,
  );
  assert.equal(inserted.rows.length, 2);
  assert.equal(inserted.rowCount, 2);
  assert.equal(inserted.truncated, true);
  assert.deepEqual((await f.db.query("select count(*)::int as count from notes", [])).rows, [
    { count: 100 },
  ]);
  assert.deepEqual(await f.db.inspect("delete from notes", [], 2, true), {
    rows: [],
    rowCount: 100,
    truncated: false,
  });
  assert.deepEqual(
    await f.db.inspect("create table copied as select n from generate_series(1, 3) n", [], 1, true),
    { rows: [], rowCount: 3, truncated: false },
  );
  assert.deepEqual((await f.db.query("select count(*)::int as count from copied", [])).rows, [
    { count: 3 },
  ]);
});

const notesAppSource = (column: string) =>
  `export default { async fetch(request, marina) { return Response.json(await marina.db.query("select ${column} from notes")); } };`;

test("reload validates the replacement before migrations and pauses after a partial migration failure", async (t) => {
  const f = await fixture();
  const { startDevHost } = await import("./dev/host.ts");
  let host: Awaited<ReturnType<typeof startDevHost>> | undefined;
  t.after(async () => {
    await host?.close();
    await f.close();
  });
  const { createDevBinding } = await import("./dev/binding.ts");
  const manifest = {
    entrypoint: "app.ts",
    runtime: { db: "v1" as const },
    capabilities: [],
    connections: {},
    jobs: {},
  };
  writeFileSync(join(f.project, "app.ts"), notesAppSource("body"));
  await f.db.query("insert into notes(body) values ('kept')", []);
  host = await startDevHost({
    projectDir: f.project,
    buildDir: join(f.project, ".marina", "dev", "build"),
    manifest,
    port: 0,
    binding: createDevBinding({
      manifest,
      database: f.db,
      storage: null,
      jobs: null,
      bridge: { apiUrl: "https://api.example.test", token: "unused" },
    }),
    identity: {
      userId: "test-user",
      workspaceId: "test-workspace",
      userLabel: "dev@example.test",
      appName: "Reload test",
    },
    log: () => {},
    beforeReload: async () => {
      await f.db.applyMigrations(f.project);
    },
  });
  const response = () => host!.fetchApp(new Request("http://localhost/"));
  writeFileSync(join(f.project, "app.ts"), "export default broken syntax;");
  writeFileSync(
    join(f.migrations, "002_rename.sql"),
    "alter table notes rename column body to note;",
  );
  await assert.rejects(host.rebuild(), /Build failed/);
  assert.deepEqual(await (await response()).json(), { rows: [{ body: "kept" }], rowCount: 1 });
  assert.equal((await f.db.migrations(f.project))[1]?.status, "pending");

  writeFileSync(join(f.project, "app.ts"), notesAppSource("note"));
  await host.rebuild();
  assert.deepEqual(await (await response()).json(), { rows: [{ note: "kept" }], rowCount: 1 });
  writeFileSync(join(f.migrations, "003_drop.sql"), "alter table notes drop column note;");
  writeFileSync(join(f.migrations, "004_restore.sql"), "invalid migration;");
  await assert.rejects(host.rebuild(), /syntax error/);
  assert.equal((await response()).status, 503);
  writeFileSync(
    join(f.migrations, "004_restore.sql"),
    "alter table notes add column note text default 'restored';",
  );
  await host.rebuild();
  assert.deepEqual(await (await response()).json(), { rows: [{ note: "restored" }], rowCount: 1 });
});

test("migration status, apply, and reset share the running database and preserve file storage", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const storage = join(f.project, ".marina", "dev", "storage");
  mkdirSync(storage);
  writeFileSync(join(storage, "keep.txt"), "keep");
  await f.db.query("insert into notes (body) values ('keep until reset')", []);
  writeFileSync(join(f.migrations, "002_tags.sql"), "create table tags (name text primary key);");
  let status = await callDevDatabase(f.project, { action: "migrations" });
  assert.deepEqual(
    (status.migrations as { status: string }[]).map((row) => row.status),
    ["applied", "pending"],
  );
  assert.deepEqual(await callDevDatabase(f.project, { action: "migrate" }), {
    applied: ["002_tags.sql"],
  });
  await assert.rejects(callDevDatabase(f.project, { action: "reset" }), /--yes/);
  assert.equal((await f.db.query("select * from notes", [])).rowCount, 1);
  assert.deepEqual(await callDevDatabase(f.project, { action: "reset", yes: true }), {
    applied: ["001_notes.sql", "002_tags.sql"],
  });
  assert.equal((await f.db.query("select * from notes", [])).rowCount, 0);
  assert.equal(readFileSync(join(storage, "keep.txt"), "utf8"), "keep");
  // Runtime calls still hold this exact object after reset.
  await f.db.query("insert into tags values ('after reset')", []);
  status = await callDevDatabase(f.project, { action: "migrations" });
  assert.deepEqual(
    (status.migrations as { status: string }[]).map((row) => row.status),
    ["applied", "applied"],
  );
});

test("the control channel refuses browser and unauthenticated requests and a second dev owner", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const path = join(f.project, ".marina", "dev", "control.json");
  assert.equal(statSync(path).mode & 0o777, 0o600);
  const session = JSON.parse(readFileSync(path, "utf8")) as { port: number; token: string };
  const url = `http://127.0.0.1:${session.port}/db`;
  const body = JSON.stringify({ action: "tables" });
  assert.equal((await fetch(url, { method: "POST", body })).status, 403);
  assert.equal(
    (
      await fetch(url, {
        method: "POST",
        body,
        headers: {
          authorization: `Bearer ${session.token}`,
          origin: "https://example.test",
        },
      })
    ).status,
    403,
  );
  await assert.rejects(
    startDevControl(f.project, () => f.db),
    /already running/,
  );
  assert.ok((await callDevDatabase(f.project, { action: "tables" })).tables);
});

test("the installed CLI returns one JSON result without login or control-plane discovery", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const cli = resolve("dist/marina.mjs");
  const env = {
    ...process.env,
    MARINA_HOME: join(f.project, "empty-profile"),
    MARINA_TOKEN: "",
    MARINA_API: "http://127.0.0.1:1",
    MARINA_DISABLE_CONTROL_PLANE_DISCOVERY: "0",
  };
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [
      cli,
      "db",
      "query",
      "select $1::text as value",
      "--params",
      '["hello"]',
      "--dir",
      f.project,
      "--json",
    ],
    { env },
  );
  assert.deepEqual(JSON.parse(stdout), {
    schema_version: 1,
    ok: true,
    command: "db.query",
    environment: "local",
    rows: [{ value: "hello" }],
    rowCount: 1,
    truncated: false,
  });
  assert.equal(existsSync(join(f.project, "empty-profile", "profile")), false);
});
