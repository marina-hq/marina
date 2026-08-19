import packageJson from "../package.json" with { type: "json" };
import { latestCliVersion, readProfile, writeProfile } from "./config.ts";

const NAG_INTERVAL_MS = 24 * 60 * 60 * 1000;

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
  const latest = latestCliVersion();
  if (!latest || !isNewerVersion(latest, current)) return null;

  const profile = readProfile();
  const notifiedAt = profile.update?.notified_at
    ? Date.parse(profile.update.notified_at)
    : Number.NaN;
  if (Number.isFinite(notifiedAt) && Date.now() - notifiedAt < NAG_INTERVAL_MS) return null;

  writeProfile({
    ...profile,
    update: { latest, notified_at: new Date().toISOString() },
  });
  return {
    current,
    latest,
    command: "npm install -g @marina-cloud/cli@latest",
  };
}
