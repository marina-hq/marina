import assert from "node:assert/strict";
import { createHash, createPublicKey, verify } from "node:crypto";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

export function verifyCompatibility({ record, publicKey, bytes, version, now = Date.now() }) {
  assert(
    typeof record.payload === "string" && typeof record.signature === "string",
    "A signed compatibility record is required",
  );
  const payload = Buffer.from(record.payload, "base64");
  assert(
    verify(null, payload, publicKey, Buffer.from(record.signature, "base64")),
    "Invalid compatibility signature",
  );
  const claims = JSON.parse(payload.toString("utf8"));
  assert.deepEqual(Object.keys(claims).toSorted(), [
    "integrity",
    "package",
    "schema",
    "verified_at",
    "version",
  ]);
  assert.equal(claims.schema, 1);
  assert.equal(claims.package, "@marina-cloud/cli");
  assert.equal(claims.version, version, "Compatibility record is for another CLI version");
  assert.equal(
    claims.integrity,
    `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
    "Package differs from the verified candidate",
  );
  const age = now - Date.parse(claims.verified_at);
  assert(
    Number.isFinite(age) && age >= -120_000 && age <= 7 * 24 * 60 * 60_000,
    "Compatibility record expired or has an invalid date",
  );
  return claims;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values } = parseArgs({
    options: {
      record: { type: "string" },
      key: { type: "string" },
      package: { type: "string" },
      version: { type: "string" },
    },
  });
  assert(
    values.record && values.key && values.package && values.version,
    "Pass --record, --key, --package and --version",
  );
  verifyCompatibility({
    record: JSON.parse(readFileSync(values.record, "utf8")),
    publicKey: createPublicKey({
      key: JSON.parse(readFileSync(values.key, "utf8")),
      format: "jwk",
    }),
    bytes: readFileSync(values.package),
    version: values.version,
  });
  process.stdout.write("Verified deployed compatibility for this exact CLI package.\n");
}
