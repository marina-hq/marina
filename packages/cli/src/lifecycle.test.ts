import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { after, before, describe, it } from "node:test";
import { mkdtempSync } from "node:fs";

const temporary = mkdtempSync(join(tmpdir(), "marina-cli-test-"));
const marinaHome = join(temporary, "marina");
const codexHome = join(temporary, "codex");
const claudeHome = join(temporary, "claude");
const binary = resolve("dist/marina.mjs");

function run(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const execution = spawnSync(process.execPath, [binary, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      MARINA_HOME: marinaHome,
      CODEX_HOME: codexHome,
      CLAUDE_CONFIG_DIR: claudeHome,
      MARINA_DISABLE_UPDATE_CHECK: "1",
    },
  });
  return { status: execution.status, stdout: execution.stdout, stderr: execution.stderr };
}

const json = (value: string) => JSON.parse(value) as Record<string, unknown>;

describe("CLI profile and skill lifecycle", () => {
  before(() => mkdirSync(codexHome, { recursive: true }));
  after(() => rmSync(temporary, { recursive: true, force: true }));

  it("never installs a skill unless explicitly requested", () => {
    const execution = run(["profile", "--json"]);
    assert.equal(execution.status, 0, execution.stderr);
    assert.equal(json(execution.stdout).signed_in, false);

    const installed = join(codexHome, "skills", "marina-deploy", "SKILL.md");
    assert.equal(existsSync(installed), false);
  });

  it("stores and removes a permission-locked profile credential", () => {
    const setup = run(["setup", "--token", "mar_test_only", "--json"]);
    assert.equal(setup.status, 0, setup.stderr);
    assert.equal(json(setup.stdout).signed_in, true);

    const profilePath = join(marinaHome, "profile");
    assert.equal((statSync(profilePath).mode & 0o777).toString(8), "600");
    assert.equal(JSON.parse(readFileSync(profilePath, "utf8")).token, "mar_test_only");
    assert.doesNotMatch(setup.stdout, /mar_test_only/);

    const logout = run(["logout", "--json"]);
    assert.equal(logout.status, 0, logout.stderr);
    assert.equal(json(logout.stdout).signed_in, false);
    assert.equal(existsSync(profilePath), false);
  });

  it("can explicitly install the skill for every supported agent", () => {
    const execution = run(["skills", "install", "--agent", "all", "--json"]);
    assert.equal(execution.status, 0, execution.stderr);
    assert.equal((json(execution.stdout).skills as unknown[]).length, 2);
    assert.equal(existsSync(join(claudeHome, "skills", "marina-deploy", "SKILL.md")), true);
    assert.equal(
      existsSync(join(codexHome, "skills", "marina-deploy", "agents", "openai.yaml")),
      true,
    );
    assert.equal(
      readFileSync(join(codexHome, "skills", "marina-deploy", "SKILL.md"), "utf8"),
      readFileSync(resolve("../../skills/marina-deploy/SKILL.md"), "utf8"),
    );
  });
});
