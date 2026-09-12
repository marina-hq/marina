/** The laptop half of the local-development bridge: capability and
 * connection calls travel to the control plane with the developer's own
 * token and execute inside the same trusted boundary as production.
 * Credentials never reach this process — only results do. */

export interface BridgeDependencies {
  apiUrl: string;
  token: string;
  appId?: string;
  fetcher?: typeof fetch;
}

export interface BridgeErrorPayload {
  code: "UNAVAILABLE" | "UNDECLARED" | "INVALID_INPUT" | "NOT_FOUND" | "CONFLICT" | "INTERNAL";
  message: string;
  retryable: boolean;
}

export class BridgeError extends Error {
  readonly payload: BridgeErrorPayload;
  constructor(payload: BridgeErrorPayload) {
    super(payload.message);
    this.payload = payload;
  }
}

function mapErrorCode(code: string, status: number): BridgeErrorPayload["code"] {
  if (code === "invalid_input") return "INVALID_INPUT";
  if (code === "not_found") return "NOT_FOUND";
  if (code === "conflict") return "CONFLICT";
  if (code === "forbidden") return "UNDECLARED";
  if (status === 401) return "UNDECLARED";
  return "UNAVAILABLE";
}

interface RawInvoke {
  service: "ai" | "capabilities" | "connections";
  input: Record<string, unknown>;
}

function devRuntimeBody(invoke: RawInvoke, appId: string | undefined): Record<string, unknown> {
  if (invoke.service === "ai") {
    return {
      service: "ai",
      args: invoke.input.args ?? {},
      ...(appId ? { app_id: appId } : {}),
    };
  }
  if (invoke.service === "capabilities") {
    return {
      service: "capabilities",
      capability: invoke.input.capability,
      args: invoke.input.args ?? {},
      ...(invoke.input.requestId ? { request_id: invoke.input.requestId } : {}),
    };
  }
  return {
    service: "connections",
    connector: invoke.input.connector,
    ...(invoke.input.connection ? { connection: invoke.input.connection } : {}),
    operation: invoke.input.operation,
    args: invoke.input.args ?? {},
    ...(appId ? { app_id: appId } : {}),
  };
}

export async function bridgeInvoke(
  dependencies: BridgeDependencies,
  invoke: RawInvoke,
): Promise<unknown> {
  const fetcher = dependencies.fetcher ?? fetch;
  let response: Response;
  try {
    response = await fetcher(`${dependencies.apiUrl}/v1/dev/runtime`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${dependencies.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(devRuntimeBody(invoke, dependencies.appId)),
      signal: AbortSignal.timeout(60_000),
    });
  } catch {
    throw new BridgeError({
      code: "UNAVAILABLE",
      message: "Marina is unreachable — bridged calls need a network connection",
      retryable: true,
    });
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new BridgeError({
      code: "UNAVAILABLE",
      message: "Marina returned an invalid response",
      retryable: true,
    });
  }
  if (!response.ok) {
    const error = (body as { error?: { code?: string; message?: string } }).error ?? {};
    throw new BridgeError({
      code: mapErrorCode(error.code ?? "", response.status),
      message: error.message ?? `bridged call failed (${String(response.status)})`,
      retryable: response.status >= 500,
    });
  }
  return (body as { value?: unknown }).value;
}
