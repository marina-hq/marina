import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { terminalSafeJson, terminalSafeText } from "./output.ts";

function assertTerminalSafeJson(value: string): void {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    assert.equal(code === 10 || (code >= 32 && (code < 127 || code > 159)), true);
  }
}

describe("structured terminal output", () => {
  it("escapes terminal controls and parses back losslessly", () => {
    const payload = { message: "line\n\u001b]0;title\u0007\u007f\u009b31mstill data" };
    const serialized = terminalSafeJson(payload, 2);

    assertTerminalSafeJson(serialized);
    assert.match(serialized, /\\u001b/);
    assert.match(serialized, /\\u007f/);
    assert.match(serialized, /\\u009b/);
    assert.deepEqual(JSON.parse(serialized), payload);
  });

  it("makes untrusted human summaries inert", () => {
    assert.equal(
      terminalSafeText("first\nsecond\u001b]0;spoofed\u0007\u009b31m"),
      "first\\nsecond\\u{001b}]0;spoofed\\u{0007}\\u{009b}31m",
    );
  });
});
