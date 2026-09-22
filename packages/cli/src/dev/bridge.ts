/** The laptop half of the local-development bridge: connection calls travel to the control plane with the developer's own
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
  service: "ai" | "connections";
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

/** Fetch one declared app secret for local dev. The developer token must have
 * edit access, and this value is never printed or stored by the CLI. */
export async function bridgeSecret(
  dependencies: BridgeDependencies,
  name: string,
): Promise<string | null> {
  if (!dependencies.appId)
    throw new BridgeError({
      code: "UNDECLARED",
      message: "link this project to an app before reading managed secrets",
      retryable: false,
    });
  let response: Response;
  try {
    response = await (dependencies.fetcher ?? fetch)(
      `${dependencies.apiUrl}/v1/dev/secrets/${encodeURIComponent(dependencies.appId)}/${encodeURIComponent(name)}`,
      {
        headers: { authorization: `Bearer ${dependencies.token}` },
        signal: AbortSignal.timeout(10_000),
      },
    );
  } catch {
    throw new BridgeError({
      code: "UNAVAILABLE",
      message: "Marina is unreachable",
      retryable: true,
    });
  }
  if (!response.ok)
    throw new BridgeError({
      code: response.status === 403 ? "UNDECLARED" : "UNAVAILABLE",
      message: "managed secret is unavailable",
      retryable: response.status >= 500,
    });
  const body: unknown = await response.json().catch(() => null);
  if (
    !body ||
    typeof body !== "object" ||
    !("value" in body) ||
    (body.value !== null && typeof body.value !== "string")
  )
    throw new BridgeError({
      code: "UNAVAILABLE",
      message: "invalid secret response",
      retryable: true,
    });
  return body.value as string | null;
}
