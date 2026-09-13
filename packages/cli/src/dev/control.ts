import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import {
  mkdirSync,
  realpathSync,
  rmdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import type { LocalDatabase } from "./db.ts";

export interface DatabaseCommand {
  action: "tables" | "schema" | "query" | "migrations" | "migrate" | "reset";
  table?: string;
  schema?: string;
  sql?: string;
  params?: unknown[];
  limit?: number;
  write?: boolean;
  yes?: boolean;
}

interface Session {
  pid: number;
  port: number;
  token: string;
  project: string;
}

const sessionPath = (project: string) => join(project, ".marina", "dev", "control.json");
const LIMIT = 128 * 1024;

function readSession(project: string): Session {
  const session = JSON.parse(readFileSync(sessionPath(project), "utf8")) as Session;
  if (
    session.project !== project ||
    !Number.isInteger(session.pid) ||
    session.pid < 1 ||
    !Number.isInteger(session.port) ||
    session.port < 1 ||
    session.port > 65535 ||
    typeof session.token !== "string" ||
    !/^[a-f0-9]{64}$/.test(session.token)
  )
    throw new Error("invalid local development session; restart marina dev");
  return session;
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/** Local-only, authenticated control channel. It is separate from the app's
 * HTTP server: app JavaScript never receives the token or a debug route. */
export async function startDevControl(projectDir: string, database: () => LocalDatabase | null) {
  const project = realpathSync(resolve(projectDir));
  const path = sessionPath(project);
  mkdirSync(join(project, ".marina", "dev"), { recursive: true });
  // Serialize stale-session recovery as well as first startup. Otherwise two
  // processes recovering the same stale PID could unlink each other's lease.
  const startupLock = join(project, ".marina", "dev", "start.lock");
  try {
    mkdirSync(startupLock);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST")
      throw new Error(
        "marina dev startup is already in progress; if a previous startup crashed, remove .marina/dev/start.lock and retry",
        { cause: error },
      );
    throw error;
  }
  try {
    try {
      const previous = readSession(project);
      if (isRunning(previous.pid))
        throw new Error("marina dev is already running for this project");
      unlinkSync(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }

    const token = randomBytes(32).toString("hex");
    const server = createServer(async (req, res) => {
      res.setHeader("content-type", "application/json");
      res.setHeader("cache-control", "no-store");
      if (req.headers.origin || req.headers.authorization !== `Bearer ${token}`) {
        res
          .writeHead(403)
          .end(JSON.stringify({ error: "local development authorization required" }));
        return;
      }
      if (req.method !== "POST" || req.url !== "/db") {
        res.writeHead(404).end(JSON.stringify({ error: "not found" }));
        return;
      }
      try {
        const chunks: Buffer[] = [];
        let bytes = 0;
        for await (const chunk of req) {
          const buffer = Buffer.from(chunk as Uint8Array);
          bytes += buffer.length;
          if (bytes > LIMIT) throw new Error("database command exceeds 128 KB");
          chunks.push(buffer);
        }
        const body = Buffer.concat(chunks).toString("utf8");
        const db = database();
        if (!db)
          throw new Error(
            'this app has no local database; declare runtime.db: "v1" in marina.json',
          );
        const command = JSON.parse(body) as DatabaseCommand;
        let value: unknown;
        switch (command.action) {
          case "tables":
            value = { tables: await db.tables() };
            break;
          case "schema":
            if (typeof command.table !== "string" || !command.table)
              throw new Error("a table name is required");
            if (command.schema !== undefined && typeof command.schema !== "string")
              throw new Error("invalid schema");
            value = await db.schema(command.table, command.schema ?? "public");
            break;
          case "query": {
            if (typeof command.sql !== "string" || !command.sql.trim())
              throw new Error("SQL is required");
            if (command.params !== undefined && !Array.isArray(command.params))
              throw new Error("params must be a JSON array");
            const limit = command.limit ?? 100;
            if (!Number.isInteger(limit) || limit < 1 || limit > 1000)
              throw new Error("limit must be between 1 and 1000");
            value = await db.inspect(
              command.sql,
              command.params ?? [],
              limit,
              command.write === true,
            );
            break;
          }
          case "migrations":
            value = { migrations: await db.migrations(project) };
            break;
          case "migrate":
            value = { applied: await db.applyMigrations(project) };
            break;
          case "reset":
            if (command.yes !== true)
              throw new Error("reset deletes this app's local database; pass --yes to confirm");
            value = { applied: await db.reset(project) };
            break;
          default:
            throw new Error("unknown database command");
        }
        res.end(JSON.stringify({ ok: true, value }));
      } catch (error) {
        res.writeHead(400).end(JSON.stringify({ ok: false, error: (error as Error).message }));
      }
    });
    await new Promise<void>((ready, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", ready);
    });
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("local control server did not start");
    const session: Session = { pid: process.pid, port: address.port, token, project };
    const closeServer = () => new Promise<void>((done) => server.close(() => done()));
    try {
      writeFileSync(path, JSON.stringify(session), { mode: 0o600, flag: "wx" });
    } catch (error) {
      await closeServer();
      throw error;
    }
    return {
      async close() {
        await closeServer();
        try {
          if (readSession(project).token === token) unlinkSync(path);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      },
    };
  } finally {
    rmdirSync(startupLock);
  }
}

export async function callDevDatabase(
  projectDir: string,
  command: DatabaseCommand,
): Promise<Record<string, unknown>> {
  const project = realpathSync(resolve(projectDir));
  let session: Session;
  try {
    session = readSession(project);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      throw new Error("start marina dev for this project before using marina db", { cause: error });
    throw error;
  }
  let response: Response;
  try {
    response = await fetch(`http://127.0.0.1:${String(session.port)}/db`, {
      method: "POST",
      headers: { authorization: `Bearer ${session.token}`, "content-type": "application/json" },
      body: JSON.stringify(command),
      signal: AbortSignal.timeout(30_000),
      redirect: "error",
    });
  } catch {
    throw new Error("cannot reach this project's local database; check marina dev is running");
  }
  const result = (await response.json()) as {
    ok?: boolean;
    value?: Record<string, unknown>;
    error?: string;
  };
  if (!response.ok || !result.ok || !result.value)
    throw new Error(result.error ?? "local database command failed");
  return result.value;
}
