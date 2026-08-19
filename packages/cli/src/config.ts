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
import { cliRequestHeaders } from "./identity.ts";

export interface MarinaProfile {
  control_plane_host?: string;
  control_plane?: {
    host: string;
    checked_at: string;
    api_url: string;
    dashboard_url: string;
    latest_cli_version: string | null;
  };
  api?: string;
  token?: string;
  update?: {
    latest: string;
    notified_at?: string;
  };
}

const MARINA_HOME = process.env.MARINA_HOME ?? join(homedir(), ".marina");
const PROFILE = join(MARINA_HOME, "profile");
const PRODUCTION_CONTROL_PLANE = "https://marina.cloud";
const CONTROL_PLANE_CACHE_MS = 60 * 60 * 1000;

interface ControlPlaneConfig {
  api_url: string;
  dashboard_url: string;
  latest_cli_version: string | null;
}

let resolvedControlPlane: ControlPlaneConfig | null = null;

function normalizeApiUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("the Marina control plane must use http or https");
  }
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new Error("the Marina control plane must be an origin without a path");
  }
  if (
    url.protocol === "http:" &&
    url.hostname !== "localhost" &&
    url.hostname !== "127.0.0.1" &&
    url.hostname !== "[::1]"
  ) {
    throw new Error("the Marina control plane must use https unless it is local");
  }
  return url.origin;
}

export const controlPlaneHost = (): string =>
  normalizeApiUrl(
    process.env.MARINA_CONTROL_PLANE ??
      readProfile().control_plane_host ??
      PRODUCTION_CONTROL_PLANE,
  );

function cachedControlPlane(host = controlPlaneHost()): MarinaProfile["control_plane"] | null {
  const cached = readProfile().control_plane;
  if (!cached || cached.host !== host) return null;
  try {
    normalizeApiUrl(cached.api_url);
    normalizeApiUrl(cached.dashboard_url);
    return cached;
  } catch {
    return null;
  }
}

export const apiUrl = (): string =>
  normalizeApiUrl(
    process.env.MARINA_API ??
      resolvedControlPlane?.api_url ??
      cachedControlPlane()?.api_url ??
      controlPlaneHost(),
  );

export const dashboardUrl = (): string => {
  if (process.env.MARINA_DASHBOARD) return normalizeApiUrl(process.env.MARINA_DASHBOARD);
  return normalizeApiUrl(
    resolvedControlPlane?.dashboard_url ??
      cachedControlPlane()?.dashboard_url ??
      controlPlaneHost(),
  );
};

export async function resolveControlPlane(): Promise<void> {
  const host = controlPlaneHost();
  const cached = cachedControlPlane(host);
  const checkedAt = cached ? Date.parse(cached.checked_at) : Number.NaN;
  if (cached && Number.isFinite(checkedAt) && Date.now() - checkedAt < CONTROL_PLANE_CACHE_MS) {
    resolvedControlPlane = {
      api_url: cached.api_url,
      dashboard_url: cached.dashboard_url,
      latest_cli_version: cached.latest_cli_version,
    };
    return;
  }
  if (process.env.MARINA_DISABLE_CONTROL_PLANE_DISCOVERY === "1") return;

  try {
    const response = await fetch(`${host}/.well-known/marina`, {
      headers: { ...cliRequestHeaders(), accept: "application/json" },
      signal: AbortSignal.timeout(3000),
    });
    if (!response.ok)
      throw new Error(`control-plane discovery failed (${String(response.status)})`);
    const body = (await response.json()) as {
      schema_version?: unknown;
      api_url?: unknown;
      dashboard_url?: unknown;
      clients?: { cli?: { latest_version?: unknown } };
    };
    if (
      body.schema_version !== 1 ||
      typeof body.api_url !== "string" ||
      typeof body.dashboard_url !== "string"
    ) {
      throw new Error("control-plane discovery returned an invalid response");
    }
    const discovered: ControlPlaneConfig = {
      api_url: normalizeApiUrl(body.api_url),
      dashboard_url: normalizeApiUrl(body.dashboard_url),
      latest_cli_version:
        typeof body.clients?.cli?.latest_version === "string"
          ? body.clients.cli.latest_version
          : null,
    };
    resolvedControlPlane = discovered;
    writeProfile({
      ...readProfile(),
      control_plane: {
        host,
        checked_at: new Date().toISOString(),
        ...discovered,
      },
    });
  } catch {
    if (cached) {
      resolvedControlPlane = {
        api_url: cached.api_url,
        dashboard_url: cached.dashboard_url,
        latest_cli_version: cached.latest_cli_version,
      };
    }
    // The control-plane host remains a functional proxy if discovery is
    // temporarily unavailable, so a metadata outage never blocks a command.
  }
}

export function latestCliVersion(): string | null {
  return (
    resolvedControlPlane?.latest_cli_version ?? cachedControlPlane()?.latest_cli_version ?? null
  );
}

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
