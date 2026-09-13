import { readFileSync } from "node:fs";
import { inspectAppDatabase } from "./api.ts";
import { resolveControlPlane } from "./config.ts";
import { callDevDatabase, type DatabaseCommand } from "./dev/control.ts";
import { result, say, terminalSafeJson } from "./output.ts";

export async function runDatabaseCommand(
  positionals: string[],
  options: {
    app?: string;
    dir?: string;
    file?: string;
    params?: string;
    schema?: string;
    limit?: string;
    write?: boolean;
    yes?: boolean;
  },
) {
  const action = positionals[1];
  if (
    !action ||
    !["tables", "schema", "query", "migrations", "migrate", "reset"].includes(action)
  ) {
    throw new Error(
      "usage: marina db tables|schema <table>|query <sql>|migrations|migrate|reset [--dir <project> | --app <app>] [--json]",
    );
  }
  const command: DatabaseCommand = { action: action as DatabaseCommand["action"] };
  if (action === "schema") {
    command.table = positionals[2];
    command.schema = options.schema;
  }
  if (action === "query") {
    if (options.file && positionals[2]) throw new Error("provide SQL or --file, not both");
    command.sql = options.file ? readFileSync(options.file, "utf8") : positionals[2];
    command.params = options.params ? (JSON.parse(options.params) as unknown[]) : [];
    command.limit = options.limit ? Number(options.limit) : 100;
    command.write = options.write === true;
  }
  if (action === "reset") command.yes = options.yes === true;
  if (options.app !== undefined) {
    if (!options.app.trim()) throw new Error("--app must name an app");
    if (options.dir !== undefined)
      throw new Error("choose --app for production or --dir for local inspection");
    if (options.schema !== undefined)
      throw new Error("--app fixes the database schema; use an unqualified table name");
    if (options.write || options.yes || !["tables", "schema", "query"].includes(action))
      throw new Error(
        "deployed databases support read-only tables, schema, and query inspection; writes, migrations, and reset are local only",
      );
    await resolveControlPlane();
    const data = await inspectAppDatabase(options.app, {
      action: action as "tables" | "schema" | "query",
      ...(action === "schema" ? { table: command.table } : {}),
      ...(action === "query"
        ? { sql: command.sql, params: command.params, limit: command.limit }
        : {}),
    });
    say(terminalSafeJson(data, 2));
    result({ command: `db.${action}`, ...data });
    return;
  }
  const data = await callDevDatabase(options.dir ?? ".", command);
  say(terminalSafeJson(data, 2));
  result({ command: `db.${action}`, environment: "local", ...data });
}
