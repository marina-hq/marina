import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import * as api from "./api.ts";
import {
  apiUrl,
  controlPlaneHost,
  dashboardUrl,
  readLink,
  writeLink,
  type ProjectLink,
} from "./config.ts";
import { sourcePath, unpackSource } from "./source-archive.ts";

const hash = (bytes: Uint8Array | null): string | null =>
  bytes === null ? null : createHash("sha256").update(bytes).digest("hex");
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const revision = /^[a-f0-9]{40,64}$/;
const error = (code: string, message: string): never => {
  throw new api.ApiError(code, message, 409);
};

function validateSource(source: api.AppSource, zip?: Uint8Array): void {
  if (
    !uuid.test(source.app.id) ||
    !uuid.test(source.workspace.id) ||
    !revision.test(source.revision) ||
    !/^sha256:[a-f0-9]{64}$/.test(source.snapshot_digest)
  )
    throw new Error("invalid source metadata");
  sourcePath(source.app.slug);
  if (source.app.slug.includes("/")) throw new Error("invalid app slug");
  if (zip && `sha256:${hash(zip)}` !== source.snapshot_digest)
    throw new Error("source archive digest does not match its revision");
}

function sourceLink(source: api.AppSource): ProjectLink {
  return {
    app: source.app.slug,
    name: source.app.name,
    app_id: source.app.id,
    workspace_id: source.workspace.id,
    workspace_slug: source.workspace.slug,
    control_plane_host: controlPlaneHost(),
    api_origin: apiUrl(),
    base_revision: source.revision,
  };
}

/** Explicit URLs never fall back to an identically named app in another workspace. */
export async function resolveSourceTarget(input: string): Promise<string> {
  if (!input) return error("invalid_input", "pass an app URL, ID, or slug");
  if (!input.includes("://")) return input;
  const url = new URL(input);
  const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  const navigationOnly =
    [...url.searchParams].every(([key, value]) => key === "edit" && value === "true") &&
    ["", "#overview", "#versions", "#jobs", "#logs", "#settings"].includes(url.hash);
  if (
    url.origin !== dashboardUrl() ||
    url.username ||
    url.password ||
    !navigationOnly ||
    parts.length !== 3 ||
    parts[1] !== "apps"
  )
    return error("project_mismatch", `use an app dashboard URL from ${dashboardUrl()}`);
  const me = await api.me();
  if (me.workspace.slug !== parts[0])
    return error(
      "workspace_mismatch",
      `this app belongs to workspace ${parts[0]}; run marina setup and select that workspace`,
    );
  return parts[2]!;
}

export async function checkProjectContext(
  dir: string,
  explicitApp?: string,
): Promise<ProjectLink | null> {
  const link = readLink(dir);
  if (!link?.app_id) return link; // Older links are upgraded after a successful deploy.
  if (!uuid.test(link.app_id) || !link.workspace_id || !link.api_origin || !link.control_plane_host)
    return error(
      "invalid_link",
      "incomplete project identity; check out the app into a new directory",
    );
  if (link.api_origin !== apiUrl() || link.control_plane_host !== controlPlaneHost())
    return error(
      "project_mismatch",
      `this folder belongs to ${link.control_plane_host}; restore that CLI profile before using it`,
    );
  if (explicitApp && explicitApp !== link.app_id && explicitApp !== link.app)
    return error(
      "project_mismatch",
      "this folder is linked to a different app; use marina copy to create a separate app",
    );
  const me = await api.me();
  if (me.workspace.id !== link.workspace_id)
    return error(
      "workspace_mismatch",
      `this folder belongs to workspace ${link.workspace_slug ?? link.workspace_id}; run marina setup and select that workspace`,
    );
  return link;
}

// Never traverse a symlink from app source or local working files, including
// .marina. A local obstruction is reported for the agent to resolve explicitly.
function safePath(root: string, name: string): string {
  const parts = name.split("/");
  let path = root;
  for (let i = 0; i < parts.length; i++) {
    path = join(path, parts[i]!);
    try {
      const stat = lstatSync(path);
      if (stat.isSymbolicLink() || (i < parts.length - 1 && !stat.isDirectory()))
        return error(
          "local_obstruction",
          `cannot safely access ${name}; move the link or conflicting file and retry`,
        );
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
  }
  return path;
}

function localFile(dir: string, name: string): Uint8Array | null {
  const path = safePath(dir, name);
  try {
    if (!lstatSync(path).isFile())
      return error("local_obstruction", `${name} is not a regular file; move it and retry`);
    return readFileSync(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}

function atomicWrite(dir: string, name: string, bytes: Uint8Array | string): void {
  const path = safePath(dir, name);
  mkdirSync(dirname(path), { recursive: true });
  const temporary = join(dirname(path), `.marina-write-${randomUUID()}`);
  try {
    writeFileSync(temporary, bytes, { flag: "wx", mode: 0o600 });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function withLock<T>(dir: string, action: () => T): T {
  const home = safePath(dir, ".marina");
  mkdirSync(home, { recursive: true });
  const lock = safePath(dir, ".marina/source.lock");
  if (existsSync(lock)) {
    const pid = Number(readFileSync(lock, "utf8"));
    if (!Number.isSafeInteger(pid) || pid <= 0)
      return error(
        "source_locked",
        "invalid .marina/source.lock; verify no Marina command is running before removing it",
      );
    try {
      process.kill(pid, 0);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ESRCH") unlinkSync(lock);
      else throw e;
    }
  }
  try {
    writeFileSync(lock, String(process.pid), { flag: "wx", mode: 0o600 });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST")
      return error("source_locked", "another Marina command is updating this folder");
    throw e;
  }
  try {
    return action();
  } finally {
    unlinkSync(lock);
  }
}

export function assertNoPendingPull(dir: string): void {
  if (existsSync(safePath(dir, ".marina/source/pending")))
    error(
      "pull_pending",
      "finish the pending source reconciliation with marina pull --continue before deploying",
    );
}

export function assertCheckoutDestination(dir: string): void {
  try {
    const stat = lstatSync(dir);
    if (stat.isSymbolicLink() || !stat.isDirectory() || readdirSync(dir).length)
      error(
        "destination_not_empty",
        "checkout needs a new or empty directory; pass --dir <new-directory>",
      );
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
}

export function checkoutSource(source: api.AppSource, zip: Uint8Array, target: string): string {
  validateSource(source, zip);
  const files = unpackSource(zip);
  const dir = resolve(target);
  assertCheckoutDestination(dir);
  mkdirSync(dirname(dir), { recursive: true });
  const stage = mkdtempSync(join(dirname(dir), ".marina-checkout-"));
  try {
    for (const [name, bytes] of files) atomicWrite(stage, name, bytes);
    atomicWrite(stage, ".marina/source/base.zip", zip);
    atomicWrite(
      stage,
      ".marina/source/base.json",
      JSON.stringify({ revision: source.revision, digest: source.snapshot_digest }),
    );
    writeLink(stage, sourceLink(source));
    // rename refuses a destination that acquired files during download/staging.
    assertCheckoutDestination(dir);
    renameSync(stage, dir);
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
  return dir;
}

interface Change {
  path: string;
  before: string | null;
  after: string | null;
}
interface Pending {
  source: api.AppSource;
  from_revision: string;
  phase: "conflicts" | "applying";
  conflicts: string[];
  changes: Change[];
}
export interface PullResult {
  status: "up_to_date" | "updated" | "conflicts";
  revision: string;
  conflicts: { path: string; base: string | null; local: string | null; incoming: string | null }[];
  next_steps?: string[];
}

function pendingResult(dir: string, pending: Pending): PullResult {
  const root = join(dir, ".marina/source/pending/conflicts");
  return {
    status: "conflicts",
    revision: pending.source.revision,
    conflicts: pending.conflicts.map(
      (path) =>
        ({
          path,
          ...Object.fromEntries(
            ["base", "local", "incoming"].map((side) => [
              side,
              existsSync(join(root, side, path)) ? join(root, side, path) : null,
            ]),
          ),
        }) as PullResult["conflicts"][number],
    ),
    next_steps: [
      "Reconcile each conflicting file in the working directory. A null side means the file was absent.",
      "Run marina pull --continue to accept those resolutions. Deployment remains blocked until then.",
    ],
  };
}

function savePending(dir: string, pending: Pending): void {
  atomicWrite(dir, ".marina/source/pending/plan.json", JSON.stringify(pending));
}

function applyPending(dir: string, pending: Pending): PullResult {
  const zip = localFile(dir, ".marina/source/pending/incoming.zip")!;
  validateSource(pending.source, zip);
  const incoming = unpackSource(zip);
  // Preflight every write before changing anything. On interrupted retries a
  // file may already equal its intended result, which is safe to leave alone.
  for (const change of pending.changes) {
    const current = hash(localFile(dir, change.path));
    if (current !== change.before && current !== change.after)
      return error(
        "local_changed",
        `${change.path} changed during source recovery; save your changes, restore its incoming or prior contents, and run marina pull --continue`,
      );
  }
  for (const change of pending.changes) {
    const current = hash(localFile(dir, change.path));
    if (current === change.after) continue;
    if (current !== change.before)
      return error(
        "local_changed",
        `${change.path} changed while pulling; its contents were preserved`,
      );
    const bytes = incoming.get(change.path);
    if (bytes) atomicWrite(dir, change.path, bytes);
    else unlinkSync(safePath(dir, change.path));
  }
  atomicWrite(dir, ".marina/source/base.zip", zip);
  atomicWrite(
    dir,
    ".marina/source/base.json",
    JSON.stringify({ revision: pending.source.revision, digest: pending.source.snapshot_digest }),
  );
  safePath(dir, ".marina/project.json");
  writeLink(dir, sourceLink(pending.source));
  rmSync(safePath(dir, ".marina/source/pending"), { recursive: true });
  return { status: "updated", revision: pending.source.revision, conflicts: [] };
}

/** File-level three-way reconciliation. Conflict creation never changes the
 * working tree. A durable plan makes subsequent writes safe to resume. */
function reconcile(
  dir: string,
  source: api.AppSource,
  zip: Uint8Array,
  baseZip: Uint8Array,
): PullResult {
  validateSource(source, zip);
  const base = unpackSource(baseZip);
  const incoming = unpackSource(zip);
  const paths = new Map<string, string>();
  for (const name of [...base.keys(), ...incoming.keys()]) {
    const portable = name.normalize("NFC").toLowerCase();
    const previous = paths.get(portable);
    if (previous && previous !== name)
      return error(
        "path_conflict",
        `the source renames ${previous} to ${name}; check out a new folder and bring your local changes into it`,
      );
    paths.set(portable, name);
  }
  const link = readLink(dir)!;
  const pending: Pending = {
    source,
    from_revision: link.base_revision ?? "",
    phase: "applying",
    conflicts: [],
    changes: [],
  };
  const locals = new Map<string, Uint8Array>();
  for (const name of new Set([...base.keys(), ...incoming.keys()])) {
    const prior = hash(base.get(name) ?? null);
    const next = hash(incoming.get(name) ?? null);
    if (prior === next) continue;
    const local = localFile(dir, name);
    const current = hash(local);
    if (current === next) continue;
    if (current !== prior) {
      pending.conflicts.push(name);
      if (local) locals.set(name, local);
    } else pending.changes.push({ path: name, before: current, after: next });
  }
  if (pending.conflicts.length) pending.phase = "conflicts";
  const root = safePath(dir, ".marina/source");
  mkdirSync(root, { recursive: true });
  const stage = mkdtempSync(join(root, ".pending-"));
  try {
    atomicWrite(stage, "incoming.zip", zip);
    atomicWrite(stage, "base.zip", baseZip);
    for (const name of pending.conflicts) {
      for (const [side, files] of [
        ["base", base],
        ["local", locals],
        ["incoming", incoming],
      ] as const) {
        const bytes = files.get(name);
        if (bytes) atomicWrite(stage, `conflicts/${side}/${name}`, bytes);
      }
    }
    atomicWrite(stage, "plan.json", JSON.stringify(pending));
    renameSync(stage, join(root, "pending"));
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
  return pending.phase === "conflicts" ? pendingResult(dir, pending) : applyPending(dir, pending);
}

export function pullSource(dir: string, source: api.AppSource, zip: Uint8Array): PullResult {
  return withLock(dir, () => {
    assertNoPendingPull(dir);
    const link = readLink(dir);
    if (!link?.app_id || link.app_id !== source.app.id || link.workspace_id !== source.workspace.id)
      return error("project_mismatch", "source does not match this folder's app and workspace");
    validateSource(source, zip);
    const base = localFile(dir, ".marina/source/base.zip");
    if (!base || !link.base_revision)
      return error(
        "baseline_missing",
        "this folder has no exact source baseline; check out a new folder and bring your local changes into it",
      );
    const saved = JSON.parse(
      new TextDecoder().decode(localFile(dir, ".marina/source/base.json") ?? new Uint8Array()),
    ) as { revision: string; digest: string };
    if (saved.revision !== link.base_revision || saved.digest !== `sha256:${hash(base)}`)
      return error(
        "baseline_invalid",
        "the local source baseline is damaged; check out a new folder and bring your local changes into it",
      );
    if (link.base_revision === source.revision) {
      if (hash(base) !== hash(zip))
        throw new Error("cached source does not match its revision; check out a new folder");
      return { status: "up_to_date", revision: source.revision, conflicts: [] };
    }
    return reconcile(dir, source, zip, base);
  });
}

export function continuePull(dir: string): PullResult {
  return withLock(dir, () => {
    const plan = localFile(dir, ".marina/source/pending/plan.json");
    if (!plan)
      return error(
        "no_pending_pull",
        "there is no source reconciliation to continue; run marina pull",
      );
    const pending = JSON.parse(new TextDecoder().decode(plan)) as Pending;
    const link = readLink(dir);
    if (
      link?.app_id !== pending.source.app.id ||
      link.workspace_id !== pending.source.workspace.id ||
      ((link.base_revision ?? "") !== pending.from_revision &&
        link.base_revision !== pending.source.revision)
    )
      return error("project_mismatch", "the project identity changed during source recovery");
    for (const change of pending.changes) sourcePath(change.path);
    if (pending.phase === "conflicts") {
      // --continue explicitly accepts working-tree contents for the listed
      // conflicts, including deletion. Other files still get race checks.
      for (const name of pending.conflicts) {
        sourcePath(name);
        localFile(dir, name);
      }
      pending.phase = "applying";
      savePending(dir, pending);
    }
    return applyPending(dir, pending);
  });
}

/** Use exactly the source the server prepared. Independent changes made while
 * the deploy ran are retained; overlapping transformations become normal pull
 * conflicts, with the already successful deployment left intact. */
export function acceptDeployedSource(
  dir: string,
  source: api.AppSource,
  canonicalZip: Uint8Array,
  submittedZip: Uint8Array,
  expectedLink?: ProjectLink | null,
): PullResult {
  return withLock(dir, () => {
    assertNoPendingPull(dir);
    validateSource(source, canonicalZip);
    const link = readLink(dir);
    if (expectedLink !== undefined && JSON.stringify(link) !== JSON.stringify(expectedLink))
      return error(
        "local_link_changed",
        "the folder's source baseline changed during deployment; keep its current state and run marina pull",
      );
    if (
      link?.app_id &&
      (link.app_id !== source.app.id || link.workspace_id !== source.workspace.id)
    )
      return error("project_mismatch", "deployed source belongs to a different app");
    if (!link?.app_id)
      writeLink(dir, { ...sourceLink(source), base_revision: link?.base_revision });
    return reconcile(dir, source, canonicalZip, submittedZip);
  });
}

export async function checkoutApp(input: string, directory?: string) {
  const target = await resolveSourceTarget(input);
  const source = await api.getAppSource(target);
  validateSource(source);
  const dir = checkoutSource(
    source,
    await api.downloadSource(source),
    directory ?? source.app.slug,
  );
  return { source, dir };
}

export async function makeCopy(
  input: string,
  name: string,
  directory?: string,
  selection: { editable?: boolean; version?: string } = {},
) {
  if (!name.trim()) return error("invalid_input", "pass --name for the new app");
  const target = await resolveSourceTarget(input);
  const original = await api.getAppSource(target);
  validateSource(original);
  const dir = resolve(directory ?? `${original.app.slug}-copy`);
  assertCheckoutDestination(dir);
  mkdirSync(dirname(dir), { recursive: true });
  const receipt = join(dirname(dir), `.${basename(dir)}.marina-copy.json`);
  const intent = {
    app_id: original.app.id,
    workspace_id: original.workspace.id,
    api_origin: apiUrl(),
    name: name.trim(),
    ...selection,
  };
  let requestId: string = randomUUID();
  if (existsSync(receipt)) {
    if (!lstatSync(receipt).isFile() || lstatSync(receipt).isSymbolicLink())
      return error("local_obstruction", "copy receipt is not a regular file");
    const previous = JSON.parse(readFileSync(receipt, "utf8")) as {
      intent: typeof intent;
      request_id: string;
    };
    if (
      JSON.stringify(previous.intent) !== JSON.stringify(intent) ||
      !uuid.test(previous.request_id)
    )
      return error(
        "copy_pending",
        `a different copy is pending for this directory; choose another --dir or inspect ${receipt}`,
      );
    requestId = previous.request_id;
  } else
    writeFileSync(receipt, JSON.stringify({ intent, request_id: requestId }), {
      flag: "wx",
      mode: 0o600,
    });
  const source = await api.copyApp(original.app.id, {
    name: intent.name,
    request_id: requestId,
    ...selection,
  });
  if (source.app.id === original.app.id || source.workspace.id !== original.workspace.id)
    return error(
      "copy_mismatch",
      "Marina did not return an independent app in this workspace; the local folder was left unchanged",
    );
  checkoutSource(source, await api.downloadSource(source), dir);
  unlinkSync(receipt);
  return { source, dir };
}
