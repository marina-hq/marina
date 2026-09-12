import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { DEMO_MANIFEST } from "./demo-manifest.ts";
import { isNewerVersion } from "./update.ts";

const demoDir = resolve(dirname(fileURLToPath(import.meta.url)), "../demo");

describe("bundled Hello Marina demo", () => {
  it("has a stable app identity", () => {
    assert.deepEqual(DEMO_MANIFEST, {
      schema: 1,
      name: "Hello Marina",
      icon: "⛵",
    });
  });

  it("contains a self-contained browser app", () => {
    const html = readFileSync(resolve(demoDir, "index.html"), "utf8");
    const css = readFileSync(resolve(demoDir, "styles.css"), "utf8");
    const script = readFileSync(resolve(demoDir, "app.js.txt"), "utf8");
    assert.match(html, /<title>Hello Marina<\/title>/);
    assert.match(html, /href="styles\.css"/);
    assert.match(html, /src="app\.js"/);
    assert.match(css, /font-family: Inter/);
    assert.doesNotThrow(() => new Function(script));
  });
});

describe("version checks", () => {
  it("only reports a newer stable version", () => {
    assert.equal(isNewerVersion("0.2.0", "0.1.9"), true);
    assert.equal(isNewerVersion("1.0.0", "1.0.0"), false);
    assert.equal(isNewerVersion("1.9.0", "2.0.0"), false);
    assert.equal(isNewerVersion("invalid", "1.0.0"), false);
  });
});
