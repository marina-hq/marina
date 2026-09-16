import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { zipSync } from "fflate";
import type { AppSource } from "./api.ts";
import { readLink, writeLink } from "./config.ts";
import {
  acceptDeployedSource,
  assertNoPendingPull,
  checkProjectContext,
  checkoutSource,
  continuePull,
  pullSource,
  resolveSourceTarget,
} from "./handoff.ts";
import { unpackSource } from "./source-archive.ts";
import { pack } from "./pack.ts";

const roots: string[] = [];
const root = () => {
  const dir = mkdtempSync(join(tmpdir(), "marina-handoff-test-"));
  roots.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const appId = randomUUID();
const workspaceId = randomUUID();
const text = (dir: string, name: string) => readFileSync(join(dir, name), "utf8");
function source(files: Record<string, string>, number = 1) {
  const zip = zipSync(
    Object.fromEntries(
      Object.entries(files).map(([name, value]) => [name, new TextEncoder().encode(value)]),
    ),
  );
  const metadata: AppSource = {
    app: { id: appId, slug: "orders", name: "Orders" },
    workspace: { id: workspaceId, slug: "acme", name: "Acme" },
    revision: number.toString(16).padStart(64, "0"),
    editable_revision: number.toString(16).padStart(64, "0"),
    snapshot_digest: `sha256:${createHash("sha256").update(zip).digest("hex")}`,
    live_version: { id: randomUUID(), number: 1 },
    unpublished_changes: number > 1,
    dashboard_url: "https://marina.cloud/acme/apps/orders",
    archive_url: "/unused",
  };
  return { zip, metadata };
}
function checkout(files: Record<string, string>) {
  const initial = source(files);
  const dir = join(root(), "app");
  checkoutSource(initial.metadata, initial.zip, dir);
  return { dir, initial };
}

test("checkout binds immutable identity, caches the exact archive and does not execute scripts", () => {
  const { dir, initial } = checkout({
    "index.html": "hello",
    "package.json": '{"scripts":{"postinstall":"exit 1"}}',
  });
  assert.equal(text(dir, "index.html"), "hello");
  assert.equal(readLink(dir)?.app_id, appId);
  assert.equal(readLink(dir)?.workspace_id, workspaceId);
  assert.deepEqual(readFileSync(join(dir, ".marina/source/base.zip")), Buffer.from(initial.zip));
  assert.deepEqual([...unpackSource(pack(dir).zip).keys()].toSorted(), [
    "index.html",
    "package.json",
  ]);
  assert.throws(() => checkoutSource(initial.metadata, initial.zip, dir), /new or empty/);
});

test("corrupt archives and destinations with symlinks leave existing files intact", () => {
  const dir = root();
  const incoming = source({ "index.html": "hello" });
  assert.throws(
    () => checkoutSource(incoming.metadata, new Uint8Array([1]), join(dir, "new")),
    /digest/,
  );
  const linked = join(dir, "alias");
  const real = join(dir, "real");
  mkdirSync(real);
  symlinkSync(real, linked);
  assert.throws(() => checkoutSource(incoming.metadata, incoming.zip, linked), /new or empty/);
  assert.deepEqual(readdirSync(real), []);
});

test("pull merges independent files and preserves local-only files and database state", () => {
  const { dir } = checkout({ "a.txt": "one", "b.txt": "two", "gone.txt": "old" });
  writeFileSync(join(dir, "a.txt"), "my change");
  writeFileSync(join(dir, "notes.txt"), "private scratch");
  mkdirSync(join(dir, ".marina/dev"));
  writeFileSync(join(dir, ".marina/dev/db"), "local rows");
  const incoming = source({ "a.txt": "one", "b.txt": "remote change", "new.txt": "added" }, 2);
  assert.equal(pullSource(dir, incoming.metadata, incoming.zip).status, "updated");
  assert.equal(text(dir, "a.txt"), "my change");
  assert.equal(text(dir, "b.txt"), "remote change");
  assert.equal(text(dir, "notes.txt"), "private scratch");
  assert.equal(text(dir, ".marina/dev/db"), "local rows");
  assert.equal(readLink(dir)?.base_revision, incoming.metadata.revision);
  assert.throws(() => text(dir, "gone.txt"), /ENOENT/);
});

test("conflicts retain all versions, block deploy, and continue after explicit reconciliation", () => {
  const { dir } = checkout({ "a.txt": "base", "b.txt": "base b", "deleted.txt": "base delete" });
  writeFileSync(join(dir, "a.txt"), "local");
  writeFileSync(join(dir, "deleted.txt"), "edited locally");
  const incoming = source({ "a.txt": "incoming", "b.txt": "incoming b" }, 2);
  const pulled = pullSource(dir, incoming.metadata, incoming.zip);
  assert.equal(pulled.status, "conflicts");
  assert.equal(pulled.conflicts.length, 2);
  assert.equal(text(dir, "b.txt"), "base b");
  const conflict = pulled.conflicts.find((c) => c.path === "a.txt")!;
  assert.equal(readFileSync(conflict.base!, "utf8"), "base");
  assert.equal(readFileSync(conflict.local!, "utf8"), "local");
  assert.equal(readFileSync(conflict.incoming!, "utf8"), "incoming");
  assert.equal(pulled.conflicts.find((c) => c.path === "deleted.txt")!.incoming, null);
  assert.throws(() => assertNoPendingPull(dir), /reconciliation/);
  writeFileSync(join(dir, "a.txt"), "combined");
  unlinkSync(join(dir, "deleted.txt"));
  assert.equal(continuePull(dir).status, "updated");
  assert.equal(text(dir, "a.txt"), "combined");
  assert.equal(text(dir, "b.txt"), "incoming b");
  assertNoPendingPull(dir);
  assert.equal(pullSource(dir, incoming.metadata, incoming.zip).status, "up_to_date");
});

test("an incoming new file never overwrites an untracked local file", () => {
  const { dir } = checkout({ "index.html": "same" });
  writeFileSync(join(dir, "new.txt"), "local draft");
  const incoming = source({ "index.html": "same", "new.txt": "remote draft" }, 2);
  const pulled = pullSource(dir, incoming.metadata, incoming.zip);
  assert.equal(pulled.conflicts[0]?.base, null);
  assert.equal(text(dir, "new.txt"), "local draft");
});

test("local symlinks and parent obstructions cannot redirect a pull outside the project", () => {
  const { dir } = checkout({ "folder/a.txt": "old" });
  const outside = root();
  writeFileSync(join(outside, "a.txt"), "protected");
  rmSync(join(dir, "folder"), { recursive: true });
  symlinkSync(outside, join(dir, "folder"));
  const incoming = source({ "folder/a.txt": "new" }, 2);
  assert.throws(() => pullSource(dir, incoming.metadata, incoming.zip), /safely access/);
  assert.equal(text(outside, "a.txt"), "protected");
});

test("an interrupted apply resumes completed writes and keeps later edits safe", () => {
  const { dir } = checkout({ "conflict.txt": "base", "one.txt": "base", "two.txt": "base" });
  writeFileSync(join(dir, "conflict.txt"), "local");
  const incoming = source(
    { "conflict.txt": "remote", "one.txt": "remote", "two.txt": "remote" },
    2,
  );
  pullSource(dir, incoming.metadata, incoming.zip);
  // Simulate interruption after the plan was accepted and its first write made it to disk.
  const planPath = join(dir, ".marina/source/pending/plan.json");
  const plan = JSON.parse(readFileSync(planPath, "utf8"));
  plan.phase = "applying";
  writeFileSync(planPath, JSON.stringify(plan));
  writeFileSync(join(dir, "one.txt"), "remote");
  writeFileSync(join(dir, "two.txt"), "new local edit after interruption");
  assert.throws(() => continuePull(dir), /changed during source recovery/);
  assert.equal(text(dir, "two.txt"), "new local edit after interruption");
  writeFileSync(join(dir, "two.txt"), "base");
  assert.equal(continuePull(dir).status, "updated");
  assert.equal(text(dir, "one.txt"), "remote");
  assert.equal(text(dir, "two.txt"), "remote");
  assert.equal(text(dir, "conflict.txt"), "local");
});

test("post-deploy baseline uses canonical prepared source and preserves concurrent edits", () => {
  const { dir, initial } = checkout({ "index.html": "before", "local.txt": "before" });
  const canonical = source({ "index.html": "prepared", "local.txt": "before" }, 2);
  writeFileSync(join(dir, "local.txt"), "edited during deploy");
  assert.equal(
    acceptDeployedSource(dir, canonical.metadata, canonical.zip, initial.zip).status,
    "updated",
  );
  assert.equal(text(dir, "index.html"), "prepared");
  assert.equal(text(dir, "local.txt"), "edited during deploy");
  assert.deepEqual(readFileSync(join(dir, ".marina/source/base.zip")), Buffer.from(canonical.zip));
});

test("server transformations conflicting with edits made during deploy need explicit resolution", () => {
  const { dir, initial } = checkout({ "index.html": "before" });
  writeFileSync(join(dir, "index.html"), "local after submission");
  const canonical = source({ "index.html": "prepared" }, 2);
  assert.equal(
    acceptDeployedSource(dir, canonical.metadata, canonical.zip, initial.zip).status,
    "conflicts",
  );
  assert.equal(text(dir, "index.html"), "local after submission");
  assert.equal(readLink(dir)?.base_revision, initial.metadata.revision);
});

test("bound projects refuse another control plane, workspace, and explicit app", async () => {
  const { dir } = checkout({ "index.html": "hi" });
  const link = readLink(dir)!;
  writeLink(dir, { ...link, api_origin: "https://somewhere.invalid" });
  await assert.rejects(checkProjectContext(dir), /belongs to/);
  writeLink(dir, link);
  await assert.rejects(checkProjectContext(dir, "another-app"), /different app/);
  const previous = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ workspace: { id: randomUUID(), slug: "other" } });
  const token = process.env.MARINA_TOKEN;
  process.env.MARINA_TOKEN = "fictional-test-token";
  try {
    await assert.rejects(checkProjectContext(dir), /workspace/);
    await assert.rejects(resolveSourceTarget("https://marina.cloud/acme/apps/orders"), /workspace/);
    await assert.rejects(
      resolveSourceTarget("https://unknown.invalid/acme/apps/orders"),
      /dashboard URL/,
    );
  } finally {
    globalThis.fetch = previous;
    if (token) process.env.MARINA_TOKEN = token;
    else delete process.env.MARINA_TOKEN;
  }
});

test("archives reject traversal, reserved paths, case collisions, symlinks and size lies", () => {
  for (const files of [
    { "../outside": "bad" },
    { ".marina/project.json": "bad" },
    { "node_modules/a": "bad" },
    { "A.txt": "a", "a.txt": "b" },
    { a: "file", "a/b": "collision" },
  ] as Record<string, string>[]) {
    assert.throws(() => unpackSource(source(files).zip));
  }
  const linked = source({ "file.txt": "link" }).zip;
  const view = new DataView(linked.buffer, linked.byteOffset, linked.byteLength);
  for (let i = 0; i < linked.length - 46; i++)
    if (view.getUint32(i, true) === 0x02014b50) {
      view.setUint32(i + 38, 0xa1ff0000, true);
      break;
    }
  assert.throws(() => unpackSource(linked), /link or special/);
  const bomb = source({ "file.txt": "test" }).zip;
  const bombView = new DataView(bomb.buffer, bomb.byteOffset, bomb.byteLength);
  for (let i = 0; i < bomb.length - 46; i++)
    if (bombView.getUint32(i, true) === 0x02014b50) {
      bombView.setUint32(i + 24, 200 * 1024 * 1024, true);
      break;
    }
  assert.throws(() => unpackSource(bomb), /beyond its limit/);
});

test("a case-only rename cannot delete its own incoming file on a case-insensitive filesystem", () => {
  const { dir } = checkout({ "Name.txt": "keep me" });
  const incoming = source({ "name.txt": "keep me" }, 2);
  assert.throws(() => pullSource(dir, incoming.metadata, incoming.zip), /source renames/);
  assert.equal(text(dir, "Name.txt"), "keep me");
});

test("a baseline advanced while deployment was running is never rewound", () => {
  const { dir, initial } = checkout({ "index.html": "one" });
  const expected = readLink(dir);
  const newer = source({ "index.html": "three" }, 3);
  pullSource(dir, newer.metadata, newer.zip);
  const deployed = source({ "index.html": "two" }, 2);
  assert.throws(
    () => acceptDeployedSource(dir, deployed.metadata, deployed.zip, initial.zip, expected),
    /baseline changed during deployment/,
  );
  assert.equal(readLink(dir)?.base_revision, newer.metadata.revision);
  assert.equal(text(dir, "index.html"), "three");
});
