import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { readManifest, resolveAppName } from "./manifest.ts";

function project(): string {
  return mkdtempSync(join(tmpdir(), "marina-manifest-"));
}

describe("marina.json", () => {
  it("wins over package.json while --name remains an explicit override", () => {
    const dir = project();
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "package-name" }));
    writeFileSync(join(dir, "marina.json"), JSON.stringify({ schema: 1, name: "Manifest Name" }));
    const manifest = readManifest(dir);
    assert.equal(resolveAppName(dir, undefined, manifest), "Manifest Name");
    assert.equal(resolveAppName(dir, "Flag Name", manifest), "Flag Name");
  });

  it("rejects unsupported schemas and non-emoji icons", () => {
    const dir = project();
    writeFileSync(join(dir, "marina.json"), JSON.stringify({ schema: 2 }));
    assert.throws(() => readManifest(dir), /schema/);
    writeFileSync(join(dir, "marina.json"), JSON.stringify({ icon: "not-an-emoji" }));
    assert.throws(() => readManifest(dir), /icon/);
  });

  it("accepts legacy execution hints without exposing them", () => {
    const dir = project();
    writeFileSync(
      join(dir, "marina.json"),
      JSON.stringify({ schema: 1, name: "Legacy App", type: "dynamic" }),
    );
    const manifest = readManifest(dir);
    assert.equal(manifest?.name, "Legacy App");
    assert.equal(manifest === null ? false : "type" in manifest, false);
  });
});
