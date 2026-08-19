import packageJson from "../package.json" with { type: "json" };
import { readProfile, writeProfile } from "./config.ts";

const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const LATEST_URL = "https://registry.npmjs.org/@marina-cloud%2Fcli/latest";

export interface AvailableUpdate {
  current: string;
  latest: string;
  command: string;
}

export function isNewerVersion(candidate: string, current: string): boolean {
  const parse = (version: string): number[] =>
    version
      .replace(/^v/, "")
      .split("-", 1)[0]!
      .split(".")
      .map((part) => Number.parseInt(part, 10));
  const left = parse(candidate);
  const right = parse(current);
  if (left.some(Number.isNaN) || right.some(Number.isNaN)) return false;
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference > 0;
  }
  return false;
}

export async function availableUpdate(): Promise<AvailableUpdate | null> {
  if (process.env.MARINA_DISABLE_UPDATE_CHECK) return null;

  const current = packageJson.version;
  const profile = readProfile();
  const checkedAt = profile.update ? Date.parse(profile.update.checked_at) : Number.NaN;
  let latest = profile.update?.latest;

  if (!latest || !Number.isFinite(checkedAt) || Date.now() - checkedAt >= CHECK_INTERVAL_MS) {
    try {
      const response = await fetch(LATEST_URL, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(1500),
      });
      if (response.ok) {
        const body = (await response.json()) as { version?: string };
        if (body.version) {
          latest = body.version;
          writeProfile({
            ...readProfile(),
            update: { checked_at: new Date().toISOString(), latest },
          });
        }
      }
    } catch {
      // Update checks never block a command.
    }
  }

  return latest && isNewerVersion(latest, current)
    ? {
        current,
        latest,
        command: "npm install -g @marina-cloud/cli@latest",
      }
    : null;
}
