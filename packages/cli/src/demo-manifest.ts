import type { MarinaManifest } from "./manifest.ts";

export const DEMO_MANIFEST = {
  schema: 1,
  name: "Hello Marina",
  icon: "⛵",
} as const satisfies MarinaManifest;
