import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, normalize, sep } from "node:path";

/** Local, disposable emulation of `marina.storage`. Objects live under the
 * project's .marina/dev directory with JSON sidecars for metadata; shapes
 * match the production broker exactly. */

export interface StoredObjectMetadata {
  key: string;
  size: number;
  etag: string;
  uploadedAt: string;
  contentType?: string;
  metadata: Record<string, string>;
}

interface Sidecar {
  contentType?: string;
  metadata: Record<string, string>;
  etag: string;
  uploadedAt: string;
  size: number;
}

const MAX_LIST_LIMIT = 1000;

export class LocalStorage {
  private readonly objects: string;
  private readonly sidecars: string;

  constructor(root: string) {
    this.objects = join(root, "objects");
    this.sidecars = join(root, "meta");
    mkdirSync(this.objects, { recursive: true });
    mkdirSync(this.sidecars, { recursive: true });
  }

  /** Keys were validated by the runtime client; this guards the filesystem
   * anyway so a hand-crafted invoke cannot escape the store. */
  private objectPath(base: string, key: string): string {
    const path = normalize(join(base, key));
    if (path !== base && !path.startsWith(base + sep)) {
      throw new Error("storage key escapes the local store");
    }
    return path;
  }

  put(input: {
    key: string;
    body: string | Uint8Array | ArrayBuffer;
    contentType?: string;
    metadata?: Record<string, string>;
  }): StoredObjectMetadata {
    const body =
      typeof input.body === "string"
        ? Buffer.from(input.body, "utf8")
        : input.body instanceof ArrayBuffer
          ? Buffer.from(input.body)
          : Buffer.from(input.body);
    const sidecar: Sidecar = {
      ...(input.contentType ? { contentType: input.contentType } : {}),
      metadata: input.metadata ?? {},
      etag: createHash("sha256").update(body).digest("hex").slice(0, 32),
      uploadedAt: new Date().toISOString(),
      size: body.byteLength,
    };
    const objectPath = this.objectPath(this.objects, input.key);
    mkdirSync(dirname(objectPath), { recursive: true });
    writeFileSync(objectPath, body);
    const sidecarPath = this.objectPath(this.sidecars, `${input.key}.json`);
    mkdirSync(dirname(sidecarPath), { recursive: true });
    writeFileSync(sidecarPath, JSON.stringify(sidecar));
    return { key: input.key, ...sidecar };
  }

  get(key: string): (StoredObjectMetadata & { body: Uint8Array }) | null {
    const metadata = this.head(key);
    if (!metadata) return null;
    const body = readFileSync(this.objectPath(this.objects, key));
    return { ...metadata, body: new Uint8Array(body) };
  }

  private head(key: string): StoredObjectMetadata | null {
    try {
      const sidecar = JSON.parse(
        readFileSync(this.objectPath(this.sidecars, `${key}.json`), "utf8"),
      ) as Sidecar;
      return { key, ...sidecar };
    } catch {
      return null;
    }
  }

  delete(key: string): void {
    rmSync(this.objectPath(this.objects, key), { force: true });
    rmSync(this.objectPath(this.sidecars, `${key}.json`), { force: true });
  }

  list(input: { prefix?: string; cursor?: string; limit?: number } = {}): {
    objects: StoredObjectMetadata[];
    cursor?: string;
    truncated: boolean;
  } {
    const limit = Math.min(input.limit ?? MAX_LIST_LIMIT, MAX_LIST_LIMIT);
    const keys: string[] = [];
    const walk = (dir: string, prefix: string) => {
      let entries: string[];
      try {
        entries = readdirSync(dir);
      } catch {
        return;
      }
      for (const entry of entries.toSorted()) {
        const path = join(dir, entry);
        if (statSync(path).isDirectory()) walk(path, `${prefix}${entry}/`);
        else if (entry.endsWith(".json")) keys.push(`${prefix}${entry.slice(0, -5)}`);
      }
    };
    walk(this.sidecars, "");
    const filtered = keys
      .filter((key) => (input.prefix ? key.startsWith(input.prefix) : true))
      .filter((key) => (input.cursor ? key > input.cursor : true));
    const page = filtered.slice(0, limit);
    const truncated = filtered.length > page.length;
    const objects = page
      .map((key) => this.head(key))
      .filter((object): object is StoredObjectMetadata => object !== null);
    return {
      objects,
      ...(truncated && page.length > 0 ? { cursor: page[page.length - 1] } : {}),
      truncated,
    };
  }
}
