/**
 * Decision store: what has been decided per toolCallId.
 * - `prune`: sticky. Result is stubbed (when mode applies prunes). Never flips back except via recall.
 * - `keep`: transient Jev verdict (p ≥ threshold). Re-judged at a later window once new steps happened.
 * - `staged`: transient prune verdict (Jev or superseded) waiting for a batch big enough to justify a
 *   prompt-cache rewrite (`minApplyPct`). Not stubbed, never re-judged; promoted to `prune` at a later window.
 * - `recall`: sticky. Original was recalled by the agent; stays stubbed, never re-judged, counted as FP.
 * - `pin`: sticky keep. Never a candidate (e.g. the recall tool's own result).
 *
 * Keyed by toolCallId, never by position (branches/compaction shift positions).
 */
export type Verdict = "prune" | "keep" | "staged" | "recall" | "pin";

export interface Decision {
  toolCallId: string;
  verdict: Verdict;
  /** Jev probability that the agent needs to re-read; undefined for code-only decisions. */
  p?: number;
  /** Why: "jev" | "superseded:<tool>" | "recall" | "pin" | "dry" … */
  reason: string;
  tool: string;
  keyArg: string;
  sizeTokens: number;
  turnsAgo: number;
  /** Assistant step count when decided (for keep re-judging). */
  step: number;
  /** ISO time. */
  at: string;
}

export const ENTRY_TYPE = "jev-prune";

const STICKY: ReadonlySet<Verdict> = new Set<Verdict>(["prune", "recall", "pin"]);

export function isSticky(v: Verdict): boolean {
  return STICKY.has(v);
}

export class DecisionStore {
  private readonly map = new Map<string, Decision>();

  get(id: string): Decision | undefined {
    return this.map.get(id);
  }

  /** Apply a decision. Sticky verdicts win over transient ones; `recall` wins over `prune`; `pin` is absolute. */
  set(d: Decision): boolean {
    const prev = this.map.get(d.toolCallId);
    if (prev) {
      if (prev.verdict === "pin") return false;
      if (prev.verdict === "recall") return false;
      if (prev.verdict === "prune" && (d.verdict === "keep" || d.verdict === "staged")) return false;
      // A staged prune is a stronger signal than a later keep; re-staging is a no-op.
      if (prev.verdict === "staged" && (d.verdict === "keep" || d.verdict === "staged")) return false;
    }
    this.map.set(d.toolCallId, d);
    return true;
  }

  /** Stubbed in context when pruning is applied: prune or recall. */
  isStubbed(id: string): boolean {
    const v = this.map.get(id)?.verdict;
    return v === "prune" || v === "recall";
  }

  /** Prune decided but not yet applied (waiting for a batch). */
  isStaged(id: string): boolean {
    return this.map.get(id)?.verdict === "staged";
  }

  /** Never a candidate again. */
  isFinal(id: string): boolean {
    const v = this.map.get(id)?.verdict;
    return v !== undefined && isSticky(v);
  }

  /** `keep` decided at the current step → don't ask Jev again this step. */
  isFreshKeep(id: string, step: number): boolean {
    const d = this.map.get(id);
    return d?.verdict === "keep" && d.step >= step;
  }

  all(): Decision[] {
    return [...this.map.values()];
  }

  byVerdict(v: Verdict): Decision[] {
    return this.all().filter((d) => d.verdict === v);
  }

  /** Rebuild from persisted session entries (custom entries of type `jev-prune`). Transient keeps are not persisted. */
  static fromEntries(entries: Iterable<unknown>): DecisionStore {
    const store = new DecisionStore();
    for (const e of entries) {
      const d = decisionFromEntry(e);
      if (d) store.set(d);
    }
    return store;
  }
}

/** Parse a pi session entry into a Decision, or undefined if it isn't ours / malformed. */
export function decisionFromEntry(e: unknown): Decision | undefined {
  if (!e || typeof e !== "object") return undefined;
  const entry = e as { type?: unknown; customType?: unknown; data?: unknown };
  if (entry.type !== "custom" || entry.customType !== ENTRY_TYPE) return undefined;
  const d = entry.data as Partial<Decision> | undefined;
  if (!d || typeof d.toolCallId !== "string" || typeof d.verdict !== "string") return undefined;
  if (!isSticky(d.verdict as Verdict)) return undefined;
  return {
    toolCallId: d.toolCallId,
    verdict: d.verdict as Verdict,
    p: typeof d.p === "number" ? d.p : undefined,
    reason: typeof d.reason === "string" ? d.reason : "",
    tool: typeof d.tool === "string" ? d.tool : "",
    keyArg: typeof d.keyArg === "string" ? d.keyArg : "",
    sizeTokens: typeof d.sizeTokens === "number" ? d.sizeTokens : 0,
    turnsAgo: typeof d.turnsAgo === "number" ? d.turnsAgo : 0,
    step: typeof d.step === "number" ? d.step : 0,
    at: typeof d.at === "string" ? d.at : "",
  };
}
