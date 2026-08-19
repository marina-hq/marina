import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { zipSync } from "fflate";

// Pack a directory into the upload zip. The CLI stays thin: walk, exclude the
// obvious, refuse to ship secrets, zip. Detection and validation are the
// server's job.

const EXCLUDED_DIRS = new Set([
  ".git",
  ".hg",
  ".svn",
  "node_modules",
  "bower_components",
  ".venv",
  "venv",
  "__pycache__",
  ".pytest_cache",
  ".cache",
  ".turbo",
  ".next",
  ".nuxt",
  ".svelte-kit",
  ".parcel-cache",
  "coverage",
  ".idea",
  ".vscode",
  ".marina",
  "__MACOSX",
]);
const EXCLUDED_FILES = new Set([".DS_Store"]);
const MAX_TOTAL = 100 * 1024 * 1024;

// Kept in step with the server's own list in pipeline/detect.ts.
const SECRET_FILE =
  /^(\.env(\.[^/]*)?|.*\.pem|.*\.p12|.*\.pfx|id_rsa|id_dsa|id_ecdsa|id_ed25519|credentials\.json|service-account\.json)$/i;

export interface Packed {
  zip: Uint8Array;
  fileCount: number;
  totalBytes: number;
  skippedSecrets: string[];
}

export function pack(dir: string): Packed {
  const files: Record<string, Uint8Array> = {};
  const skippedSecrets: string[] = [];
  let totalBytes = 0;

  const walk = (current: string): void => {
    for (const entry of readdirSync(current)) {
      const full = join(current, entry);
      const stat = lstatSync(full);
      if (stat.isSymbolicLink()) continue; // never follow links out of the project
      if (stat.isDirectory()) {
        if (!EXCLUDED_DIRS.has(entry)) walk(full);
        continue;
      }
      if (EXCLUDED_FILES.has(entry)) continue;
      // Secrets never leave the machine. Not negotiable, not configurable.
      // The server refuses these too — this just saves the round trip.
      if (SECRET_FILE.test(entry)) {
        skippedSecrets.push(relative(dir, full));
        continue;
      }
      totalBytes += stat.size;
      if (totalBytes > MAX_TOTAL) {
        throw new Error(
          `this directory is over ${String(MAX_TOTAL / 1024 / 1024)} MB unpacked — trim it before deploying`,
        );
      }
      files[relative(dir, full).replaceAll("\\", "/")] = readFileSync(full);
    }
  };
  walk(dir);

  const fileCount = Object.keys(files).length;
  if (fileCount === 0) throw new Error("nothing to deploy — this directory is empty");
  return { zip: zipSync(files), fileCount, totalBytes, skippedSecrets };
}
