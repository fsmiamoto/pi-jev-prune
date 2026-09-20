import type { PruneMode } from "./config.ts";

export interface WindowSignals {
  mode: PruneMode;
  /** Last message in context is a user message (new user turn). */
  userTurn: boolean;
  /** Current context usage in tokens (best estimate). */
  usedTokens: number;
  budget: number;
  pressurePct: number;
  pendingPct: number;
  /** Tokens in eligible candidates not yet pruned/kept-sticky. */
  pendingTokens: number;
  /** Prompt cache believed cold (idle past TTL or warming stopped). */
  coldCache: boolean;
  /** `/prune now` requested. */
  forced?: boolean;
}

export type WindowReason =
  | "off"
  | "closed"
  | "every-call"
  | "forced"
  | "user-turn"
  | "over-budget"
  | "pressure"
  | "cold-cache"
  | "pending";

export interface WindowDecision {
  open: boolean;
  reason: WindowReason;
}

/**
 * Pure decision: should prunes be judged/applied before this LLM call?
 * Windows are the only points where the message prefix may change (prompt-cache friendliness).
 */
export function decideWindow(s: WindowSignals): WindowDecision {
  if (s.mode === "off") return { open: false, reason: "off" };
  if (s.mode === "every-call") return { open: true, reason: "every-call" };
  if (s.forced) return { open: true, reason: "forced" };
  if (s.userTurn) return { open: true, reason: "user-turn" };
  if (s.usedTokens > s.budget) return { open: true, reason: "over-budget" };
  if (s.usedTokens >= s.pressurePct * s.budget) return { open: true, reason: "pressure" };
  if (s.coldCache) return { open: true, reason: "cold-cache" };
  if (s.pendingTokens >= s.pendingPct * s.budget) return { open: true, reason: "pending" };
  return { open: false, reason: "closed" };
}
