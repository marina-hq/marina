import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import skillMarkdown from "../../../skills/marina-deploy/SKILL.md";
import openaiMetadata from "../../../skills/marina-deploy/agents/openai.yaml";

export type AgentName = "codex" | "claude";

interface SkillTarget {
  agent: AgentName;
  home: string;
}

export interface SkillInstallResult {
  agent: AgentName;
  path: string;
  status: "installed" | "updated" | "current";
}

const homes = (): Record<AgentName, string> => ({
  codex: process.env.CODEX_HOME ?? join(homedir(), ".codex"),
  claude: process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"),
});

function targets(agent?: string): SkillTarget[] {
  const agentHomes = homes();
  if (agent && agent !== "all" && agent !== "codex" && agent !== "claude") {
    throw new Error("--agent must be codex, claude, or all");
  }
  if (agent === "all") {
    return (Object.entries(agentHomes) as [AgentName, string][]).map(([name, home]) => ({
      agent: name,
      home,
    }));
  }
  if (agent === "codex" || agent === "claude") return [{ agent, home: agentHomes[agent] }];
  return (Object.entries(agentHomes) as [AgentName, string][])
    .filter(([, home]) => existsSync(home))
    .map(([name, home]) => ({ agent: name, home }));
}

function install(target: SkillTarget, update: boolean): SkillInstallResult | null {
  const directory = join(target.home, "skills", "marina-deploy");
  const skillPath = join(directory, "SKILL.md");
  const existing = (() => {
    try {
      return readFileSync(skillPath, "utf8");
    } catch {
      return null;
    }
  })();
  if (existing === skillMarkdown)
    return { agent: target.agent, path: directory, status: "current" };
  if (existing !== null && !update) return null;

  mkdirSync(directory, { recursive: true });
  writeFileSync(skillPath, skillMarkdown);
  if (target.agent === "codex") {
    const agentsDirectory = join(directory, "agents");
    mkdirSync(agentsDirectory, { recursive: true });
    writeFileSync(join(agentsDirectory, "openai.yaml"), openaiMetadata);
  }
  return {
    agent: target.agent,
    path: directory,
    status: existing === null ? "installed" : "updated",
  };
}

/** Install only missing skills into agent homes that already exist. */
export function autoInstallSkills(): {
  detected: AgentName[];
  installed: SkillInstallResult[];
  updatesAvailable: AgentName[];
} {
  const detectedTargets = targets();
  const installed: SkillInstallResult[] = [];
  const updatesAvailable: AgentName[] = [];
  for (const target of detectedTargets) {
    const result = install(target, false);
    if (result) installed.push(result);
    else updatesAvailable.push(target.agent);
  }
  return {
    detected: detectedTargets.map((target) => target.agent),
    installed,
    updatesAvailable,
  };
}

/** Explicit installation also replaces an older Marina-managed skill. */
export function installSkills(agent?: string): SkillInstallResult[] {
  const selected = targets(agent);
  if (selected.length === 0) {
    throw new Error("no Codex or Claude installation detected; pass --agent codex, claude, or all");
  }
  return selected.map((target) => install(target, true)!);
}
