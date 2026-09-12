import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { zipSync } from "fflate";
import ignore from "ignore";

// Pack a directory into the upload zip. The CLI stays thin: walk, exclude the
// obvious, refuse to ship secrets, zip. Detection and validation are the
// server's job.

const EXCLUDED_DIRS = new Set([
  ".git",
  ".hg",
  ".svn",
  ".marina",
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
  "__MACOSX",
]);
const EXCLUDED_FILES = new Set([".DS_Store"]);
const MAX_TOTAL = 100 * 1024 * 1024;

// Deploying an output directory directly would publish an app without its
// source. The server refuses recognizable bundler output; this guard closes
// the plainest case earlier and with a better message: a conventional output
// directory of a project whose own package declares a build.
const OUTPUT_DIR_NAMES = new Set(["dist", "build", "out", ".output"]);

/** The project directory this path is build output of, or null. */
export function buildOutputParent(dir: string): string | null {
  // Both names carry intent: an alias named dist points at output, and so
  // does a dist that is itself a symlink to output named something else.
  // realpathSync also keeps macOS symlinked temp paths honest.
  let real: string;
  try {
    real = realpathSync(dir);
  } catch {
    return null; // pack() will report the unreadable path itself
  }
  if (!OUTPUT_DIR_NAMES.has(basename(dir)) && !OUTPUT_DIR_NAMES.has(basename(real))) return null;
  if (!existsSync(join(real, "index.html"))) return null;
  // A directory with its own manifest or package is a project, not output.
  if (existsSync(join(real, "package.json")) || existsSync(join(real, "marina.json"))) return null;
  // The build declaration may sit beside the real directory or beside the
  // alias the user deployed; either parent identifies the project.
  for (const parent of new Set([dirname(real), dirname(dir)])) {
    if (parent === real || parent === dir) continue;
    if (declaresBuild(parent)) return parent;
  }
  return null;
}

function declaresBuild(parent: string): boolean {
  try {
    const parsed = JSON.parse(readFileSync(join(parent, "package.json"), "utf8")) as {
      scripts?: Record<string, unknown>;
    };
    const build = parsed.scripts?.build;
    return typeof build === "string" && build.trim().length > 0;
  } catch {
    return false;
  }
}

// Keep credential exclusions aligned with Marina's upload validation.
const SECRET_FILE =
  /^(\.env(\.[^/]*)?|\.npmrc|.*\.pem|.*\.p12|.*\.pfx|id_rsa|id_dsa|id_ecdsa|id_ed25519|credentials\.json|service-account\.json)$/i;

interface ScopedIgnore {
  base: string;
  matcher: ReturnType<typeof ignore>;
}

function ignoredBy(rules: ScopedIgnore[], path: string, directory: boolean): boolean {
  let ignored = false;
  for (const rule of rules) {
    const scopedPath =
      rule.base === ""
        ? path
        : path.startsWith(`${rule.base}/`)
          ? path.slice(rule.base.length + 1)
          : undefined;
    if (!scopedPath) continue;

    const result = rule.matcher.test(directory ? `${scopedPath}/` : scopedPath);
    if (result.ignored) ignored = true;
    if (result.unignored) ignored = false;
  }
  return ignored;
}

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

  const walk = (current: string, inheritedRules: ScopedIgnore[]): void => {
    const currentRelative = relative(dir, current).replaceAll("\\", "/");
    const rules = [...inheritedRules];
    const gitignorePath = join(current, ".gitignore");
    if (existsSync(gitignorePath)) {
      const gitignoreStat = lstatSync(gitignorePath);
      if (gitignoreStat.isFile() && !gitignoreStat.isSymbolicLink()) {
        rules.push({
          base: currentRelative,
          matcher: ignore().add(readFileSync(gitignorePath, "utf8")),
        });
      }
    }

    for (const entry of readdirSync(current)) {
      const full = join(current, entry);
      const stat = lstatSync(full);
      if (stat.isSymbolicLink()) continue; // never follow links out of the project
      const relativePath = relative(dir, full).replaceAll("\\", "/");
      if (stat.isDirectory()) {
        if (!EXCLUDED_DIRS.has(entry) && !ignoredBy(rules, relativePath, true)) {
          walk(full, rules);
        }
        continue;
      }
      if (EXCLUDED_FILES.has(entry)) continue;
      // Secrets never leave the machine. Not negotiable, not configurable.
      // The server refuses these too — this just saves the round trip.
      if (SECRET_FILE.test(entry)) {
        skippedSecrets.push(relative(dir, full));
        continue;
      }
      if (ignoredBy(rules, relativePath, false)) continue;
      totalBytes += stat.size;
      if (totalBytes > MAX_TOTAL) {
        throw new Error(
          `this directory is over ${String(MAX_TOTAL / 1024 / 1024)} MB unpacked — trim it before deploying`,
        );
      }
      files[relativePath] = readFileSync(full);
    }
  };
  walk(dir, []);

  const fileCount = Object.keys(files).length;
  if (fileCount === 0) throw new Error("nothing to deploy — this directory is empty");
  return { zip: zipSync(files), fileCount, totalBytes, skippedSecrets };
}
