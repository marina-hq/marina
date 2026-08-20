import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
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

function run(
  args: string[],
  environment: Record<string, string | undefined> = {},
): { status: number | null; stdout: string; stderr: string } {
  const execution = spawnSync(process.execPath, [binary, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      MARINA_HOME: marinaHome,
      CODEX_HOME: codexHome,
      CLAUDE_CONFIG_DIR: claudeHome,
      MARINA_DISABLE_UPDATE_CHECK: "1",
      MARINA_DISABLE_CONTROL_PLANE_DISCOVERY: "1",
      ...environment,
    },
  });
  return { status: execution.status, stdout: execution.stdout, stderr: execution.stderr };
}

const json = (value: string) => JSON.parse(value) as Record<string, unknown>;

describe("CLI profile and skill lifecycle", () => {
  before(() => {
    mkdirSync(marinaHome, { recursive: true });
    mkdirSync(codexHome, { recursive: true });
  });
  after(() => rmSync(temporary, { recursive: true, force: true }));

  it("never installs a skill unless explicitly requested", () => {
    const execution = run(["profile", "--json"]);
    assert.equal(execution.status, 0, execution.stderr);
    assert.equal(json(execution.stdout).signed_in, false);

    const installed = join(codexHome, "skills", "marina-deploy", "SKILL.md");
    assert.equal(existsSync(installed), false);
  });

  it("reads and removes a permission-locked profile credential", () => {
    const profilePath = join(marinaHome, "profile");
    writeFileSync(
      profilePath,
      `${JSON.stringify({ api: "https://marina.cloud", token: "mar_test_only" })}\n`,
      { mode: 0o600 },
    );
    assert.equal((statSync(profilePath).mode & 0o777).toString(8), "600");
    const profile = run(["profile", "--json"]);
    assert.equal(profile.status, 0, profile.stderr);
    assert.equal(json(profile.stdout).signed_in, true);
    assert.equal(json(profile.stdout).api, "https://marina.cloud");
    assert.doesNotMatch(profile.stdout, /mar_test_only/);

    const logout = run(["logout", "--json"]);
    assert.equal(logout.status, 0, logout.stderr);
    assert.equal(json(logout.stdout).signed_in, false);
    assert.equal(existsSync(profilePath), false);
  });

  it("uses the hidden profile control plane and scopes its credential", () => {
    const profilePath = join(marinaHome, "profile");
    writeFileSync(
      profilePath,
      `${JSON.stringify({
        control_plane_host: "https://staging.marina.cloud",
        control_plane: {
          host: "https://staging.marina.cloud",
          checked_at: new Date().toISOString(),
          api_url: "https://marina-staging-api.example.run.app",
          dashboard_url: "https://staging.marina.cloud",
          latest_cli_version: null,
        },
        api: "https://marina-staging-api.example.run.app",
        token: "mar_staging_only",
      })}\n`,
    );

    const staging = run(["profile", "--json"]);
    assert.equal(staging.status, 0, staging.stderr);
    assert.equal(json(staging.stdout).api, "https://marina-staging-api.example.run.app");
    assert.equal(json(staging.stdout).signed_in, true);

    const production = run(["profile", "--json"], { MARINA_API: "https://marina.cloud" });
    assert.equal(production.status, 0, production.stderr);
    assert.equal(json(production.stdout).api, "https://marina.cloud");
    assert.equal(json(production.stdout).signed_in, false);
  });

  it("can set up skills and deploy the demo as one JSON command", () => {
    writeFileSync(join(marinaHome, "profile"), "{}\n");
    const fixture = resolve("src/mock-fetch.test-fixture.mjs");
    const setup = run(["setup", "--skills", "--deploy-demo", "--json"], {
      MARINA_TOKEN: "mar_test_only",
      MARINA_DISABLE_CONTROL_PLANE_DISCOVERY: "0",
      NODE_OPTIONS: `--import=${fixture}`,
    });
    assert.equal(setup.status, 0, setup.stderr);
    const payload = json(setup.stdout);
    assert.equal(payload.command, "setup");
    assert.equal(payload.signed_in, true);
    assert.equal(payload.api, "https://marina-direct-api.example.run.app");
    assert.equal((payload.skills as unknown[]).length, 1);
    assert.equal((payload.deploy as Record<string, unknown>).demo, true);
    assert.equal((payload.deploy as Record<string, unknown>).live, true);
  });

  it("shows the discovered update notice at most once per day", () => {
    writeFileSync(
      join(marinaHome, "profile"),
      `${JSON.stringify({
        control_plane: {
          host: "https://marina.cloud",
          checked_at: new Date().toISOString(),
          api_url: "https://marina-direct-api.example.run.app",
          dashboard_url: "https://marina.cloud",
          latest_cli_version: "99.0.0",
        },
      })}\n`,
    );
    const environment = { MARINA_DISABLE_UPDATE_CHECK: "" };
    const first = run(["profile", "--json"], environment);
    assert.match(first.stderr, /Marina CLI 99\.0\.0 is available/);
    const second = run(["profile", "--json"], environment);
    assert.doesNotMatch(second.stderr, /is available/);
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
