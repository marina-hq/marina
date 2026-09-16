import { inflateRawSync } from "node:zlib";

export const MAX_SOURCE_BYTES = 100 * 1024 * 1024;
const MAX_FILES = 20_000;
const crcTable = Uint32Array.from({ length: 256 }, (_, i) => {
  for (let bit = 0; bit < 8; bit++) i = (i >>> 1) ^ (i & 1 ? 0xedb88320 : 0);
  return i;
});
function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 255]!;
  return (crc ^ 0xffffffff) >>> 0;
}

export function sourcePath(name: string): void {
  const parts = name.split("/");
  if (
    !name ||
    name.startsWith("/") ||
    /[\\:*?"<>|]/.test(name) ||
    Array.from(name).some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    ) ||
    parts.some(
      (part) =>
        !part ||
        part === "." ||
        part === ".." ||
        /[. ]$/.test(part) ||
        /^(?:\.git|\.marina|node_modules)$/i.test(part) ||
        /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part),
    )
  )
    throw new Error(`unsafe source path: ${JSON.stringify(name)}`);
}

/** Check central-directory names, sizes, duplicates and Unix file types before
 * inflation. A regular file is the only entry we ever materialize. */
export function unpackSource(zip: Uint8Array): Map<string, Uint8Array> {
  if (zip.length > MAX_SOURCE_BYTES || zip.length < 22)
    throw new Error("invalid source archive size");
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  let end = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 65_557); i--) {
    if (
      view.getUint32(i, true) === 0x06054b50 &&
      i + 22 + view.getUint16(i + 20, true) === zip.length
    ) {
      end = i;
      break;
    }
  }
  if (end < 0 || view.getUint16(end + 4, true) || view.getUint16(end + 6, true))
    throw new Error("invalid source ZIP directory");
  const count = view.getUint16(end + 10, true);
  const size = view.getUint32(end + 12, true);
  let offset = view.getUint32(end + 16, true);
  const directoryStart = offset;
  if (count > MAX_FILES || count !== view.getUint16(end + 8, true) || offset + size !== end)
    throw new Error("invalid source ZIP bounds");
  const names = new Set<string>();
  const files = new Set<string>();
  const expectedSizes = new Map<string, number>();
  const contents: {
    name: string;
    start: number;
    compressed: number;
    method: number;
    crc: number;
  }[] = [];
  let total = 0;
  for (let i = 0; i < count; i++) {
    if (offset + 46 > end || view.getUint32(offset, true) !== 0x02014b50)
      throw new Error("invalid source ZIP entry");
    const flags = view.getUint16(offset + 8, true);
    const method = view.getUint16(offset + 10, true);
    const uncompressed = view.getUint32(offset + 24, true);
    const compressed = view.getUint32(offset + 20, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const entryEnd = offset + 46 + nameLength + extraLength + commentLength;
    if (entryEnd > end || flags & 1 || ![0, 8].includes(method))
      throw new Error("unsupported source ZIP entry");
    const raw = new TextDecoder("utf-8", { fatal: true }).decode(
      zip.subarray(offset + 46, offset + 46 + nameLength),
    );
    const local = view.getUint32(offset + 42, true);
    if (
      local + 30 > directoryStart ||
      view.getUint32(local, true) !== 0x04034b50 ||
      view.getUint16(local + 6, true) !== flags ||
      view.getUint16(local + 8, true) !== method
    )
      throw new Error("invalid source ZIP local header");
    const localNameLength = view.getUint16(local + 26, true);
    const dataStart = local + 30 + localNameLength + view.getUint16(local + 28, true);
    if (
      dataStart + compressed > directoryStart ||
      (method === 0 && compressed !== uncompressed) ||
      new TextDecoder("utf-8", { fatal: true }).decode(
        zip.subarray(local + 30, local + 30 + localNameLength),
      ) !== raw
    )
      throw new Error("source ZIP entry differs from its directory");
    const directory = raw.endsWith("/");
    const name = directory ? raw.slice(0, -1) : raw;
    sourcePath(name);
    const mode = view.getUint32(offset + 38, true) >>> 16;
    const kind = mode & 0xf000;
    if (kind && kind !== (directory ? 0x4000 : 0x8000))
      throw new Error("source archive contains a link or special file");
    const portable = name.normalize("NFC").toLowerCase();
    if (names.has(portable))
      throw new Error("source archive contains duplicate or case-colliding paths");
    names.add(portable);
    if (!directory) {
      files.add(portable);
      expectedSizes.set(name, uncompressed);
      contents.push({
        name,
        start: dataStart,
        compressed,
        method,
        crc: view.getUint32(offset + 16, true),
      });
    }
    total += uncompressed;
    if (total > MAX_SOURCE_BYTES || (total > 10 * 1024 * 1024 && total / zip.length > 200))
      throw new Error("source archive expands beyond its limit");
    offset = entryEnd;
  }
  if (offset !== end) throw new Error("invalid source ZIP directory length");
  for (const name of names) {
    const parts = name.split("/");
    parts.pop();
    while (parts.length) {
      if (files.has(parts.join("/")))
        throw new Error("source archive contains a file/directory collision");
      parts.pop();
    }
  }
  if (!contents.length) throw new Error("source ZIP has no files");
  const result = new Map<string, Uint8Array>();
  for (const file of contents) {
    const compressed = zip.subarray(file.start, file.start + file.compressed);
    const expected = expectedSizes.get(file.name)!;
    const bytes =
      file.method === 0
        ? new Uint8Array(compressed)
        : inflateRawSync(compressed, { maxOutputLength: Math.max(1, expected) });
    if (bytes.length !== expected || crc32(bytes) !== file.crc)
      throw new Error("invalid source ZIP contents");
    result.set(file.name, bytes);
  }
  return result;
}
