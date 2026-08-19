import { zipSync } from "fflate";
import appScript from "../demo/app.js.txt";
import indexHtml from "../demo/index.html";
import styles from "../demo/styles.css";
import { DEMO_MANIFEST } from "./demo-manifest.ts";
import type { Packed } from "./pack.ts";

export { DEMO_MANIFEST } from "./demo-manifest.ts";

const encoder = new TextEncoder();

export function demoFiles(): Record<string, Uint8Array> {
  return {
    "index.html": encoder.encode(indexHtml),
    "styles.css": encoder.encode(styles),
    "app.js": encoder.encode(appScript),
    "marina.json": encoder.encode(`${JSON.stringify(DEMO_MANIFEST, null, 2)}\n`),
  };
}

export function packDemo(): Packed {
  const files = demoFiles();
  return {
    zip: zipSync(files),
    fileCount: Object.keys(files).length,
    totalBytes: Object.values(files).reduce((total, file) => total + file.byteLength, 0),
    skippedSecrets: [],
  };
}
