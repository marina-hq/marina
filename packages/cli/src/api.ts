import { apiUrl, getToken } from "./config.ts";

const LOGIN_EXCHANGE_TIMEOUT_MS = 15_000;

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status: number) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const token = getToken();
  if (!token) throw new ApiError("unauthenticated", "not signed in — run `marina setup`", 401);
  const res = await fetch(`${apiUrl()}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, ...init?.headers },
  });
  const body = (await res.json().catch(() => ({}))) as {
    error?: { code?: string; message?: string };
  } & T;
  if (!res.ok) {
    throw new ApiError(
      body.error?.code ?? "error",
      body.error?.message ?? `request failed (${String(res.status)})`,
      res.status,
    );
  }
  return body;
}

/** Complete the browser login without an existing credential. The API key is
 * returned only to this direct client request, never through the browser. */
export async function exchangeCliLogin(
  code: string,
  codeVerifier: string,
): Promise<{ token: string; name: string; prefix: string }> {
  let res: Response;
  try {
    res = await fetch(`${apiUrl()}/cli/auth/exchange`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code, code_verifier: codeVerifier }),
      signal: AbortSignal.timeout(LOGIN_EXCHANGE_TIMEOUT_MS),
    });
  } catch (error) {
    if ((error as Error).name === "TimeoutError") {
      throw new ApiError(
        "login_timeout",
        "the login confirmation request timed out after 15 seconds — run `marina setup` to try again",
        408,
      );
    }
    throw error;
  }
  const body = (await res.json().catch(() => ({}))) as {
    token?: { token: string; name: string; prefix: string };
    error?: { code?: string; message?: string };
  };
  if (!res.ok || !body.token) {
    throw new ApiError(
      body.error?.code ?? "login_failed",
      body.error?.message ?? `login exchange failed (${String(res.status)})`,
      res.status,
    );
  }
  return body.token;
}

/** What Marina changed to make the project deployable, when it had to. */
export interface PreparationReport {
  transformation: "none" | "mechanical" | "behavioral";
  summary: string;
  changes: { path: string; summary: string }[];
  limitations: string[];
}

export interface DeployStatus {
  id: string;
  status: "queued" | "building" | "succeeded" | "refused" | "failed";
  refusal: { code: string; message: string; action: string } | null;
  error: string | null;
  build_log: string | null;
  app_slug: string | null;
  version_number: number | null;
  version_state: string | null;
  preparation: PreparationReport | null;
  /** Where the app serves — the server builds URLs, clients print them. */
  url: string | null;
  /** This exact build, digest-pinned — the review link for proposed versions. */
  version_url: string | null;
}

export async function startDeploy(
  zip: Uint8Array,
  name: string,
  app?: string,
): Promise<{ id: string }> {
  const form = new FormData();
  form.set(
    "code",
    new Blob([new Uint8Array(zip).buffer as ArrayBuffer], { type: "application/zip" }),
    "upload.zip",
  );
  form.set("name", name);
  form.set("source", "cli");
  if (app) form.set("app", app);
  const res = await request<{ deploy: { id: string } }>("/v1/deploys", {
    method: "POST",
    body: form,
  });
  return res.deploy;
}

export async function pollDeploy(
  id: string,
  onProgress: (deploy: DeployStatus) => void = () => undefined,
): Promise<DeployStatus> {
  for (;;) {
    const { deploy } = await request<{ deploy: DeployStatus }>(`/v1/deploys/${id}`);
    onProgress(deploy);
    if (deploy.status !== "queued" && deploy.status !== "building") return deploy;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

export interface AppRow {
  slug: string;
  emoji: string;
  name: string;
  status: string;
  version: number | null;
  url: string;
}

export async function listApps(): Promise<AppRow[]> {
  const res = await request<{ apps: AppRow[] }>("/v1/apps");
  return res.apps;
}

export interface AppDetail {
  app: {
    id: string;
    slug: string;
    name: string;
    status: string;
    current_version_id: string | null;
    archived_at: string | null;
    updated_at: string;
  };
  url: string;
}

export const getApp = (idOrSlug: string): Promise<AppDetail> =>
  request<AppDetail>(`/v1/apps/${encodeURIComponent(idOrSlug)}`);

export async function getAppUrl(idOrSlug: string): Promise<string> {
  return (await getApp(idOrSlug)).url;
}

export interface VersionRow {
  id: string;
  number: number;
  title: string;
  state: "draft" | "proposed" | "published";
  artifact_digest: string | null;
  created_at: string;
  published_at: string | null;
}

export async function listVersions(app: string): Promise<VersionRow[]> {
  const res = await request<{ versions: VersionRow[] }>(
    `/v1/apps/${encodeURIComponent(app)}/versions`,
  );
  return res.versions;
}

export interface DeployRow {
  id: string;
  status: DeployStatus["status"];
  refusal: DeployStatus["refusal"];
  error: string | null;
  source: string;
  created_at: string;
  finished_at: string | null;
  by_name: string | null;
}

export async function listDeploys(app: string, limit = 10): Promise<DeployRow[]> {
  const res = await request<{ deploys: DeployRow[] }>(
    `/v1/apps/${encodeURIComponent(app)}/deploys?limit=${String(limit)}`,
  );
  return res.deploys;
}

export async function restoreVersion(versionId: string): Promise<VersionRow> {
  const res = await request<{ version: VersionRow }>(`/v1/versions/${versionId}/restore`, {
    method: "POST",
  });
  return res.version;
}

export interface EnvRow {
  key: string;
  kind: "plain" | "secret";
  value: string | null;
}

export async function listEnv(app: string): Promise<EnvRow[]> {
  const res = await request<{ env: EnvRow[] }>(`/v1/apps/${encodeURIComponent(app)}/env`);
  return res.env;
}

export async function setEnv(
  app: string,
  key: string,
  value: string,
  secret: boolean,
): Promise<void> {
  await request(`/v1/apps/${encodeURIComponent(app)}/env/${encodeURIComponent(key)}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ value, kind: secret ? "secret" : "plain" }),
  });
}

export async function deleteEnv(app: string, key: string): Promise<void> {
  await request(`/v1/apps/${encodeURIComponent(app)}/env/${encodeURIComponent(key)}`, {
    method: "DELETE",
  });
}
