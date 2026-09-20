import assert from "node:assert/strict";
import test from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { DEFAULTS, type PruneConfig } from "../src/config.ts";
import { type Decision, DecisionStore } from "../src/decisions.ts";
import { Engine, type LogRecord } from "../src/engine.ts";
import { isStub } from "../src/stub.ts";
import { assistant, big, conversation, FakeJudge, nextId, step, textOf, user } from "./fixtures.ts";

function cfg(over: Partial<PruneConfig> = {}): PruneConfig {
  return { ...DEFAULTS, ...over };
}

function make(over: Partial<PruneConfig> = {}, judge?: FakeJudge, nowMs = { t: 1_000_000 }) {
  const persisted: Decision[] = [];
  const logs: LogRecord[] = [];
  const engine = new Engine({
    config: cfg(over),
    decisions: new DecisionStore(),
    judge,
    now: () => nowMs.t,
    persist: (d) => persisted.push(d),
    log: (r) => logs.push(r),
  });
  return { engine, persisted, logs, nowMs };
}

/** 6 reads of ~1k tokens, then a trailing user message (user-turn window). */
function readHeavy(trailingUser = "continue") {
  return conversation(
    [
      { path: "a.ts", tokens: 1000 },
      { path: "b.ts", tokens: 1000 },
      { path: "c.ts", tokens: 1000 },
      { path: "d.ts", tokens: 1000 },
      { path: "e.ts", tokens: 1000 },
      { path: "f.ts", tokens: 1000 },
    ],
    { trailingUser },
  );
}

test("off mode: messages untouched, window off, judge never called", async () => {
  const judge = new FakeJudge();
  const { engine } = make({ mode: "off" }, judge);
  const { messages } = readHeavy();
  const res = await engine.onContext(messages);
  assert.equal(res.changed, false);
  assert.equal(res.messages, messages);
  assert.equal(res.status.window, "off");
  assert.equal(judge.calls.length, 0);
});

test("dry mode: Jev runs at user-turn, verdicts logged/persisted, nothing applied", async () => {
  const judge = new FakeJudge(new Map(), 0.1);
  const { engine, persisted, logs } = make({ mode: "dry" }, judge);
  const { messages, ids } = readHeavy();
  const res = await engine.onContext(messages);
  assert.equal(res.changed, false);
  assert.equal(res.messages, messages);
  assert.equal(res.status.window, "user-turn");
  assert.equal(judge.calls.length, 1);
  // exemptSteps=3 → a,b,c,d eligible (turnsAgo 6..3); e,f exempt (2,1).
  assert.deepEqual(judge.calls[0]!.ids, ids.slice(0, 4));
  assert.equal(persisted.filter((d) => d.verdict === "prune").length, 4);
  assert.equal(logs.length, 4);
  assert.ok(logs.every((l) => l.applied === false && l.mode === "dry" && l.p === 0.1));
  assert.ok(res.status.wouldSaveTokens > 3500, `wouldSave=${res.status.wouldSaveTokens}`);
  assert.equal(res.status.savedTokens, 0);
  assert.equal(res.status.pruned, 4);
});

test("on mode: prunes applied as stubs; message count, order, ids preserved; input not mutated", async () => {
  const judge = new FakeJudge(new Map(), 0.1);
  const { engine, logs } = make({ mode: "on" }, judge);
  const { messages, ids } = readHeavy();
  const before = JSON.stringify(messages);
  const res = await engine.onContext(messages);
  assert.equal(JSON.stringify(messages), before, "input messages not mutated");
  assert.equal(res.changed, true);
  assert.equal(res.messages.length, messages.length);
  for (let i = 0; i < messages.length; i++) {
    const a = messages[i]!;
    const b = res.messages[i]!;
    assert.equal(a.role, b.role);
    if (a.role === "toolResult" && b.role === "toolResult") assert.equal(a.toolCallId, b.toolCallId);
  }
  const stubbed = res.messages.filter((m) => m.role === "toolResult" && isStub(textOf(m)));
  assert.equal(stubbed.length, 4);
  for (const id of ids.slice(0, 4)) {
    const m = res.messages.find((m) => m.role === "toolResult" && m.toolCallId === id)!;
    assert.ok(textOf(m).includes(`recall("${id}")`));
  }
  for (const id of ids.slice(4)) {
    const m = res.messages.find((m) => m.role === "toolResult" && m.toolCallId === id)!;
    assert.equal(isStub(textOf(m)), false, "exempt results untouched");
  }
  assert.ok(logs.every((l) => l.applied === true));
  assert.ok(res.status.savedTokens > 3500);
});

test("threshold: p ≥ threshold → keep (not stubbed, not persisted)", async () => {
  const { ids, messages } = readHeavy();
  const judge = new FakeJudge(new Map([[ids[0]!, 0.9], [ids[1]!, 0.35]]), 0.1);
  const { engine, persisted } = make({ mode: "on" }, judge);
  const res = await engine.onContext(messages);
  const stubbedIds = res.messages.filter((m) => m.role === "toolResult" && isStub(textOf(m))).map((m) => (m as { toolCallId: string }).toolCallId);
  assert.deepEqual(stubbedIds, [ids[2], ids[3]]);
  assert.deepEqual(engine.decisions.byVerdict("keep").map((d) => d.toolCallId).sort(), [ids[0], ids[1]].sort());
  assert.ok(persisted.every((d) => d.verdict !== "keep"), "keeps are transient, never persisted");
});

test("D2 cache invariant: mid-run, warm cache, under thresholds → byte-identical output, no Jev call", async () => {
  const judge = new FakeJudge(new Map(), 0.1);
  const { engine, nowMs } = make({ mode: "on" }, judge);
  const { messages } = readHeavy();
  const first = await engine.onContext(messages); // user-turn window → 4 stubs
  assert.equal(first.status.window, "user-turn");
  assert.equal(judge.calls.length, 1);

  // Agent continues: 3 more steps mid-run, each is a new LLM call. Prefix must stay identical.
  const cont: AgentMessage[] = [...messages];
  let prev = first.messages;
  for (let k = 0; k < 3; k++) {
    nowMs.t += 10_000; // 10 s later, well within 5 min TTL
    const id = nextId();
    cont.push(...step(`step ${k}`, { id, name: "read", args: { path: `g${k}.ts` } }, big(1000)));
    const res = await engine.onContext(cont, 20_000);
    assert.equal(res.status.window, "closed", `call ${k} window`);
    assert.equal(judge.calls.length, 1, "no Jev call outside a window");
    // Prefix (everything present in the previous output) is byte-identical.
    const prefixLen = prev.length;
    assert.equal(JSON.stringify(res.messages.slice(0, prefixLen)), JSON.stringify(prev.slice(0, prefixLen)), `call ${k} prefix churn`);
    // Newly appended messages pass through verbatim.
    assert.equal(JSON.stringify(res.messages.slice(prefixLen)), JSON.stringify(cont.slice(prefixLen)));
    prev = res.messages;
  }
  // Same input twice → same output bytes.
  const again = await engine.onContext(cont, 20_000);
  assert.equal(JSON.stringify(again.messages), JSON.stringify(prev));
});

test("pressure window opens mid-run when usage ≥ 70% of budget", async () => {
  const judge = new FakeJudge(new Map(), 0.1);
  const { engine } = make({ mode: "on", minApplyPct: 0 }, judge);
  const { messages } = readHeavy();
  await engine.onContext(messages);
  // Two more steps → e.ts and f.ts leave the exempt window (2 eligible → Jev asked).
  const cont: AgentMessage[] = [
    ...messages,
    ...step("more", { id: nextId(), name: "read", args: { path: "z.ts" } }, big(1000)),
    ...step("more", { id: nextId(), name: "read", args: { path: "y.ts" } }, big(1000)),
  ];
  const res = await engine.onContext(cont, 71_000);
  assert.equal(res.status.window, "pressure");
  assert.equal(judge.calls.length, 2);
  assert.equal(res.status.pruned, 6);
});

test("minApplyPct: mid-run prunes are staged until the batch saves ≥ 5% of budget, then applied together (one prefix change)", async () => {
  // budget 100k → need ≥ 5k saved per mid-run batch. Reads are ~1k each.
  const judge = new FakeJudge(new Map(), 0.1);
  const { engine, logs, persisted } = make({ mode: "on" }, judge);
  const { messages } = readHeavy(); // user-turn: a..d pruned immediately (immediate window, no floor)
  const first = await engine.onContext(messages);
  assert.equal(first.status.pruned, 4);
  // Mid-run pressure window: e, f leave the exempt zone → Jev says prune, but 2k < 5k → staged, output unchanged.
  const cont: AgentMessage[] = [
    ...messages,
    ...step("more", { id: nextId(), name: "read", args: { path: "z.ts" } }, big(1000)),
    ...step("more", { id: nextId(), name: "read", args: { path: "y.ts" } }, big(1000)),
  ];
  const r2 = await engine.onContext(cont, 71_000);
  assert.equal(r2.status.window, "pressure");
  assert.equal(r2.status.pruned, 4, "staged prunes are not stubbed");
  assert.equal(engine.decisions.byVerdict("staged").length, 2);
  assert.ok(r2.status.stagedTokens > 1500 && r2.status.stagedTokens < 2500, `staged=${r2.status.stagedTokens}`);
  assert.equal(persisted.filter((d) => d.verdict === "staged").length, 0, "staged is never persisted");
  const stagedLogs = logs.filter((l) => l.verdict === "staged");
  assert.equal(stagedLogs.length, 2);
  assert.ok(stagedLogs.every((l) => l.applied === false && l.p === 0.1 && l.batchSaved! < 5000));
  // Prefix identical to the previous output.
  assert.equal(JSON.stringify(r2.messages.slice(0, first.messages.length)), JSON.stringify(first.messages));
  // Same window again next step: staged ones are not re-sent to Jev, not re-logged.
  const cont2: AgentMessage[] = [...cont, ...step("more", { id: nextId(), name: "read", args: { path: "x.ts" } }, big(1000))];
  const r3 = await engine.onContext(cont2, 72_000);
  assert.equal(r3.status.window, "pressure");
  assert.equal(r3.status.pruned, 4);
  assert.equal(logs.filter((l) => l.verdict === "staged").length, 2, "no duplicate staged records");
  assert.ok(judge.calls.slice(2).every((c) => c.ids.every((id) => !engine.decisions.isStaged(id))), "staged ids not re-judged");
  // Enough accumulates (3 more big reads leave the exempt zone → batch ≈ 6k) → all applied at once, promoted flagged.
  const cont3: AgentMessage[] = [
    ...cont2,
    ...step("more", { id: nextId(), name: "read", args: { path: "w.ts" } }, big(2000)),
    ...step("more", { id: nextId(), name: "read", args: { path: "v.ts" } }, big(1000)),
    ...step("more", { id: nextId(), name: "read", args: { path: "u.ts" } }, big(1000)),
    ...step("more", { id: nextId(), name: "read", args: { path: "t.ts" } }, big(1000)),
  ];
  const r4 = await engine.onContext(cont3, 75_000);
  assert.equal(r4.status.window, "pressure");
  assert.equal(engine.decisions.byVerdict("staged").length, 0);
  assert.ok(r4.status.pruned >= 9, `pruned=${r4.status.pruned}`);
  const promoted = logs.filter((l) => l.promoted);
  assert.equal(promoted.length, 2);
  assert.ok(promoted.every((l) => l.verdict === "prune" && l.applied && l.p === 0.1 && l.batchSaved! >= 5000));
});

test("minApplyPct: auto-prunes alone never trigger a mid-run rewrite; a user turn flushes them", async () => {
  const r1 = nextId();
  const messages: AgentMessage[] = [
    user("fix"),
    ...step("read", { id: r1, name: "read", args: { path: "a.ts" } }, big(2000)),
    ...step("edit", { id: nextId(), name: "edit", args: { path: "a.ts", oldText: "x", newText: "y" } }, "ok"),
    assistant("a"),
    assistant("b"),
    assistant("c"),
  ];
  const { engine, logs } = make({ mode: "on" }); // no judge
  const mid = await engine.onContext(messages, 71_000); // pressure window, 2k auto-prune < 5k
  assert.equal(mid.status.window, "pressure");
  assert.equal(mid.changed, false);
  assert.equal(engine.decisions.get(r1)?.verdict, "staged");
  assert.equal(logs[0]!.reason, "superseded:edit");
  const res = await engine.onContext([...messages, user("next")]);
  assert.equal(res.status.window, "user-turn");
  assert.ok(isStub(textOf(res.messages.find((m) => m.role === "toolResult" && m.toolCallId === r1)!)));
  assert.equal(logs.at(-1)!.promoted, true);
});

test("over-budget window: keeps are re-judged only every exemptSteps steps (no per-call re-judging)", async () => {
  const judge = new FakeJudge(new Map(), 0.9); // keep everything
  const { engine } = make({ mode: "on", budget: 10_000 }, judge);
  const { messages, ids } = readHeavy();
  const mid = messages.slice(0, -1);
  const r1 = await engine.onContext(mid, 20_000);
  assert.equal(r1.status.window, "over-budget");
  assert.equal(judge.calls.length, 1);
  assert.deepEqual(judge.calls[0]!.ids, ids.slice(0, 4)); // a..d kept at step 6
  let cont: AgentMessage[] = mid;
  for (let k = 0; k < 2; k++) {
    cont = [...cont, ...step(`s${k}`, { id: nextId(), name: "read", args: { path: `n${k}.ts` } }, big(1000))];
    const r = await engine.onContext(cont, 20_000);
    assert.equal(r.status.window, "over-budget");
    // Newly eligible ids (e, f) may be judged; a..d must not be re-judged yet.
    for (const c of judge.calls.slice(1)) assert.ok(c.ids.every((id) => !ids.slice(0, 4).includes(id)), `step ${k}: fresh keeps re-judged`);
  }
  cont = [...cont, ...step("s2", { id: nextId(), name: "read", args: { path: "n2.ts" } }, big(1000))];
  await engine.onContext(cont, 20_000); // step 9 → keeps from step 6 are stale (9 - 3 + 1 = 7 > 6)
  assert.ok(judge.calls.at(-1)!.ids.includes(ids[0]!), "re-judged after exemptSteps new steps");
});
