import assert from "node:assert/strict";
import test from "node:test";
import { decideWindow, type WindowSignals } from "../src/windows.ts";

const base: WindowSignals = {
  mode: "on",
  userTurn: false,
  usedTokens: 20_000,
  budget: 100_000,
  pressurePct: 0.7,
  pendingPct: 0.15,
  pendingTokens: 0,
  coldCache: false,
};

test("closed mid-run when warm, under budget, little pending", () => {
  assert.deepEqual(decideWindow(base), { open: false, reason: "closed" });
});

test("off mode never opens", () => {
  assert.deepEqual(decideWindow({ ...base, mode: "off", userTurn: true, usedTokens: 500_000 }), { open: false, reason: "off" });
});

test("every-call always opens (experiment knob)", () => {
  assert.deepEqual(decideWindow({ ...base, mode: "every-call" }), { open: true, reason: "every-call" });
});

test("forced beats everything except off", () => {
  assert.deepEqual(decideWindow({ ...base, forced: true }), { open: true, reason: "forced" });
});

test("user turn opens", () => {
  assert.deepEqual(decideWindow({ ...base, userTurn: true }), { open: true, reason: "user-turn" });
});

test("over budget opens", () => {
  assert.deepEqual(decideWindow({ ...base, usedTokens: 100_001 }), { open: true, reason: "over-budget" });
});

test("pressure opens at pressurePct × budget", () => {
  assert.deepEqual(decideWindow({ ...base, usedTokens: 70_000 }), { open: true, reason: "pressure" });
  assert.equal(decideWindow({ ...base, usedTokens: 69_999 }).open, false);
});

test("cold cache opens", () => {
  assert.deepEqual(decideWindow({ ...base, coldCache: true }), { open: true, reason: "cold-cache" });
});

test("pending prunable ≥ pendingPct × budget opens", () => {
  assert.deepEqual(decideWindow({ ...base, pendingTokens: 15_000 }), { open: true, reason: "pending" });
  assert.equal(decideWindow({ ...base, pendingTokens: 14_999 }).open, false);
});

test("dry mode uses the same windows as on", () => {
  assert.deepEqual(decideWindow({ ...base, mode: "dry", userTurn: true }), { open: true, reason: "user-turn" });
  assert.deepEqual(decideWindow({ ...base, mode: "dry" }), { open: false, reason: "closed" });
});
