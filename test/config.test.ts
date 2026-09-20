import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DEFAULTS, loadConfig, mergeConfig } from "../src/config.ts";

test("defaults: dry mode, 100k budget, 0.25 threshold (D6 sweep), 300 minTokens, 3 exempt steps, 5% min batch", () => {
  assert.equal(DEFAULTS.mode, "dry");
  assert.equal(DEFAULTS.budget, 100_000);
  assert.equal(DEFAULTS.threshold, 0.25);
  assert.equal(DEFAULTS.minApplyPct, 0.05);
  assert.equal(DEFAULTS.minTokens, 300);
  assert.equal(DEFAULTS.exemptSteps, 3);
  assert.equal(DEFAULTS.pressurePct, 0.7);
  assert.equal(DEFAULTS.pendingPct, 0.15);
  assert.equal(DEFAULTS.timeoutMs, 2000);
});

test("mergeConfig accepts valid overrides", () => {
  const c = mergeConfig({ mode: "on", budget: 50_000, threshold: 0.5, minTokens: 100, exemptSteps: 2.7, model: "jev-1", minApplyPct: 0 });
  assert.equal(c.mode, "on");
  assert.equal(c.budget, 50_000);
  assert.equal(c.threshold, 0.5);
  assert.equal(c.minApplyPct, 0);
  assert.equal(c.minTokens, 100);
  assert.equal(c.exemptSteps, 2);
  assert.equal(c.model, "jev-1");
  assert.equal(c.pressurePct, DEFAULTS.pressurePct);
});

test("mergeConfig rejects invalid values and falls back to defaults", () => {
  const c = mergeConfig({ mode: "yolo", budget: -1, threshold: 2, minTokens: "300", exemptSteps: NaN, timeoutMs: 1, model: "" });
  assert.deepEqual(c, DEFAULTS);
});

test("mergeConfig tolerates non-object input", () => {
  assert.deepEqual(mergeConfig(undefined), DEFAULTS);
  assert.deepEqual(mergeConfig(null), DEFAULTS);
  assert.deepEqual(mergeConfig("x"), DEFAULTS);
});

test("loadConfig reads the jev-prune key from settings.json; missing file → defaults", () => {
  const dir = mkdtempSync(join(tmpdir(), "jev-prune-"));
  const p = join(dir, "settings.json");
  writeFileSync(p, JSON.stringify({ packages: [], "jev-prune": { mode: "on", threshold: 0.2 } }));
  const c = loadConfig(p);
  assert.equal(c.mode, "on");
  assert.equal(c.threshold, 0.2);
  assert.deepEqual(loadConfig(join(dir, "nope.json")), DEFAULTS);
  writeFileSync(p, "{ not json");
  assert.deepEqual(loadConfig(p), DEFAULTS);
});
