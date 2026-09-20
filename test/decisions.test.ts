import assert from "node:assert/strict";
import test from "node:test";
import { type Decision, DecisionStore, decisionFromEntry, ENTRY_TYPE } from "../src/decisions.ts";

function d(id: string, verdict: Decision["verdict"], step = 0, p?: number): Decision {
  return { toolCallId: id, verdict, p, reason: "t", tool: "read", keyArg: "a", sizeTokens: 500, turnsAgo: 4, step, at: "2026-01-01T00:00:00Z" };
}

test("prune is sticky: keep cannot override it", () => {
  const s = new DecisionStore();
  assert.ok(s.set(d("a", "prune")));
  assert.equal(s.set(d("a", "keep")), false);
  assert.equal(s.get("a")?.verdict, "prune");
  assert.ok(s.isStubbed("a"));
  assert.ok(s.isFinal("a"));
});

test("keep is transient: prune can override it", () => {
  const s = new DecisionStore();
  s.set(d("a", "keep"));
  assert.equal(s.isFinal("a"), false);
  assert.equal(s.isStubbed("a"), false);
  assert.ok(s.set(d("a", "prune")));
  assert.ok(s.isStubbed("a"));
});

test("recall overrides prune, then nothing overrides recall", () => {
  const s = new DecisionStore();
  s.set(d("a", "prune"));
  assert.ok(s.set(d("a", "recall")));
  assert.ok(s.isStubbed("a"), "recalled original stays stubbed");
  assert.equal(s.set(d("a", "prune")), false);
  assert.equal(s.set(d("a", "keep")), false);
  assert.equal(s.get("a")?.verdict, "recall");
});

test("pin is absolute and never stubbed", () => {
  const s = new DecisionStore();
  s.set(d("a", "pin"));
  assert.equal(s.set(d("a", "prune")), false);
  assert.equal(s.set(d("a", "recall")), false);
  assert.equal(s.isStubbed("a"), false);
  assert.ok(s.isFinal("a"));
});

test("staged: not stubbed, not final; blocks keep and re-staging; prune/recall override it; never persisted", () => {
  const s = new DecisionStore();
  assert.ok(s.set(d("a", "staged", 3, 0.1)));
  assert.ok(s.isStaged("a"));
  assert.equal(s.isStubbed("a"), false);
  assert.equal(s.isFinal("a"), false);
  assert.equal(s.set(d("a", "keep", 4, 0.9)), false, "a later keep does not flip a staged prune");
  assert.equal(s.set(d("a", "staged", 4, 0.1)), false, "re-staging is a no-op (no duplicate log)");
  assert.ok(s.set(d("a", "prune", 5, 0.1)));
  assert.ok(s.isStubbed("a"));
  assert.equal(s.set(d("a", "staged", 6)), false, "prune is not demoted to staged");
  s.set(d("b", "staged"));
  assert.ok(s.set(d("b", "recall")));
  assert.equal(decisionFromEntry({ type: "custom", customType: ENTRY_TYPE, data: d("c", "staged") }), undefined);
});

test("isFreshKeep: keep decided at/after the given step is fresh", () => {
  const s = new DecisionStore();
  s.set(d("a", "keep", 5));
  assert.ok(s.isFreshKeep("a", 5));
  assert.ok(s.isFreshKeep("a", 4));
  assert.equal(s.isFreshKeep("a", 6), false);
  s.set(d("b", "prune", 5));
  assert.equal(s.isFreshKeep("b", 5), false);
});

test("fromEntries rebuilds sticky verdicts only, ignoring foreign/malformed entries", () => {
  const entries = [
    { type: "custom", customType: ENTRY_TYPE, data: d("a", "prune", 2, 0.1) },
    { type: "custom", customType: ENTRY_TYPE, data: d("b", "keep") },
    { type: "custom", customType: ENTRY_TYPE, data: d("c", "recall") },
    { type: "custom", customType: ENTRY_TYPE, data: d("d", "pin") },
    { type: "custom", customType: "other", data: d("e", "prune") },
    { type: "message", message: { role: "user", content: "x" } },
    { type: "custom", customType: ENTRY_TYPE, data: { verdict: "prune" } },
    { type: "custom", customType: ENTRY_TYPE, data: null },
    null,
    "str",
  ];
  const s = DecisionStore.fromEntries(entries);
  assert.deepEqual(
    s.all().map((x) => [x.toolCallId, x.verdict]).sort(),
    [
      ["a", "prune"],
      ["c", "recall"],
      ["d", "pin"],
    ],
  );
  assert.equal(s.get("a")?.p, 0.1);
});

test("fromEntries replays order: prune then recall → recall", () => {
  const s = DecisionStore.fromEntries([
    { type: "custom", customType: ENTRY_TYPE, data: d("a", "prune") },
    { type: "custom", customType: ENTRY_TYPE, data: d("a", "recall") },
  ]);
  assert.equal(s.get("a")?.verdict, "recall");
});

test("decisionFromEntry fills defaults for missing optional fields", () => {
  const x = decisionFromEntry({ type: "custom", customType: ENTRY_TYPE, data: { toolCallId: "z", verdict: "prune" } });
  assert.deepEqual(x, { toolCallId: "z", verdict: "prune", p: undefined, reason: "", tool: "", keyArg: "", sizeTokens: 0, turnsAgo: 0, step: 0, at: "" });
});
