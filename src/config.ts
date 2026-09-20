import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * - `dry`: Jev runs, verdicts are logged, nothing is applied (default on first install).
 * - `on`: prunes are applied at windows (see windows.ts).
 * - `off`: extension does nothing (previously pruned results are shown again).
 * - `every-call`: experiment knob — judge + apply before every LLM call. Never the default.
 */
export type PruneMode = "dry" | "on" | "off" | "every-call";

export interface PruneConfig {
  mode: PruneMode;
  /** Token budget the user treats as 100%. */
  budget: number;
  /** Prune when Jev's p(need to re-read) is below this. */
  threshold: number;
  /** Tool results smaller than this are never candidates. */
  minTokens: number;
  /** Tool results from the last N assistant steps are never candidates. */
  exemptSteps: number;
  /** Mid-run window opens when usage ≥ pressurePct × budget. */
  pressurePct: number;
  /** Mid-run window opens when eligible-but-unpruned tokens ≥ pendingPct × budget. */
  pendingPct: number;
  /**
   * Mid-run windows (over-budget, pressure, cold-cache, pending) only apply new stubs when the batch saves
   * ≥ minApplyPct × budget; smaller batches are staged until enough accumulates. Every prefix change costs a
   * prompt-cache rewrite (≈ 1.25× input price for everything after the first stub), so tiny prunes never pay off.
   * User-turn / forced / every-call windows always apply.
   */
  minApplyPct: number;
  /** Jev call timeout; on timeout skip silently and retry at the next window. */
  timeoutMs: number;
  /** Fallback prompt-cache lifetime when the model does not declare one. */
  cacheTtlMs: number;
  /** Max Jev state size per request (tokens); larger candidate sets are split. */
  maxStateTokens: number;
  /** Jev model id. */
  model: string;
  /** JSONL decision log path. */
  logPath: string;
}

export const SETTINGS_KEY = "jev-prune";

export const DEFAULTS: PruneConfig = {
  mode: "dry",
  budget: 100_000,
  // 0.25 from the D6 replay sweep: at 0.35 Jev's FP rate (pruned ∧ cited later) equals random pruning (24 %);
  // at 0.25 it is 17 % for ~half the achievable savings, at 0.20 12 % (see experiments/REPORT.md §1.5).
  threshold: 0.25,
  minTokens: 300,
  exemptSteps: 3,
  pressurePct: 0.7,
  pendingPct: 0.15,
  minApplyPct: 0.05,
  timeoutMs: 2000,
  cacheTtlMs: 5 * 60_000,
  maxStateTokens: 24_000,
  model: "jev-latest",
  logPath: join(homedir(), ".pi", "agent", SETTINGS_KEY, "log.jsonl"),
};

const MODES: ReadonlySet<string> = new Set<PruneMode>(["dry", "on", "off", "every-call"]);

function num(v: unknown, fallback: number, min = 0, max = Number.POSITIVE_INFINITY): number {
  return typeof v === "number" && Number.isFinite(v) && v >= min && v <= max ? v : fallback;
}

/** Merge a partial/untrusted config object over defaults, validating each key. */
export function mergeConfig(raw: unknown, base: PruneConfig = DEFAULTS): PruneConfig {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return {
    mode: typeof r.mode === "string" && MODES.has(r.mode) ? (r.mode as PruneMode) : base.mode,
    budget: num(r.budget, base.budget, 1000),
    threshold: num(r.threshold, base.threshold, 0, 1),
    minTokens: num(r.minTokens, base.minTokens, 0),
    exemptSteps: Math.floor(num(r.exemptSteps, base.exemptSteps, 0)),
    pressurePct: num(r.pressurePct, base.pressurePct, 0, 1),
    pendingPct: num(r.pendingPct, base.pendingPct, 0, 1),
    minApplyPct: num(r.minApplyPct, base.minApplyPct, 0, 1),
    timeoutMs: num(r.timeoutMs, base.timeoutMs, 100),
    cacheTtlMs: num(r.cacheTtlMs, base.cacheTtlMs, 1000),
    maxStateTokens: num(r.maxStateTokens, base.maxStateTokens, 1000, 30_000),
    model: typeof r.model === "string" && r.model.length > 0 ? r.model : base.model,
    logPath: typeof r.logPath === "string" && r.logPath.length > 0 ? r.logPath : base.logPath,
  };
}

/** pi's config dir (honours `PI_CODING_AGENT_DIR` like pi itself). */
export function agentDir(): string {
  return process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

export function defaultSettingsPath(): string {
  return join(agentDir(), "settings.json");
}

/** Read `"jev-prune"` from pi's settings.json. Missing file / bad JSON → defaults. */
export function loadConfig(settingsPath = defaultSettingsPath()): PruneConfig {
  try {
    const parsed = JSON.parse(readFileSync(settingsPath, "utf8")) as Record<string, unknown>;
    return mergeConfig(parsed?.[SETTINGS_KEY]);
  } catch {
    return { ...DEFAULTS };
  }
}
