import { randomUUID } from "node:crypto";
import { BridgeError, bridgeInvoke, bridgeSecret, type BridgeDependencies } from "./bridge.ts";
import type { LocalDatabase } from "./db.ts";
import type { DevJobRunner } from "./jobs.ts";
import type { DevManifest } from "./manifest.ts";
import type { LocalStorage } from "./storage.ts";

/** The laptop's implementation of the object-capability every Marina app
 * receives as env.MARINA: storage, db, and jobs are local; connections bridge to the control plane under the developer's own grants;
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
  /** Local origin used for grant URLs; defaults to the standard dev port. */
  origin?: string;
}

const ok = (value: unknown): RuntimeResponse => ({ ok: true, value });
const failure = (code: string, message: string, retryable = false): RuntimeResponse => ({
  ok: false,
  error: { code, message, retryable },
});

/** The production grant path rules, repeated here because the published CLI
 * cannot import Marina's internal contracts. */
function grantPathError(path: unknown): string | null {
  if (typeof path !== "string" || !path.startsWith("/") || path.startsWith("//"))
    return "grant path must start with a single /";
  if (new TextEncoder().encode(path).byteLength > 1024)
    return "grant path must be at most 1024 bytes";
  if (/[?#\s\\]/.test(path))
    return "grant path must not contain a query, fragment, whitespace, or backslash";
  if (path.split("/").some((segment) => segment === "." || segment === ".."))
    return "grant path must not contain . or .. segments";
  if (path.startsWith("/__marina/") || path.startsWith("/.marina/"))
    return "platform paths cannot be granted";
  if (new URL(path, "http://grant.invalid").pathname !== path)
    return "grant path must be in normalized URL form";
  return null;
}

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
            if (request.operation === "put") return ok(await context.storage.put(input));
            if (request.operation === "get") {
              const read = input as {
                key: string;
                range?: { offset: number; length?: number } | { suffix: number };
                stream?: boolean;
              };
              return ok(
                context.storage.get(read.key, {
                  ...(read.range ? { range: read.range } : {}),
                  stream: read.stream === true,
                }),
              );
            }
            if (request.operation === "head")
              return ok(context.storage.head((input as { key: string }).key));
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
          case "connections": {
            const input = request.input as Record<string, unknown>;
            const connector = String(input.connector);
            const operation = String(input.operation);
            const declarations = context.manifest.connections[connector] ?? [];
            const connection =
              input.connection ??
              (declarations.length === 1 ? declarations[0]?.connection : undefined);
            const declaration = declarations.find((entry) => entry.connection === connection);
            if (!declaration?.operations.includes(operation))
              return undeclared(
                `${connector}/${String(connection ?? "unspecified")}.${operation}`,
                `the connection and operation under connections.${connector}`,
              );
            return ok(
              await bridgeInvoke(context.bridge, {
                service: "connections",
                input: { ...input, connection },
              }),
            );
          }
          case "grants": {
            if (context.manifest.runtime.grants !== "v1")
              return undeclared("grants", 'runtime.grants: "v1"');
            if (request.operation !== "create")
              return failure("INVALID_INPUT", `unsupported grants operation ${request.operation}`);
            // Local links are not signed: the dev host already trusts every
            // request. They keep the production shape so app code is unchanged.
            const input = request.input as { path: string; expiresIn?: number };
            const pathError = grantPathError(input.path);
            if (pathError) return failure("INVALID_INPUT", pathError);
            const token = `dev.${randomUUID()}`;
            const url = new URL(context.origin ?? "http://localhost:5990");
            url.pathname = input.path;
            url.searchParams.set("marina_grant", token);
            return ok({
              url: url.toString(),
              token,
              expiresAt: new Date(Date.now() + (input.expiresIn ?? 900) * 1000).toISOString(),
            });
          }
          case "secrets": {
            const name =
              request.input && typeof request.input === "object" && "name" in request.input
                ? request.input.name
                : undefined;
            if (request.operation !== "get" || typeof name !== "string")
              return failure("INVALID_INPUT", "invalid secret request");
            if (!context.manifest.runtime.secrets?.includes(name))
              return undeclared(`secret ${name}`, `runtime.secrets: ["${name}"]`);
            return ok(await bridgeSecret(context.bridge, name));
          }
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
