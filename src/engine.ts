import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import { estimateTokens } from "@earendil-works/pi-coding-agent";
import { buildSnapshot, type Candidate, type Snapshot } from "./candidates.ts";
import type { PruneConfig, PruneMode } from "./config.ts";
import { type Decision, DecisionStore, type Verdict } from "./decisions.ts";
import type { Judge, JudgeUsage } from "./judge.ts";
import { stubText } from "./stub.ts";
import { decideWindow, type WindowReason } from "./windows.ts";

export interface LogRecord {
  ts: string;
  window: WindowReason;
  mode: PruneMode;
  toolCallId: string;
  tool: string;
  keyArg: string;
  sizeTokens: number;
  turnsAgo: number;
  step: number;
  p?: number;
  verdict: Verdict;
  reason: string;
  /** Stub actually placed in context (false in dry mode). */
  applied: boolean;
  /** This prune was staged at an earlier window and is now promoted (its Jev judgment was already logged then). */
  promoted?: boolean;
  /** Tokens the whole batch at this window saves (prune/staged records only). */
  batchSaved?: number;
  /** Window inputs at decision time (absent for recall records). */
  signals?: WindowSignalsInfo;
  /** Context usage (tokens) at decision time. */
  usedTokens?: number;
  /** Cumulative Jev input tokens for this process (spend tracking). */
  jevIn?: number;
}

export interface EngineDeps {
  config: PruneConfig;
  decisions: DecisionStore;
  /** Undefined → no Jev (no key / disabled). Auto-prunes still apply. */
  judge?: Judge;
  now?: () => number;
  persist?: (d: Decision) => void;
  log?: (r: LogRecord) => void;
}

export interface EngineStatus {
  mode: PruneMode;
  usedTokens: number;
  budget: number;
  /** Tokens removed from context by applied stubs (0 in dry mode). */
  savedTokens: number;
  /** Tokens that would be saved if dry-mode prune verdicts were applied. */
  wouldSaveTokens: number;
  /** Tokens in eligible + auto-prune candidates not yet decided. */
  pendingTokens: number;
  /** Tokens in staged prunes (decided, waiting for a batch ≥ minApplyPct × budget). */
  stagedTokens: number;
  window: WindowReason;
  pruned: number;
  jev?: { ms: number; batches: number; errors: string[]; judged: number; usage: JudgeUsage };
  /** Raw window inputs, for diagnosing why a window did/didn't open. */
  signals: WindowSignalsInfo;
}

export interface WindowSignalsInfo {
  /** ms since the last request or warm refresh (-1 when none yet). */
  idleMs: number;
  ttlMs: number;
  coldCache: boolean;
  warmingStopped: boolean;
  userTurn: boolean;
  forced: boolean;
  /** Where the usage number came from. */
  usageSource: "hint" | "estimate";
}

export interface ContextResult {
  messages: AgentMessage[];
  changed: boolean;
  status: EngineStatus;
  snapshot: Snapshot;
}

function appliesPrunes(mode: PruneMode): boolean {
  return mode === "on" || mode === "every-call";
}

/**
 * Orchestrates one `context` event: snapshot → window → (auto-prune, Jev) → apply sticky stubs.
 * Pure w.r.t. pi; all I/O goes through deps. Never throws (caller still wraps it).
 */
export class Engine {
  readonly config: PruneConfig;
  readonly decisions: DecisionStore;
  judge: Judge | undefined;
  private readonly now: () => number;
  private readonly persist: (d: Decision) => void;
  private readonly log: (r: LogRecord) => void;

  /** Time of the last LLM request we saw (context event). 0 = none yet. */
  lastRequestAt = 0;
  /** Time of the last cache-warming refresh pi decided to send. */
  lastWarmAt = 0;
  /** Set when pi decided to stop warming (`cache_warming_decision` → stop); cleared on the next request. */
  warmingStopped = false;
  /** Model-declared prompt-cache TTL (ms); falls back to config.cacheTtlMs. */
  cacheTtlMs: number | undefined;
  /** `/prune now`. */
  forced = false;
  lastStatus: EngineStatus | undefined;

  constructor(deps: EngineDeps) {
    this.config = deps.config;
    this.decisions = deps.decisions;
    this.judge = deps.judge;
    this.now = deps.now ?? (() => Date.now());
    this.persist = deps.persist ?? (() => {});
    this.log = deps.log ?? (() => {});
  }

  get mode(): PruneMode {
    return this.config.mode;
  }

  set mode(m: PruneMode) {
    this.config.mode = m;
  }

  get ttlMs(): number {
    return this.cacheTtlMs ?? this.config.cacheTtlMs;
  }

  /** ms since the last request or warm refresh; -1 when no request has been seen yet. */
  idleMs(): number {
    const last = Math.max(this.lastRequestAt, this.lastWarmAt);
    return last === 0 ? -1 : this.now() - last;
  }

  /** Prompt cache believed cold: no request or warm refresh within the TTL. */
  isCacheCold(): boolean {
    const idle = this.idleMs();
    return idle >= 0 && idle > this.ttlMs;
  }

  async onContext(messages: AgentMessage[], usedTokensHint?: number | null): Promise<ContextResult> {
    const cfg = this.config;
    const snapshot = buildSnapshot(messages, {
      exemptSteps: cfg.exemptSteps,
      minTokens: cfg.minTokens,
      decisions: this.decisions,
    });
    const byId = new Map<string, Candidate>();
    for (const c of snapshot.candidates) byId.set(c.toolCallId, c);

    // Usage estimate for window decisions. The hint (pi's last reported usage) already reflects
    // previously applied stubs; the local estimate does not, so subtract what sticky stubs already save.
    const apply = appliesPrunes(cfg.mode);
    let priorSaved = 0;
    if (apply) {
      for (const c of snapshot.candidates) if (this.decisions.isStubbed(c.toolCallId)) priorSaved += savedBy(c);
    }
    const usedTokens =
      usedTokensHint ?? Math.max(0, messages.reduce((n, m) => n + estimateTokens(m), 0) - priorSaved);
    const pendingTokens = snapshot.candidates.reduce((n, c) => (c.eligible || c.autoPrune ? n + c.sizeTokens : n), 0);

    const signals: WindowSignalsInfo = {
      idleMs: this.idleMs(),
      ttlMs: this.ttlMs,
      coldCache: this.isCacheCold(),
      warmingStopped: this.warmingStopped,
      userTurn: snapshot.userTurn,
      forced: this.forced,
      usageSource: usedTokensHint == null ? "estimate" : "hint",
    };
    const window = decideWindow({
      mode: cfg.mode,
      userTurn: snapshot.userTurn,
      usedTokens,
      budget: cfg.budget,
      pressurePct: cfg.pressurePct,
      pendingPct: cfg.pendingPct,
      pendingTokens,
      coldCache: signals.coldCache,
      forced: this.forced,
    });

    let jev: EngineStatus["jev"];
    if (window.open) {
      this.forced = false;
      const at = new Date(this.now()).toISOString();
      const applied = appliesPrunes(cfg.mode);
      // User-turn / forced / every-call: apply whatever is decided, re-judge keeps immediately.
      // Mid-run windows (over-budget, pressure, cold-cache, pending): re-judge keeps only every `exemptSteps`
      // steps and apply only when the batch is worth a prompt-cache rewrite.
      const immediate = window.reason === "user-turn" || window.reason === "forced" || window.reason === "every-call";
      const staleAfter = immediate ? 1 : cfg.exemptSteps;

      // Batch = previously staged prunes + new auto-prunes + new Jev prunes.
      const batch: Array<{ c: Candidate; reason: string; p?: number; promoted: boolean }> = [];
      for (const c of snapshot.candidates) {
        const d = this.decisions.get(c.toolCallId);
        if (d?.verdict === "staged") batch.push({ c, reason: d.reason, p: d.p, promoted: true });
        else if (c.autoPrune) batch.push({ c, reason: `superseded:${c.supersededBy}`, promoted: false });
      }

      // Jev: eligible candidates whose keep verdict is stale (staged ones are already decided).
      const ask = snapshot.candidates.filter(
        (c) => c.eligible && !this.decisions.isStaged(c.toolCallId) && !this.decisions.isFreshKeep(c.toolCallId, snapshot.steps - staleAfter + 1),
      );
      if (this.judge && ask.length >= 2) {
        const res = await this.judge.judge(snapshot.task, snapshot.now, ask, {
          timeoutMs: cfg.timeoutMs,
          maxStateTokens: cfg.maxStateTokens,
        });
        jev = { ms: res.ms, batches: res.batches, errors: res.errors, judged: res.p.size, usage: res.usage };
        for (const c of ask) {
          const p = res.p.get(c.toolCallId);
          if (p === undefined) continue; // timeout/error → retry next window
          if (p < cfg.threshold) batch.push({ c, reason: "jev", p, promoted: false });
          else this.decide(c, "keep", "jev", p, snapshot.steps, at, window.reason, false, signals, usedTokens);
        }
      }

      const batchSaved = batch.reduce((n, b) => n + savedBy(b.c), 0);
      const commit = immediate || batchSaved >= cfg.minApplyPct * cfg.budget;
      for (const b of batch) {
        if (commit) this.decide(b.c, "prune", b.reason, b.p, snapshot.steps, at, window.reason, applied, signals, usedTokens, { promoted: b.promoted, batchSaved });
        else if (!b.promoted) this.decide(b.c, "staged", b.reason, b.p, snapshot.steps, at, window.reason, false, signals, usedTokens, { batchSaved });
      }
    }

    // Apply sticky stubs (every call, so the output is stable between windows).
    let savedTokens = 0;
    let wouldSaveTokens = 0;
    let pruned = 0;
    let changed = false;
    let out = messages;
    if (cfg.mode !== "off") {
      for (let i = 0; i < messages.length; i++) {
        const m = messages[i]!;
        if (m.role !== "toolResult" || !this.decisions.isStubbed(m.toolCallId)) continue;
        const c = byId.get(m.toolCallId);
        if (!c) continue;
        pruned++;
        const text = stubText({
          toolCallId: c.toolCallId,
          tool: c.tool,
          keyArg: c.keyArg,
          lines: c.lines,
          sizeTokens: c.sizeTokens,
          isError: c.isError,
        });
        const delta = savedBy(c);
        if (!apply) {
          wouldSaveTokens += delta;
          continue;
        }
        if (out === messages) out = messages.slice();
        const stubbed: ToolResultMessage = { ...(m as ToolResultMessage), content: [{ type: "text", text }] };
        out[i] = stubbed;
        savedTokens += delta;
        changed = true;
      }
    }

    this.lastRequestAt = this.now();
    this.warmingStopped = false;
    const status: EngineStatus = {
      mode: cfg.mode,
      usedTokens: Math.max(0, usedTokens - (savedTokens - priorSaved)),
      budget: cfg.budget,
      savedTokens,
      wouldSaveTokens,
      pendingTokens: snapshot.candidates.reduce(
        (n, c) => ((c.eligible || c.autoPrune) && !this.decisions.isFinal(c.toolCallId) && !this.decisions.isStaged(c.toolCallId) ? n + c.sizeTokens : n),
        0,
      ),
      stagedTokens: snapshot.candidates.reduce((n, c) => (this.decisions.isStaged(c.toolCallId) ? n + savedBy(c) : n), 0),
      window: window.reason,
      pruned,
      jev,
      signals,
    };
    this.lastStatus = status;
    return { messages: out, changed, status, snapshot };
  }

  /** Record a recall: original stays stubbed but is flagged; the recall result itself is pinned. */
  recall(originalId: string, recallResultId: string | undefined, at = new Date(this.now()).toISOString()): Decision | undefined {
    const prev = this.decisions.get(originalId);
    const d: Decision = {
      toolCallId: originalId,
      verdict: "recall",
      p: prev?.p,
      reason: "recall",
      tool: prev?.tool ?? "",
      keyArg: prev?.keyArg ?? "",
      sizeTokens: prev?.sizeTokens ?? 0,
      turnsAgo: prev?.turnsAgo ?? 0,
      step: prev?.step ?? 0,
      at,
    };
    // Bypass the store's "recall over prune" guard order: recall always overrides prune.
    if (this.decisions.set(d)) {
      this.persist(d);
      this.log({ ts: at, window: "closed", mode: this.config.mode, ...pick(d), applied: false });
    }
    if (recallResultId) {
      const pin: Decision = { ...d, toolCallId: recallResultId, verdict: "pin", reason: "recall-result", p: undefined };
      if (this.decisions.set(pin)) this.persist(pin);
    }
    return d;
  }

  private decide(
    c: Candidate,
    verdict: Verdict,
    reason: string,
    p: number | undefined,
    step: number,
    at: string,
    window: WindowReason,
    applied: boolean,
    signals?: WindowSignalsInfo,
    usedTokens?: number,
    extra: { promoted?: boolean; batchSaved?: number } = {},
  ): void {
    const d: Decision = {
      toolCallId: c.toolCallId,
      verdict,
      p,
      reason,
      tool: c.tool,
      keyArg: c.keyArg,
      sizeTokens: c.sizeTokens,
      turnsAgo: c.turnsAgo,
      step,
      at,
    };
    if (!this.decisions.set(d)) return;
    if (verdict === "prune") this.persist(d);
    this.log({ ts: at, window, mode: this.config.mode, ...pick(d), applied, signals, usedTokens, jevIn: this.judge?.usage.input, ...extra });
  }
}

/** Tokens a stub saves for this candidate (size minus the stub's own size). */
function savedBy(c: Candidate): number {
  const text = stubText({
    toolCallId: c.toolCallId,
    tool: c.tool,
    keyArg: c.keyArg,
    lines: c.lines,
    sizeTokens: c.sizeTokens,
    isError: c.isError,
  });
  return Math.max(0, c.sizeTokens - Math.ceil(text.length / 4));
}

function pick(d: Decision): Omit<LogRecord, "ts" | "window" | "mode" | "applied"> {
  return {
    toolCallId: d.toolCallId,
    tool: d.tool,
    keyArg: d.keyArg,
    sizeTokens: d.sizeTokens,
    turnsAgo: d.turnsAgo,
    step: d.step,
    p: d.p,
    verdict: d.verdict,
    reason: d.reason,
  };
}
