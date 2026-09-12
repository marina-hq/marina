import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Local, embedded Postgres for `marina.db` — PGlite runs inside this
 * process, so there is no Docker and no external service, while the app's
 * marina/migrations and SQL behave with real Postgres semantics. */

type DatabaseValue =
  | null
  | boolean
  | number
  | string
  | DatabaseValue[]
  | { [key: string]: DatabaseValue };

interface PgliteLike {
  query(text: string, params?: unknown[]): Promise<{ rows: unknown[]; affectedRows?: number }>;
  exec(text: string): Promise<unknown>;
  transaction<T>(callback: (tx: PgliteLike) => Promise<T>): Promise<T>;
}

function normalizeValue(value: unknown): DatabaseValue {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : (String(value) as never);
  if (typeof value === "bigint") {
    return value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER)
      ? Number(value)
      : value.toString();
  }
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Uint8Array) return Buffer.from(value).toString("base64");
  if (Array.isArray(value)) return value.map(normalizeValue);
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
        key,
        normalizeValue(entry),
      ]),
    );
  }
  return String(value);
}

function normalizeRow(row: unknown): Record<string, DatabaseValue> {
  if (!row || typeof row !== "object") return {};
  return Object.fromEntries(
    Object.entries(row as Record<string, unknown>).map(([key, value]) => [
      key,
      normalizeValue(value),
    ]),
  );
}

export class LocalDatabase {
  private readonly db: PgliteLike;

  private constructor(db: PgliteLike) {
    this.db = db;
  }

  static async open(dataDir: string): Promise<LocalDatabase> {
    let module: { PGlite: new (dir: string) => PgliteLike };
    try {
      module = (await import("@electric-sql/pglite")) as unknown as {
        PGlite: new (dir: string) => PgliteLike;
      };
    } catch {
      throw new Error(
        "the embedded Postgres could not load — reinstall the Marina CLI (@electric-sql/pglite is missing)",
      );
    }
    mkdirSync(dataDir, { recursive: true });
    return new LocalDatabase(new module.PGlite(dataDir));
  }

  /** Apply the app's marina/migrations in name order, once each — the same
   * files a deploy applies to the managed database. */
  async applyMigrations(projectDir: string): Promise<string[]> {
    const directory = join(projectDir, "marina", "migrations");
    await this.db.exec(
      "create table if not exists marina_dev_migrations (name text primary key, applied_at timestamptz not null default now())",
    );
    if (!existsSync(directory)) return [];
    const files = readdirSync(directory)
      .filter((file) => file.endsWith(".sql"))
      .toSorted();
    const applied: string[] = [];
    for (const file of files) {
      const seen = await this.db.query("select 1 from marina_dev_migrations where name = $1", [
        file,
      ]);
      if (seen.rows.length > 0) continue;
      const source = readFileSync(join(directory, file), "utf8");
      await this.db.transaction(async (tx) => {
        await tx.exec(source);
        await tx.query("insert into marina_dev_migrations (name) values ($1)", [file]);
      });
      applied.push(file);
    }
    return applied;
  }

  async query(
    text: string,
    params: unknown[],
  ): Promise<{ rows: Record<string, DatabaseValue>[]; rowCount: number }> {
    const result = await this.db.query(text, params);
    const rows = result.rows.map(normalizeRow);
    return { rows, rowCount: rows.length > 0 ? rows.length : (result.affectedRows ?? 0) };
  }

  async transaction(
    queries: readonly { text: string; params: unknown[] }[],
  ): Promise<{ rows: Record<string, DatabaseValue>[]; rowCount: number }[]> {
    return this.db.transaction(async (tx) => {
      const results = [];
      for (const query of queries) {
        const result = await tx.query(query.text, query.params);
        const rows = result.rows.map(normalizeRow);
        results.push({
          rows,
          rowCount: rows.length > 0 ? rows.length : (result.affectedRows ?? 0),
        });
      }
      return results;
    });
  }
}
