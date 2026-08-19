// oxlint-disable no-console -- it's a CLI
// Two audiences, one binary. Humans get prose on stdout; agents pass --json
// and get exactly one JSON document on stdout with everything else pushed to
// stderr, so `marina deploy --json | jq` is never polluted by progress.

let json = false;

export const setJsonMode = (on: boolean): void => {
  json = on;
};
export const isJsonMode = (): boolean => json;

export const bold = (s: string) => `[1m${s}[22m`;
export const dim = (s: string) => `[2m${s}[22m`;
export const red = (s: string) => `[31m${s}[39m`;
export const green = (s: string) => `[32m${s}[39m`;

/** Human-facing line. Moves to stderr in --json so stdout stays parseable. */
export function say(line = ""): void {
  if (json) console.error(line);
  else console.log(line);
}

/** Progress and diagnostics: stderr always, so piping never loses them. */
export function note(line: string): void {
  console.error(line);
}

/** The machine result. Printed only in --json, exactly once per run. */
export function result(payload: object): void {
  if (json) console.log(JSON.stringify({ schema_version: 1, ok: true, ...payload }, null, 2));
}

/** The machine-readable failure, mirroring the API's error shape. */
export function failure(code: string, message: string, extra: Record<string, unknown> = {}): void {
  if (json)
    console.log(
      JSON.stringify({ schema_version: 1, ok: false, error: { code, message, ...extra } }, null, 2),
    );
  else {
    console.error(`${red(code)} ${message}`);
  }
}
