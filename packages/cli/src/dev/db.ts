import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { PGlite, messages } from "@electric-sql/pglite";

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

type PgliteLike = Pick<
  PGlite,
  "query" | "exec" | "transaction" | "close" | "describeQuery" | "execProtocol" | "runExclusive"
>;

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
  private pending: Promise<unknown> = Promise.resolve();
  private db: PgliteLike;
  private readonly dataDir: string;
  private constructor(db: PgliteLike, dataDir: string) {
    this.db = db;
    this.dataDir = dataDir;
  }

  // Reset, inspection, migrations, and app queries share one owner and queue.
  // No second PGlite instance ever opens the running app's data directory.
  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.pending.then(operation);
    this.pending = next.catch(() => undefined);
    return next;
  }

  close(): Promise<void> {
    return this.exclusive(() => this.db.close());
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
    return new LocalDatabase(new module.PGlite(dataDir), dataDir);
  }

  /** Apply the app's marina/migrations in name order, once each — the same
   * files a deploy applies to the managed database. */
  applyMigrations(projectDir: string): Promise<string[]> {
    return this.exclusive(() => this.migrate(projectDir));
  }

  private async migrate(projectDir: string): Promise<string[]> {
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
    return this.exclusive(async () => {
      const result = await this.db.query(text, params);
      const rows = result.rows.map(normalizeRow);
      return { rows, rowCount: rows.length > 0 ? rows.length : (result.affectedRows ?? 0) };
    });
  }

  async transaction(
    queries: readonly { text: string; params: unknown[] }[],
  ): Promise<{ rows: Record<string, DatabaseValue>[]; rowCount: number }[]> {
    return this.exclusive(() =>
      this.db.transaction(async (tx) => {
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
      }),
    );
  }

  inspect(sql: string, params: unknown[], limit: number, write: boolean) {
    return this.exclusive(() =>
      this.db.transaction(async (tx) => {
        if (!write) await tx.exec("set transaction read only");
        await tx.exec("set local statement_timeout = '10s'");
        // PGlite's query() materializes the whole result. A bounded Execute
        // message stops the Postgres portal after one extra row, preserving
        // parameters and supporting SELECT, EXPLAIN and write RETURNING alike.
        return this.db.runExclusive(async () => {
          const { protocol } = await import("@electric-sql/pglite");
          const description = await this.db.describeQuery(sql);
          const values = params.map((value, index) => {
            if (value === null || value === undefined) return null;
            const serialize = description.queryParams[index]?.serializer;
            return serialize ? serialize(value) : String(value);
          });
          const execute = (message: Uint8Array) =>
            this.db.execProtocol(message, { syncToFs: false });
          try {
            await execute(protocol.serialize.bind({ portal: "marina_inspection", values }));
            const result = await execute(
              protocol.serialize.execute({ portal: "marina_inspection", rows: limit + 1 }),
            );
            await execute(protocol.serialize.close({ type: "P", name: "marina_inspection" }));
            const rows: Record<string, DatabaseValue>[] = [];
            let seen = 0;
            let affectedRows = 0;
            for (const message of result.messages) {
              if (message.name === "dataRow") {
                seen++;
                if (seen > limit) continue;
                const row = (message as messages.DataRowMessage).fields;
                rows.push(
                  normalizeRow(
                    Object.fromEntries(
                      row.map((value, index) => {
                        const field = description.resultFields[index]!;
                        return [
                          field.name,
                          value === null ? null : field.parser ? field.parser(value) : value,
                        ];
                      }),
                    ),
                  ),
                );
              } else if (message.name === "commandComplete") {
                const tag = (message as messages.CommandCompleteMessage).text;
                const count = /^(?:INSERT \d+|UPDATE|DELETE|MERGE|COPY|SELECT) (\d+)$/.exec(tag);
                affectedRows = Number(count?.[1] ?? 0);
              }
            }
            return {
              rows,
              rowCount: description.resultFields.length ? rows.length : affectedRows,
              truncated: seen > limit,
            };
          } finally {
            // Restore protocol readiness even after a SQL error so transaction
            // rollback and later app queries can use the same database owner.
            await execute(protocol.serialize.sync());
          }
        });
      }),
    );
  }

  async tables() {
    return (
      await this.query(
        `
      select table_schema as schema, table_name as name, table_type as type
      from information_schema.tables
      where table_schema not in ('pg_catalog', 'information_schema')
        and table_name <> 'marina_dev_migrations'
      order by table_schema, table_name`,
        [],
      )
    ).rows;
  }

  async schema(table: string, schema: string) {
    const columns = (
      await this.query(
        `
      select column_name as name, data_type as type, is_nullable = 'YES' as nullable,
             column_default as default, is_identity = 'YES' as identity
      from information_schema.columns
      where table_schema = $1 and table_name = $2 order by ordinal_position`,
        [schema, table],
      )
    ).rows;
    if (!columns.length) throw new Error(`no local table ${schema}.${table}`);
    const indexes = (
      await this.query(
        `
      select indexname as name, indexdef as definition from pg_indexes
      where schemaname = $1 and tablename = $2 order by indexname`,
        [schema, table],
      )
    ).rows;
    return { schema, table, columns, indexes };
  }

  async migrations(projectDir: string) {
    const directory = join(projectDir, "marina", "migrations");
    const files = existsSync(directory)
      ? readdirSync(directory).filter((name) => name.endsWith(".sql"))
      : [];
    const applied = (
      await this.query("select name, applied_at from marina_dev_migrations order by name", [])
    ).rows;
    return [...new Set([...files, ...applied.map((row) => String(row.name))])]
      .toSorted()
      .map((name) => {
        const row = applied.find((candidate) => candidate.name === name);
        return {
          name,
          status: !files.includes(name) ? "missing" : row ? "applied" : "pending",
          applied_at: row?.applied_at ?? null,
        };
      });
  }

  reset(projectDir: string): Promise<string[]> {
    return this.exclusive(async () => {
      await this.db.close();
      rmSync(this.dataDir, { recursive: true, force: true });
      const fresh = await LocalDatabase.open(this.dataDir);
      this.db = fresh.db;
      return this.migrate(projectDir);
    });
  }
}
