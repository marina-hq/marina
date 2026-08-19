import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

export interface MarinaManifest {
  schema?: 1;
  name?: string;
  icon?: string;
  type?: "static" | "dynamic";
  entrypoint?: string;
  port?: number;
}

export function readManifest(dir: string): MarinaManifest | null {
  const path = join(dir, "marina.json");
  if (!existsSync(path)) return null;

  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error("marina.json is not valid JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("marina.json must contain an object");
  }

  const manifest = value as Record<string, unknown>;
  if (manifest.schema !== undefined && manifest.schema !== 1) {
    throw new Error('marina.json "schema" must be 1');
  }
  if (
    manifest.name !== undefined &&
    (typeof manifest.name !== "string" || !manifest.name.trim() || manifest.name.length > 80)
  ) {
    throw new Error('marina.json "name" must be between 1 and 80 characters');
  }
  if (
    manifest.icon !== undefined &&
    (typeof manifest.icon !== "string" || !manifest.icon || manifest.icon.length > 8)
  ) {
    throw new Error('marina.json "icon" must be an emoji');
  }
  if (manifest.type !== undefined && manifest.type !== "static" && manifest.type !== "dynamic") {
    throw new Error('marina.json "type" must be "static" or "dynamic"');
  }
  return manifest as MarinaManifest;
}

export function resolveAppName(
  dir: string,
  flag?: string,
  manifest = readManifest(dir),
  linkedName?: string,
): string {
  if (flag?.trim()) return flag.trim();
  if (manifest?.name?.trim()) return manifest.name.trim();
  try {
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { name?: unknown };
    if (typeof pkg.name === "string" && pkg.name.trim()) {
      return pkg.name.trim().replace(/^@[^/]+\//, "");
    }
  } catch {
    // no usable package name — fall through
  }
  if (linkedName?.trim()) return linkedName.trim();
  return basename(dir);
}
