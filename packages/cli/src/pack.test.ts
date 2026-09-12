import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { unzipSync } from "fflate";
import { buildOutputParent, pack } from "./pack.ts";

describe("build output guard", () => {
  const project = () => {
    const directory = mkdtempSync(join(tmpdir(), "marina-pack-test-"));
    writeFileSync(
      join(directory, "package.json"),
      JSON.stringify({ scripts: { build: "vite build" } }),
    );
    mkdirSync(join(directory, "dist"));
    writeFileSync(join(directory, "dist", "index.html"), "<h1>built</h1>");
    return directory;
  };

  it("names the project that produced a conventional output directory", () => {
    const directory = project();
    try {
      assert.equal(buildOutputParent(join(directory, "dist")), realpathSync(directory));
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("sees through symlink aliases to the real output directory", () => {
    const directory = project();
    try {
      symlinkSync(join(directory, "dist"), join(directory, "site"));
      assert.equal(buildOutputParent(join(directory, "site")), realpathSync(directory));
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("keeps the deployed name's intent when dist links to output named otherwise", () => {
    const directory = mkdtempSync(join(tmpdir(), "marina-pack-test-"));
    try {
      writeFileSync(
        join(directory, "package.json"),
        JSON.stringify({ scripts: { build: "vite build" } }),
      );
      mkdirSync(join(directory, "outbucket", "generated-site"), { recursive: true });
      writeFileSync(join(directory, "outbucket", "generated-site", "index.html"), "<h1>built</h1>");
      symlinkSync(join(directory, "outbucket", "generated-site"), join(directory, "dist"));
      assert.equal(buildOutputParent(join(directory, "dist")), directory);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("leaves projects that are themselves packages alone", () => {
    const directory = project();
    try {
      writeFileSync(join(directory, "dist", "package.json"), "{}");
      assert.equal(buildOutputParent(join(directory, "dist")), null);
      assert.equal(buildOutputParent(directory), null);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("requires a parent build declaration, not just the directory name", () => {
    const directory = mkdtempSync(join(tmpdir(), "marina-pack-test-"));
    try {
      mkdirSync(join(directory, "dist"));
      writeFileSync(join(directory, "dist", "index.html"), "<h1>hand-made</h1>");
      assert.equal(buildOutputParent(join(directory, "dist")), null);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("deployment archive", () => {
  it("keeps npm registry credentials on the developer machine", () => {
    const directory = mkdtempSync(join(tmpdir(), "marina-pack-test-"));
    try {
      writeFileSync(join(directory, "index.html"), "<h1>safe</h1>");
      writeFileSync(join(directory, ".npmrc"), "//registry.npmjs.org/:_authToken=secret");

      const packed = pack(directory);

      assert.deepEqual(Object.keys(unzipSync(packed.zip)), ["index.html"]);
      assert.deepEqual(packed.skippedSecrets, [".npmrc"]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("honors root and nested gitignore rules", () => {
    const directory = mkdtempSync(join(tmpdir(), "marina-pack-test-"));
    try {
      mkdirSync(join(directory, "cache"));
      mkdirSync(join(directory, "nested", "deeper"), { recursive: true });
      writeFileSync(join(directory, ".gitignore"), "*.log\ncache/\n");
      writeFileSync(join(directory, "index.html"), "<h1>safe</h1>");
      writeFileSync(join(directory, "root.log"), "ignored");
      writeFileSync(join(directory, "cache", "asset.txt"), "ignored");
      writeFileSync(join(directory, "nested", ".gitignore"), "!keep.log\n/only-here.txt\n");
      writeFileSync(join(directory, "nested", "drop.log"), "ignored");
      writeFileSync(join(directory, "nested", "keep.log"), "included");
      writeFileSync(join(directory, "nested", "only-here.txt"), "ignored");
      writeFileSync(join(directory, "nested", "deeper", "only-here.txt"), "included");

      const packed = pack(directory);

      assert.deepEqual(Object.keys(unzipSync(packed.zip)).toSorted(), [
        ".gitignore",
        "index.html",
        "nested/.gitignore",
        "nested/deeper/only-here.txt",
        "nested/keep.log",
      ]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("never deploys Marina project metadata or local runtime state", () => {
    const directory = mkdtempSync(join(tmpdir(), "marina-pack-test-"));
    try {
      mkdirSync(join(directory, ".marina", "dev", "storage"), { recursive: true });
      writeFileSync(join(directory, "index.html"), "<h1>safe</h1>");
      writeFileSync(join(directory, ".marina", "project.json"), '{"app":"safe"}');
      writeFileSync(join(directory, ".marina", "dev", "storage", "note.txt"), "private");

      assert.deepEqual(Object.keys(unzipSync(pack(directory).zip)), ["index.html"]);

      // User ignore rules cannot opt CLI-owned state back into the archive.
      writeFileSync(join(directory, ".gitignore"), "!.marina/\n!.marina/**\n");
      assert.deepEqual(Object.keys(unzipSync(pack(directory).zip)).toSorted(), [
        ".gitignore",
        "index.html",
      ]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
