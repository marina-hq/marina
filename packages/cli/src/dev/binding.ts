import { BridgeError, bridgeInvoke, type BridgeDependencies } from "./bridge.ts";
import type { LocalDatabase } from "./db.ts";
import type { DevJobRunner } from "./jobs.ts";
import type { DevManifest } from "./manifest.ts";
import type { LocalStorage } from "./storage.ts";

/** The laptop's implementation of the object-capability every Marina app
 * receives as env.MARINA: storage, db, and jobs are local; capabilities and
 * connections bridge to the control plane under the developer's own grants;
 * ai bridges too, metered per developer by the control plane. */

type RuntimeResponse =
  | { ok: true; value: unknown }
  | {
      ok: false;
      error: { code: string; message: string; retryable: boolean };
    };

interface RuntimeRequest {
  protocolVersion: number;
  requestId: string;
  service: string;
  operation: string;
  input: unknown;
}

export interface DevBindingContext {
  manifest: DevManifest;
  storage: LocalStorage | null;
  database: LocalDatabase | null;
  jobs: DevJobRunner | null;
  bridge: BridgeDependencies;
}

const ok = (value: unknown): RuntimeResponse => ({ ok: true, value });
const failure = (code: string, message: string, retryable = false): RuntimeResponse => ({
  ok: false,
  error: { code, message, retryable },
});

function undeclared(service: string, declaration: string): RuntimeResponse {
  return failure(
    "UNDECLARED",
    `this app does not declare ${service} — add ${declaration} to marina.json`,
  );
}

export function createDevBinding(context: DevBindingContext) {
  return {
    async invoke(request: RuntimeRequest): Promise<RuntimeResponse> {
      try {
        switch (request.service) {
          case "storage": {
            if (!context.storage) return undeclared("storage", 'runtime.storage: "v1"');
            const input = request.input as never;
            if (request.operation === "put") return ok(context.storage.put(input));
            if (request.operation === "get")
              return ok(context.storage.get((input as { key: string }).key));
            if (request.operation === "delete") {
              context.storage.delete((input as { key: string }).key);
              return ok(null);
            }
            if (request.operation === "list") return ok(context.storage.list(input));
            return failure("INVALID_INPUT", `unsupported storage operation ${request.operation}`);
          }
          case "db": {
            if (!context.database) return undeclared("the managed database", 'runtime.db: "v1"');
            if (request.operation === "query") {
              const query = request.input as { text: string; params: unknown[] };
              return ok(await context.database.query(query.text, query.params));
            }
            if (request.operation === "transaction") {
              const { queries } = request.input as {
                queries: { text: string; params: unknown[] }[];
              };
              return ok(await context.database.transaction(queries));
            }
            return failure("INVALID_INPUT", `unsupported db operation ${request.operation}`);
          }
          case "ai": {
            if (!context.manifest.runtime.ai) return undeclared("ai", 'runtime.ai: "v1"');
            if (request.operation !== "generate")
              return failure("INVALID_INPUT", `unsupported ai operation ${request.operation}`);
            return ok(
              await bridgeInvoke(context.bridge, {
                service: "ai",
                input: { args: request.input },
              }),
            );
          }
          case "jobs": {
            if (!context.jobs) return undeclared("background jobs", 'runtime.jobs: "v1"');
            if (request.operation === "enqueue") {
              const input = request.input as { name: string; input: unknown; dedupeKey?: string };
              const status = context.jobs.enqueue(input);
              return ok({ id: status.id, state: status.state });
            }
            if (request.operation === "get") {
              const { runId } = request.input as { runId: string };
              const status = context.jobs.get(runId);
              return status ? ok(status) : failure("NOT_FOUND", "no such job run");
            }
            return failure("INVALID_INPUT", `unsupported jobs operation ${request.operation}`);
          }
          case "capabilities":
          case "connections":
            return ok(
              await bridgeInvoke(context.bridge, {
                service: request.service,
                input: request.input as Record<string, unknown>,
              }),
            );
          default:
            return failure("UNDECLARED", `unsupported runtime service ${request.service}`);
        }
      } catch (error) {
        if (error instanceof BridgeError) return { ok: false, error: error.payload };
        return failure("INVALID_INPUT", (error as Error).message);
      }
    },
    async authorizeJob(request: { token: string; body: string }): Promise<boolean> {
      return context.jobs ? context.jobs.authorizeJob(request) : false;
    },
  };
}
