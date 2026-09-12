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

/** Render untrusted summary text without allowing terminal control. */
export function terminalSafeText(value: string): string {
  return Array.from(value, (character) => {
    const code = character.codePointAt(0) ?? 0;
    if (code >= 32 && (code < 127 || code > 159)) return character;
    if (code === 9) return "\\t";
    if (code === 10) return "\\n";
    if (code === 13) return "\\r";
    return `\\u{${code.toString(16).padStart(4, "0")}}`;
  }).join("");
}

/** JSON already escapes C0 string controls. Escape DEL and C1 as well so the
 * serialized document is inert in a terminal while parsing back losslessly. */
export function terminalSafeJson(payload: object, space?: number): string {
  return Array.from(JSON.stringify(payload, null, space), (character) => {
    const code = character.codePointAt(0) ?? 0;
    return code >= 127 && code <= 159 ? `\\u${code.toString(16).padStart(4, "0")}` : character;
  }).join("");
}

/** Human-facing line. Moves to stderr in --json so stdout stays parseable. */
export function say(line = ""): void {
  if (json) console.error(line);
  else console.log(line);
}

/** Progress and diagnostics: stderr always, so piping never loses them. */
export function note(line: string): void {
  console.error(line);
}

/** One updating terminal line for humans; one JSON event per phase for agents
 * and redirected output. Final command output remains untouched. */
export function createProgress(): {
  update: (phase: string, line: string) => void;
  clear: () => void;
} {
  let active = false;
  let lastPhase: string | null = null;
  let frame = 0;
  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  const interactive = process.stderr.isTTY === true && !json;
  return {
    update(phase, line) {
      if (interactive) {
        process.stderr.write(`\r\u001b[2K${frames[frame++ % frames.length]} ${line}`);
        active = true;
      } else if (phase !== lastPhase) {
        console.error(json ? terminalSafeJson({ type: "progress", phase, message: line }) : line);
      }
      lastPhase = phase;
    },
    clear() {
      if (active) process.stderr.write("\r\u001b[2K");
      active = false;
    },
  };
}

/** The machine result. Printed once whenever structured mode is active. */
export function result(payload: object): void {
  if (json) console.log(terminalSafeJson({ schema_version: 1, ok: true, ...payload }, 2));
}

/** The machine-readable failure, mirroring the API's error shape. */
export function failure(code: string, message: string, extra: Record<string, unknown> = {}): void {
  if (json)
    console.log(
      terminalSafeJson({ schema_version: 1, ok: false, error: { code, message, ...extra } }, 2),
    );
  else {
    console.error(`${red(terminalSafeText(code))} ${terminalSafeText(message)}`);
  }
}
