import { createHash, randomUUID } from "node:crypto";
import {
  createReadStream,
  createWriteStream,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, normalize, sep } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

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

type LocalRange = { offset: number; length?: number } | { suffix: number };

/** Same served-range rules as the production broker. */
function servedRange(size: number, range: LocalRange): { offset: number; length: number } {
  if ("suffix" in range) {
    const length = Math.min(range.suffix, size);
    return { offset: size - length, length };
  }
  if (range.offset >= size && size > 0) throw new Error("storage range starts beyond the object");
  const available = Math.max(size - range.offset, 0);
  return { offset: range.offset, length: Math.min(range.length ?? available, available) };
}

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

  async put(input: {
    key: string;
    body: string | Uint8Array | ArrayBuffer | ReadableStream<Uint8Array>;
    size?: number;
    contentType?: string;
    metadata?: Record<string, string>;
    sha256?: string;
  }): Promise<StoredObjectMetadata> {
    const objectPath = this.objectPath(this.objects, input.key);
    mkdirSync(dirname(objectPath), { recursive: true });
    let digest: string;
    let size: number;
    if (input.body instanceof ReadableStream) {
      // Stream to a temporary file, counting and hashing as bytes arrive, so a
      // large local upload never sits in memory; replace the object only once
      // the size and checksum hold, like the production write.
      const temporary = `${objectPath}.upload-${randomUUID()}`;
      const hash = createHash("sha256");
      let received = 0;
      try {
        await pipeline(
          Readable.fromWeb(input.body as import("node:stream/web").ReadableStream<Uint8Array>),
          new Transform({
            transform(chunk: Buffer, _encoding, callback) {
              received += chunk.byteLength;
              // Stop as soon as the body passes its declared size, like production.
              if (input.size !== undefined && received > input.size) {
                callback(new Error("storage body length does not match size"));
                return;
              }
              hash.update(chunk);
              callback(null, chunk);
            },
          }),
          createWriteStream(temporary),
        );
        digest = hash.digest("hex");
        if (input.size !== undefined && received !== input.size)
          throw new Error("storage body length does not match size");
        if (input.sha256 && digest !== input.sha256)
          throw new Error("storage body does not match sha256");
        renameSync(temporary, objectPath);
      } finally {
        rmSync(temporary, { force: true });
      }
      size = received;
    } else {
      const body =
        typeof input.body === "string"
          ? Buffer.from(input.body, "utf8")
          : input.body instanceof ArrayBuffer
            ? Buffer.from(input.body)
            : Buffer.from(input.body);
      if (input.size !== undefined && body.byteLength !== input.size)
        throw new Error("storage body length does not match size");
      digest = createHash("sha256").update(body).digest("hex");
      if (input.sha256 && digest !== input.sha256)
        throw new Error("storage body does not match sha256");
      writeFileSync(objectPath, body);
      size = body.byteLength;
    }
    const sidecar: Sidecar = {
      ...(input.contentType ? { contentType: input.contentType } : {}),
      metadata: input.metadata ?? {},
      etag: digest.slice(0, 32),
      uploadedAt: new Date().toISOString(),
      size,
    };
    const sidecarPath = this.objectPath(this.sidecars, `${input.key}.json`);
    mkdirSync(dirname(sidecarPath), { recursive: true });
    writeFileSync(sidecarPath, JSON.stringify(sidecar));
    return { key: input.key, ...sidecar };
  }

  get(
    key: string,
    options: { range?: LocalRange; stream?: boolean } = {},
  ):
    | (StoredObjectMetadata & {
        body: Uint8Array | ReadableStream<Uint8Array>;
        range?: { offset: number; length: number };
      })
    | null {
    const metadata = this.head(key);
    if (!metadata) return null;
    const path = this.objectPath(this.objects, key);
    const served = options.range ? servedRange(metadata.size, options.range) : null;
    const start = served?.offset ?? 0;
    const length = served?.length ?? metadata.size;
    const range = served ? { range: served } : {};
    if (options.stream) {
      const body =
        length === 0
          ? new Response(new Uint8Array()).body!
          : (Readable.toWeb(
              createReadStream(path, { start, end: start + length - 1 }),
            ) as ReadableStream<Uint8Array>);
      return { ...metadata, body, ...range };
    }
    const bytes = readFileSync(path).subarray(start, start + length);
    return { ...metadata, body: new Uint8Array(bytes), ...range };
  }

  head(key: string): StoredObjectMetadata | null {
    return this.readSidecar(key);
  }

  private readSidecar(key: string): StoredObjectMetadata | null {
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
