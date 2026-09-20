import assert from "node:assert/strict";
import test from "node:test";
import { buildSnapshot, keyArgOf } from "../src/candidates.ts";
import { assistant, big, conversation, nextId, step, toolResult, user } from "./fixtures.ts";

const opts = { exemptSteps: 3, minTokens: 300 };

test("keyArgOf picks the identifying argument per tool", () => {
  assert.equal(keyArgOf("read", { path: "a.ts", offset: 1 }), "a.ts");
  assert.equal(keyArgOf("edit", { file_path: "b.ts", oldText: "x" }), "b.ts");
  assert.equal(keyArgOf("bash", { command: "ls -la", timeout: 5 }), "ls -la");
  assert.equal(keyArgOf("grep", { pattern: "foo", path: "src" }), "foo");
  assert.equal(keyArgOf("fetch_content", { urls: ["http://a", "http://b"] }), "http://a");
  assert.equal(keyArgOf("unknown_tool", { n: 1, q: "hello" }), "hello");
  assert.equal(keyArgOf("read", undefined), "");
  assert.equal(keyArgOf("read", {}), "");
});

test("pairs tool results with calls; computes step, turnsAgo, exemption", () => {
  // 5 reads → steps 0..4, final assistant text = step 5. turnsAgo = 5 - step.
  const { messages, ids } = conversation([
    { path: "a", tokens: 500 },
    { path: "b", tokens: 500 },
    { path: "c", tokens: 500 },
    { path: "d", tokens: 500 },
    { path: "e", tokens: 500 },
  ]);
  const snap = buildSnapshot(messages, opts);
  assert.equal(snap.steps, 6);
  assert.equal(snap.candidates.length, 5);
  const byId = new Map(snap.candidates.map((c) => [c.toolCallId, c]));
  assert.equal(byId.get(ids[0]!)!.turnsAgo, 5);
  assert.equal(byId.get(ids[4]!)!.turnsAgo, 1);
  // exemptSteps 3 → turnsAgo 0,1,2 exempt → d (2) and e (1) exempt; a,b,c eligible.
  assert.deepEqual(
    snap.candidates.map((c) => [c.keyArg, c.exempt, c.eligible]),
    [
      ["a", false, true],
      ["b", false, true],
      ["c", false, true],
      ["d", true, false],
      ["e", true, false],
    ],
  );
  assert.equal(snap.userTurn, false);
  assert.equal(snap.task, "Explain how the CLI parses the manifest");
  assert.equal(snap.now, "Now I understand the structure. Moving on.");
});

test("small results are never eligible; head/tail/agentReaction are clipped", () => {
  const { messages, ids } = conversation([
    { path: "small", tokens: 50 },
    { path: "large", tokens: 2000 },
    { path: "x", tokens: 500 },
    { path: "y", tokens: 500 },
    { path: "z", tokens: 500 },
  ]);
  const snap = buildSnapshot(messages, opts);
  const small = snap.candidates.find((c) => c.toolCallId === ids[0])!;
  const large = snap.candidates.find((c) => c.toolCallId === ids[1])!;
  assert.equal(small.eligible, false);
  assert.ok(small.sizeTokens < 300);
  assert.equal(large.eligible, true);
  assert.ok(large.head.length <= 301 && large.head.endsWith("…"));
  assert.ok(large.tail.length <= 101 && large.tail.startsWith("…"));
  assert.equal(large.agentReaction, "Reading x");
  assert.ok(large.lines > 10);
});

test("superseded reads: same path + later edit/write, or later read of same range", () => {
  const r1 = nextId();
  const r2 = nextId();
  const r3 = nextId();
  const r4 = nextId();
  const e1 = nextId();
  const messages = [
    user("fix it"),
    ...step("read a", { id: r1, name: "read", args: { path: "a.ts" } }, big(600)),
    ...step("read a again same range", { id: r2, name: "read", args: { path: "a.ts" } }, big(600)),
    ...step("read b partial", { id: r3, name: "read", args: { path: "b.ts", offset: 1, limit: 50 } }, big(600)),
    ...step("read b other range", { id: r4, name: "read", args: { path: "b.ts", offset: 100, limit: 50 } }, big(600)),
    ...step("edit a", { id: e1, name: "edit", args: { path: "a.ts", oldText: "x", newText: "y" } }, "ok"),
    assistant("done"),
    assistant("done"),
    assistant("done"),
    assistant("done"),
  ];
  const snap = buildSnapshot(messages, opts);
  const by = new Map(snap.candidates.map((c) => [c.toolCallId, c]));
  assert.equal(by.get(r1)!.supersededBy, "read");
  assert.equal(by.get(r1)!.autoPrune, true);
  assert.equal(by.get(r1)!.eligible, false);
  assert.equal(by.get(r2)!.supersededBy, "edit");
  assert.equal(by.get(r2)!.autoPrune, true);
  assert.equal(by.get(r3)!.supersededBy, undefined, "different range is not superseded");
  assert.equal(by.get(r3)!.eligible, true);
  assert.equal(by.get(r4)!.supersededBy, undefined);
  assert.equal(by.get(e1)!.eligible, false, "edit result too small");
});

test("superseded read inside the exempt window is neither auto-pruned nor eligible", () => {
  const r1 = nextId();
  const e1 = nextId();
  const messages = [
    user("fix"),
    ...step("read", { id: r1, name: "read", args: { path: "a.ts" } }, big(600)),
    ...step("edit", { id: e1, name: "edit", args: { path: "a.ts" } }, "ok"),
    assistant("done"),
  ];
  const c = buildSnapshot(messages, opts).candidates.find((x) => x.toolCallId === r1)!;
  assert.equal(c.supersededBy, "edit");
  assert.equal(c.exempt, true);
  assert.equal(c.autoPrune, false);
  assert.equal(c.eligible, false);
});

test("orphan tool results (no matching call) are ignored; error flag preserved", () => {
  const id = nextId();
  const messages = [
    user("go"),
    toolResult("orphan", "bash", big(600)),
    ...step("run", { id, name: "bash", args: { command: "cargo test" } }, big(600), true),
    assistant("a"),
    assistant("b"),
    assistant("c"),
    assistant("d"),
  ];
  const snap = buildSnapshot(messages, opts);
  assert.equal(snap.candidates.length, 1);
  assert.equal(snap.candidates[0]!.isError, true);
  assert.equal(snap.candidates[0]!.keyArg, "cargo test");
  assert.equal(snap.candidates[0]!.eligible, true);
});

test("sticky decisions remove eligibility; userTurn detected; task clipped to 1000 chars", () => {
  const { messages, ids } = conversation(
    [
      { path: "a", tokens: 500 },
      { path: "b", tokens: 500 },
      { path: "c", tokens: 500 },
      { path: "d", tokens: 500 },
    ],
    { trailingUser: "y".repeat(3000) },
  );
  const decided = new Set([ids[0]]);
  const snap = buildSnapshot(messages, { ...opts, decisions: { isFinal: (id) => decided.has(id) } });
  assert.equal(snap.userTurn, true);
  assert.equal(snap.task.length, 1001);
  assert.equal(snap.candidates.find((c) => c.toolCallId === ids[0])!.eligible, false);
  assert.equal(snap.candidates.find((c) => c.toolCallId === ids[1])!.eligible, true);
});

test("buildSnapshot does not mutate messages", () => {
  const { messages } = conversation([{ path: "a", tokens: 500 }]);
  const before = JSON.stringify(messages);
  buildSnapshot(messages, opts);
  assert.equal(JSON.stringify(messages), before);
});
