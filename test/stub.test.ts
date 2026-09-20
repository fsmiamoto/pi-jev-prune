import assert from "node:assert/strict";
import test from "node:test";
import { isStub, stubText } from "../src/stub.ts";

test("stub format: tool, key arg, lines, tokens, recall hint", () => {
  const s = stubText({ toolCallId: "call_1", tool: "read", keyArg: "src/cli.rs", lines: 120, sizeTokens: 1500, isError: false });
  assert.equal(s, '[pruned: read src/cli.rs — 120 lines/~1500 tok. Use recall("call_1") to restore.]');
  assert.ok(isStub(s));
});

test("stub marks errors and omits missing key arg", () => {
  const s = stubText({ toolCallId: "c", tool: "bash", keyArg: "", lines: 3, sizeTokens: 400, isError: true });
  assert.equal(s, '[pruned: bash — 3 lines/~400 tok, error. Use recall("c") to restore.]');
});

test("stub is deterministic (same input → same bytes)", () => {
  const input = { toolCallId: "a", tool: "grep", keyArg: "foo", lines: 9, sizeTokens: 900, isError: false };
  assert.equal(stubText(input), stubText({ ...input }));
});

test("isStub rejects ordinary output", () => {
  assert.equal(isStub("hello"), false);
  assert.equal(isStub(""), false);
});
