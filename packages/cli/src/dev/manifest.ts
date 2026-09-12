import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** The slice of marina.json that `marina dev` needs, validated lightly here
 * and authoritatively by the control plane on deploy and on bridged calls. */
export interface DevConnectionDeclaration {
  connection: string;
  capabilities: string[];
}

export interface DevJobDefinition {
  handler: string;
  schedule?: string;
}

export interface DevManifest {
  name?: string;
  entrypoint: string;
  runtime: { storage?: "v1"; db?: "v1"; ai?: "v1"; jobs?: "v1" };
  capabilities: string[];
  connections: Record<string, DevConnectionDeclaration[]>;
  jobs: Record<string, DevJobDefinition>;
}

const CONNECTION_ID = /^[a-z][a-z0-9_]{0,39}$/;
const NAME = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;

function fail(message: string): never {
  throw new Error(`marina.json: ${message}`);
}

export function readDevManifest(dir: string): DevManifest {
  const path = join(dir, "marina.json");
  if (!existsSync(path)) {
    fail("not found — marina dev runs from a project with a marina.json");
  }
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    fail("is not valid JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("must contain an object");
  const manifest = value as Record<string, unknown>;
  if (typeof manifest.entrypoint !== "string" || manifest.entrypoint.length === 0) {
    fail('needs an "entrypoint" — static projects have no server to develop against');
  }

  const runtime = (manifest.runtime ?? {}) as DevManifest["runtime"];
  const capabilities = Array.isArray(manifest.capabilities)
    ? manifest.capabilities.filter((name): name is string => typeof name === "string")
    : [];

  const connections: DevManifest["connections"] = {};
  if (manifest.connections !== undefined) {
    if (
      !manifest.connections ||
      typeof manifest.connections !== "object" ||
      Array.isArray(manifest.connections)
    ) {
      fail('"connections" must map connector names to declarations');
    }
    for (const [connector, declared] of Object.entries(manifest.connections)) {
      if (!CONNECTION_ID.test(connector)) fail(`"${connector}" is not a connector name`);
      if (!Array.isArray(declared)) fail(`connections.${connector} must be an array`);
      connections[connector] = declared.map((entry, index) => {
        const binding = entry as Record<string, unknown>;
        if (typeof binding.connection !== "string" || !CONNECTION_ID.test(binding.connection)) {
          fail(`connections.${connector}[${String(index)}] needs an explicit "connection" id`);
        }
        const operations = Array.isArray(binding.capabilities) ? binding.capabilities : [];
        if (!operations.every((op) => typeof op === "string" && NAME.test(op))) {
          fail(`connections.${connector}[${String(index)}] has an invalid operation name`);
        }
        return { connection: binding.connection, capabilities: operations as string[] };
      });
    }
  }

  const jobs: DevManifest["jobs"] = {};
  if (manifest.jobs && typeof manifest.jobs === "object" && !Array.isArray(manifest.jobs)) {
    for (const [name, definition] of Object.entries(manifest.jobs)) {
      const job = definition as Record<string, unknown>;
      if (typeof job.handler === "string") {
        jobs[name] = {
          handler: job.handler,
          ...(typeof job.schedule === "string" ? { schedule: job.schedule } : {}),
        };
      }
    }
  }

  return {
    ...(typeof manifest.name === "string" ? { name: manifest.name } : {}),
    entrypoint: manifest.entrypoint,
    runtime,
    capabilities,
    connections,
    jobs,
  };
}
