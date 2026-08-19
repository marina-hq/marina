import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface MarinaProfile {
  api?: string;
  token?: string;
  update?: {
    checked_at: string;
    latest: string;
  };
}

const MARINA_HOME = process.env.MARINA_HOME ?? join(homedir(), ".marina");
const PROFILE = join(MARINA_HOME, "profile");

export const apiUrl = (): string =>
  (process.env.MARINA_API ?? "https://v1.marina.cloud").replace(/\/$/, "");

export const dashboardUrl = (): string => {
  if (process.env.MARINA_DASHBOARD) return process.env.MARINA_DASHBOARD.replace(/\/$/, "");
  const api = new URL(apiUrl());
  return api.hostname === "localhost" || api.hostname === "127.0.0.1"
    ? "http://localhost:5173"
    : api.origin;
};

export const profilePath = (): string => PROFILE;

export function readProfile(): MarinaProfile {
  try {
    return JSON.parse(readFileSync(PROFILE, "utf8")) as MarinaProfile;
  } catch {
    return {};
  }
}

export function writeProfile(profile: MarinaProfile): void {
  mkdirSync(MARINA_HOME, { recursive: true, mode: 0o700 });
  const temporary = `${PROFILE}.${String(process.pid)}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(profile, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, PROFILE);
  chmodSync(PROFILE, 0o600);
}

export function getToken(): string | null {
  if (process.env.MARINA_TOKEN) return process.env.MARINA_TOKEN;
  const profile = readProfile();
  if (profile.api && profile.api !== apiUrl()) return null;
  return profile.token ?? null;
}

export function saveToken(token: string): void {
  writeProfile({ ...readProfile(), api: apiUrl(), token });
}

export function clearToken(): void {
  const { api: _api, token: _token, ...rest } = readProfile();
  if (Object.keys(rest).length === 0) {
    try {
      unlinkSync(PROFILE);
    } catch {
      // Already signed out.
    }
    return;
  }
  writeProfile(rest);
}

// Project link: which app this directory deploys to. Committed, like v0.
export interface ProjectLink {
  app: string; // slug
  name?: string;
}

const LINK = ".marina/project.json";

export function readLink(dir: string): ProjectLink | null {
  try {
    return JSON.parse(readFileSync(join(dir, LINK), "utf8")) as ProjectLink;
  } catch {
    return null;
  }
}

export function writeLink(dir: string, link: ProjectLink): void {
  mkdirSync(join(dir, ".marina"), { recursive: true });
  writeFileSync(join(dir, LINK), `${JSON.stringify(link, null, 2)}\n`);
}

export const hasPackageJson = (dir: string): boolean => existsSync(join(dir, "package.json"));
