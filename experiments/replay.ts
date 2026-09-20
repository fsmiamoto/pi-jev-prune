/**
 * Offline replay (D6): run the candidate + Jev pipeline over recorded pi sessions.
 *
 * For every LLM call in a session (= every assistant message on the main branch) we rebuild the exact
 * message list pi would have sent (`buildSessionContext` at that leaf, compaction-aware), feed it to the
 * Engine with a simulated clock, and record every decision. Afterwards we compute, per session and overall:
 *   - tokens prunable vs kept, prune rate, p-distribution
 *   - re-read proxy FP rate: a pruned result whose same tool+keyArg (or path) was read/edited again later
 *   - a threshold sweep (using each candidate's first Jev verdict) → recommendation input
 *
 * Safety: only the session dirs in JEV_PRUNE_SESSIONS are read; any session whose text matches JEV_PRUNE_EXCLUDE is skipped
 * *before* anything is sent to TypeSafe. A hard cap on Jev input tokens stops the run.
 *
 * Usage: TYPESAFE_API_KEY=… JEV_PRUNE_SESSIONS='--Users-me-Code-repo--,…' [JEV_PRUNE_EXCLUDE='pattern'] \
 *        node --experimental-strip-types experiments/replay.ts [--limit N] [--threshold 0.35] [--dry]
 *   --dry     do not call Jev (code-only auto-prunes; useful to check plumbing)
 *   --out DIR default experiments/out
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { buildSessionContext, parseSessionEntries, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { TypeSafeClient } from "@typesafe-ai/sdk";
import { keyArgOf } from "../src/candidates.ts";
import { DEFAULTS, type PruneConfig } from "../src/config.ts";
import { DecisionStore } from "../src/decisions.ts";
import { Engine, type LogRecord } from "../src/engine.ts";
import { createJevJudge, type Judge, type JudgeUsage } from "../src/judge.ts";

const SESSIONS_ROOT = join(homedir(), ".pi", "agent", "sessions");
/**
 * Which session dirs (subdirs of ~/.pi/agent/sessions, e.g. `--Users-me-Code-myrepo--`) may be replayed.
 * Required: set JEV_PRUNE_SESSIONS to a comma-separated list. Nothing outside it is ever read.
 */
export const ALLOWLIST = (process.env.JEV_PRUNE_SESSIONS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
/**
 * Sessions whose raw text matches this pattern are skipped before anything leaves the machine
 * (e.g. `JEV_PRUNE_EXCLUDE='clientname|secret-project'`). Default: exclude nothing.
 */
export const EXCLUDE = process.env.JEV_PRUNE_EXCLUDE ? new RegExp(process.env.JEV_PRUNE_EXCLUDE, "i") : /(?!)/;
/** Jev input-token cap for the whole run (PLAN safety bound: 20M for the run; keep replay well under). */
const SPEND_CAP_INPUT = 6_000_000;
const MIN_TOOL_RESULTS = 8;
const MIN_TOOL_TOKENS = 5_000;

interface Args {
  limit: number;
  threshold: number;
  dry: boolean;
  out: string;
  timeoutMs: number;
  only?: string;
  /** Replay p-values recorded in a previous run's <id>.decisions.jsonl instead of calling Jev. */
  reuse?: string;
}

function parseArgs(argv: string[]): Args {
  const a: Args = { limit: 100, threshold: DEFAULTS.threshold, dry: false, out: "experiments/out", timeoutMs: 10_000 };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i]!;
    const v = argv[i + 1];
    if (k === "--limit") a.limit = Number(v), i++;
    else if (k === "--threshold") a.threshold = Number(v), i++;
    else if (k === "--dry") a.dry = true;
    else if (k === "--out") a.out = v!, i++;
    else if (k === "--timeout") a.timeoutMs = Number(v), i++;
    else if (k === "--only") a.only = v, i++;
    else if (k === "--reuse") a.reuse = v, i++;
  }
  return a;
}

export interface SessionFile {
  path: string;
  id: string;
  dir: string;
  toolResults: number;
  toolTokens: number;
}

/** Enumerate allowlisted, pattern-clean, big-enough sessions (text is checked before any network use). */
export function listSessions(): SessionFile[] {
  const out: SessionFile[] = [];
  if (ALLOWLIST.length === 0) throw new Error("set JEV_PRUNE_SESSIONS to a comma-separated list of session dir names under ~/.pi/agent/sessions");
  for (const dir of ALLOWLIST) {
    const full = join(SESSIONS_ROOT, dir);
    if (!existsSync(full)) continue;
    for (const f of readdirSync(full)) {
      if (!f.endsWith(".jsonl")) continue;
      const path = join(full, f);
      const text = readFileSync(path, "utf8");
      if (EXCLUDE.test(text)) continue;
      let toolResults = 0;
      let toolTokens = 0;
      for (const line of text.split("\n")) {
        if (!line) continue;
        let e: any;
        try {
          e = JSON.parse(line);
        } catch {
          continue;
        }
        if (e.type === "message" && e.message?.role === "toolResult") {
          toolResults++;
          for (const c of e.message.content ?? []) if (c.type === "text") toolTokens += Math.ceil(c.text.length / 4);
        }
      }
      if (toolResults < MIN_TOOL_RESULTS || toolTokens < MIN_TOOL_TOKENS) continue;
      out.push({ path, id: basename(f, ".jsonl").split("_").pop()!, dir, toolResults, toolTokens });
    }
  }
  return out.sort((a, b) => b.toolTokens - a.toolTokens);
}

/** Document frequency of identifier-like tokens across sessions (background vocabulary filter for the citation proxy). */
export function buildDF(sessions: SessionFile[]): Map<string, number> {
  const df = new Map<string, number>();
  for (const s of sessions) for (const t of tokensOf(readFileSync(s.path, "utf8"), 200_000)) df.set(t, (df.get(t) ?? 0) + 1);
  return df;
}
/** A cited token counts only if it occurs in at most this many sessions. */
const MAX_DF = 2;

/** Main-branch entries (root → last entry). */
function mainBranch(entries: SessionEntry[]): SessionEntry[] {
  const byId = new Map(entries.map((e) => [e.id, e]));
  const leaf = entries.at(-1);
  if (!leaf) return [];
  const chain: SessionEntry[] = [];
  let cur: SessionEntry | undefined = leaf;
  while (cur) {
    chain.push(cur);
    cur = cur.parentId ? byId.get(cur.parentId) : undefined;
  }
  return chain.reverse();
}

interface ToolUse {
  step: number;
  tool: string;
  keyArg: string;
  toolCallId: string;
}

export interface CandidateOutcome {
  session: string;
  toolCallId: string;
  tool: string;
  keyArg: string;
  sizeTokens: number;
  /** Step at which Jev first judged it, and that p. */
  firstStep: number;
  firstP?: number;
  /** All (step, p) verdicts. */
  ps: Array<[number, number]>;
  /** Final verdict under the run's threshold (sticky). */
  verdict: "prune" | "keep" | "auto";
  pruneStep?: number;
  /** Same tool+keyArg used again after pruneStep (or after firstStep when kept). */
  rereadLater: boolean;
  /** For read: edit/write on the same path later. */
  editLater: boolean;
  /** Any later use of the same path/keyArg by any tool. */
  touchedLater: boolean;
  /**
   * Novel-token citation proxy: a later assistant message / tool-call argument (after pruneStep) contains an
   * identifier/path that FIRST appeared in this tool output and was not re-supplied by any other tool result or
   * user message in between. Strong evidence the agent still needed this output.
   */
  citedLater: boolean;
  citedTokens: string[];
  /** Steps between prune and first citation (or -1). */
  citedAfterSteps: number;
}

const TOKEN_RE = /[A-Za-z_$][A-Za-z0-9_$./:-]{5,}|\d{4,}/g;
const STOP = new Set(["https://", "http://", "node_modules", "node_modules/", "package.json", "tsconfig.json", ".gitignore", "readme.md", "index.ts", "index.js", "src/index.ts"]);

/**
 * Code-like identifier: has a letter and (a separator/digit or camelCase), ≥3 distinct chars, no single char > 50%.
 * Plain English words ("should", "remove") never count — they are far too common to indicate reuse of a tool output.
 */
export function isIdentifierLike(t: string): boolean {
  if (t.length < 6 || STOP.has(t.toLowerCase())) return false;
  if (!/[A-Za-z]/.test(t)) return t.length >= 4 && /^\d+$/.test(t) && !/^(19|20)\d\d$/.test(t); // numbers ≥4 digits, not years
  if (!(/[/_.\-:0-9]/.test(t) || /[a-z][A-Z]/.test(t))) return false;
  const distinct = new Set(t).size;
  if (distinct < 3) return false;
  const counts = new Map<string, number>();
  for (const ch of t) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  if (Math.max(...counts.values()) > t.length / 2) return false;
  return true;
}

function tokensOf(text: string, cap = 3000): Set<string> {
  const out = new Set<string>();
  for (const m of text.matchAll(TOKEN_RE)) {
    const t = m[0]!.replace(/^[./:-]+|[.:,/-]+$/g, "");
    if (!isIdentifierLike(t)) continue;
    out.add(t);
    if (out.size >= cap) break;
  }
  return out;
}

function textOfMessage(m: AgentMessage): { text: string; args: string } {
  let text = "";
  let args = "";
  const content = (m as any).content;
  if (typeof content === "string") text = content;
  else if (Array.isArray(content))
    for (const c of content) {
      if (c.type === "text") text += c.text + "\n";
      else if (c.type === "toolCall") args += JSON.stringify(c.arguments) + "\n";
    }
  return { text, args };
}

export interface SessionSummary {
  session: string;
  dir: string;
  llmCalls: number;
  toolResults: number;
  toolTokens: number;
  candidatesJudged: number;
  windows: Record<string, number>;
  jevRequests: number;
  jevInputTokens: number;
  jevMsP50: number;
  jevMsMax: number;
  jevTimeouts2s: number;
  jevErrors: number;
  pruned: number;
  prunedTokens: number;
  autoPruned: number;
  autoPrunedTokens: number;
  kept: number;
  keptTokens: number;
  peakContextTokens: number;
  peakContextTokensPruned: number;
  fpReread: number;
  fpEdit: number;
  fpCited: number;
  keptCited: number;
  fnUntouchedKept: number;
}

/**
 * Offline judge: answers from a previous run's decision log. For a candidate asked at step s, returns the recorded p
 * at the latest step ≤ s (else the earliest recorded). Exact reproduction when the threshold is unchanged; a close
 * approximation when sweeping thresholds (kept-longer candidates reuse their last recorded p).
 */
export function createReplayJudge(decisionsPath: string, cursor: { step: number }): Judge {
  const byId = new Map<string, Array<[number, number]>>();
  if (existsSync(decisionsPath))
    for (const line of readFileSync(decisionsPath, "utf8").split("\n")) {
      if (!line) continue;
      const r = JSON.parse(line) as LogRecord;
      if (r.p === undefined) continue;
      byId.set(r.toolCallId, [...(byId.get(r.toolCallId) ?? []), [r.step, r.p]]);
    }
  const usage: JudgeUsage = { input: 0, output: 0, requests: 0 };
  return {
    usage,
    async judge(_task, _now, candidates) {
      const p = new Map<string, number>();
      for (const c of candidates) {
        const ps = byId.get(c.toolCallId);
        if (!ps) continue;
        const rec = [...ps].reverse().find(([s]) => s <= cursor.step) ?? ps[0]!;
        p.set(c.toolCallId, rec[1]);
      }
      return { p, usage, ms: 0, batches: 1, errors: [] };
    },
  };
}

export async function replaySession(
  file: SessionFile,
  cfg: PruneConfig,
  judge: Judge | undefined,
  outDir: string,
  cursor: { step: number } = { step: 0 },
  df: Map<string, number> = new Map(),
): Promise<{ summary: SessionSummary; outcomes: CandidateOutcome[] }> {
  const text = readFileSync(file.path, "utf8");
  const entries = parseSessionEntries(text).filter((e): e is SessionEntry => e.type !== "session");
  const branch = mainBranch(entries);
  const records: LogRecord[] = [];
  let clock = 0;
  const engine = new Engine({
    config: cfg,
    decisions: new DecisionStore(),
    judge,
    now: () => clock,
    log: (r) => records.push(r),
  });

  // All tool uses in order (for the re-read proxy), keyed by step.
  const uses: ToolUse[] = [];
  let stepCount = 0;
  for (const e of branch) {
    if (e.type !== "message" || e.message.role !== "assistant") continue;
    for (const c of e.message.content) {
      if (c.type === "toolCall") uses.push({ step: stepCount, tool: c.name, keyArg: keyArgOf(c.name, c.arguments as Record<string, unknown>), toolCallId: c.id });
    }
    stepCount++;
  }

  const windows: Record<string, number> = {};
  let peak = 0;
  let peakPruned = 0;
  let llmCalls = 0;
  const jevMs: number[] = [];
  let jevErrors = 0;
  let timeouts2s = 0;
  const usageBefore = judge ? { ...judge.usage } : undefined;

  // For every assistant message, the LLM call happened with the context ending at its parent entry.
  let assistantSeen = 0;
  for (let i = 0; i < branch.length; i++) {
    const e = branch[i]!;
    if (e.type !== "message" || e.message.role !== "assistant") continue;
    cursor.step = assistantSeen++;
    const parent = branch[i - 1];
    if (!parent) continue;
    clock = Date.parse(parent.timestamp) || clock;
    const ctx = buildSessionContext(entries, parent.id);
    const messages: AgentMessage[] = ctx.messages;
    if (messages.length === 0) continue;
    llmCalls++;
    const res = await engine.onContext(messages, undefined);
    windows[res.status.window] = (windows[res.status.window] ?? 0) + 1;
    const used = res.status.usedTokens + res.status.savedTokens; // pre-prune estimate
    peak = Math.max(peak, used);
    peakPruned = Math.max(peakPruned, res.status.usedTokens);
    if (res.status.jev) {
      jevMs.push(res.status.jev.ms);
      jevErrors += res.status.jev.errors.length;
      if (res.status.jev.ms > 2000) timeouts2s++;
    }
    // Make the reply of this step visible to the clock too.
    clock = Date.parse(e.timestamp) || clock;
  }

  // Outcomes per candidate.
  const byId = new Map<string, CandidateOutcome>();
  for (const r of records) {
    if (r.verdict === "recall" || r.verdict === "pin") continue;
    let o = byId.get(r.toolCallId);
    if (!o) {
      o = {
        session: file.id,
        toolCallId: r.toolCallId,
        tool: r.tool,
        keyArg: r.keyArg,
        sizeTokens: r.sizeTokens,
        firstStep: r.step,
        firstP: r.p,
        ps: [],
        verdict: "keep",
        rereadLater: false,
        editLater: false,
        touchedLater: false,
        citedLater: false,
        citedTokens: [],
        citedAfterSteps: -1,
      };
      byId.set(r.toolCallId, o);
    }
    if (r.p !== undefined) o.ps.push([r.step, r.p]);
    if (r.verdict === "prune") {
      o.verdict = r.reason.startsWith("superseded") ? "auto" : "prune";
      o.pruneStep = o.pruneStep ?? r.step;
    }
  }
  const outcomes = [...byId.values()];
  for (const o of outcomes) {
    const after = o.pruneStep ?? o.firstStep;
    const own = uses.find((u) => u.toolCallId === o.toolCallId);
    for (const u of uses) {
      if (u.step < after || u.toolCallId === o.toolCallId) continue;
      const sameArg = u.keyArg !== "" && u.keyArg === o.keyArg;
      const samePath = sameArg || (o.keyArg !== "" && own && isPathTool(own.tool) && isPathTool(u.tool) && u.keyArg === o.keyArg);
      if (u.tool === o.tool && sameArg) o.rereadLater = true;
      if (isPathTool(o.tool) && (u.tool === "edit" || u.tool === "write") && samePath) o.editLater = true;
      if (samePath || (o.keyArg !== "" && u.keyArg.includes(o.keyArg))) o.touchedLater = true;
    }
  }

  // Novel-token citation proxy over the final main-branch message list (compaction-unaware on purpose: we want
  // the raw chronology). Steps are numbered by assistant message like `uses`.
  {
    const finalCtx = buildSessionContext(entries, branch.at(-1)?.id ?? null);
    const msgs = finalCtx.messages;
    const seen = new Map<string, number>(); // token -> first step seen anywhere
    const resultStep = new Map<string, number>(); // toolCallId -> step index (assistant step count at that point)
    const resultTokens = new Map<string, Set<string>>(); // toolCallId -> novel tokens
    let step = 0;
    // pass 1: novel tokens per tool result
    for (const m of msgs) {
      if (m.role === "assistant") {
        const { text, args } = textOfMessage(m);
        for (const t of tokensOf(text + args)) if (!seen.has(t)) seen.set(t, step);
        step++;
        continue;
      }
      const { text } = textOfMessage(m);
      const toks = tokensOf(text);
      if (m.role === "toolResult" && byId.has(m.toolCallId)) {
        const novel = new Set<string>();
        for (const t of toks) if (!seen.has(t) && (df.get(t) ?? 1) <= MAX_DF) novel.add(t);
        resultTokens.set(m.toolCallId, novel);
        resultStep.set(m.toolCallId, step);
      }
      for (const t of toks) if (!seen.has(t)) seen.set(t, step);
    }
    // pass 2: for each candidate, walk forward from its step; a token is "re-supplied" if any non-assistant
    // message after the candidate contains it before the citing assistant step.
    step = 0;
    const resupplied = new Map<string, Set<string>>(); // toolCallId -> tokens re-supplied so far
    const pending = [...byId.values()].filter((o) => resultTokens.has(o.toolCallId));
    for (const m of msgs) {
      if (m.role === "assistant") {
        const { text, args } = textOfMessage(m);
        const blob = text + args;
        for (const o of pending) {
          if (o.citedLater) continue;
          const after = o.pruneStep ?? o.firstStep;
          if (step < after) continue; // assistant msg #after was produced by the pruning call itself
          const novel = resultTokens.get(o.toolCallId)!;
          const re = resupplied.get(o.toolCallId);
          for (const t of novel) {
            if (re?.has(t)) continue;
            if (blob.includes(t)) {
              o.citedLater = true;
              o.citedAfterSteps = step - after;
              o.citedTokens.push(t);
              if (o.citedTokens.length >= 5) break;
            }
          }
        }
        step++;
        continue;
      }
      const { text } = textOfMessage(m);
      const toks = tokensOf(text);
      for (const o of pending) {
        if (m.role === "toolResult" && m.toolCallId === o.toolCallId) continue;
        if (step <= (resultStep.get(o.toolCallId) ?? 0)) continue;
        const novel = resultTokens.get(o.toolCallId)!;
        let re = resupplied.get(o.toolCallId);
        for (const t of toks)
          if (novel.has(t)) {
            if (!re) resupplied.set(o.toolCallId, (re = new Set()));
            re.add(t);
          }
      }
    }
  }

  const jevInput = judge && usageBefore ? judge.usage.input - usageBefore.input : 0;
  const jevReq = judge && usageBefore ? judge.usage.requests - usageBefore.requests : 0;
  const pruned = outcomes.filter((o) => o.verdict === "prune");
  const auto = outcomes.filter((o) => o.verdict === "auto");
  const kept = outcomes.filter((o) => o.verdict === "keep");
  const sorted = [...jevMs].sort((a, b) => a - b);
  const summary: SessionSummary = {
    session: file.id,
    dir: file.dir,
    llmCalls,
    toolResults: file.toolResults,
    toolTokens: file.toolTokens,
    candidatesJudged: outcomes.filter((o) => o.ps.length > 0).length,
    windows,
    jevRequests: jevReq,
    jevInputTokens: jevInput,
    jevMsP50: sorted.length ? sorted[Math.floor(sorted.length / 2)]! : 0,
    jevMsMax: sorted.at(-1) ?? 0,
    jevTimeouts2s: timeouts2s,
    jevErrors,
    pruned: pruned.length,
    prunedTokens: pruned.reduce((n, o) => n + o.sizeTokens, 0),
    autoPruned: auto.length,
    autoPrunedTokens: auto.reduce((n, o) => n + o.sizeTokens, 0),
    kept: kept.length,
    keptTokens: kept.reduce((n, o) => n + o.sizeTokens, 0),
    peakContextTokens: peak,
    peakContextTokensPruned: peakPruned,
    fpReread: pruned.filter((o) => o.rereadLater).length,
    fpEdit: pruned.filter((o) => o.editLater).length,
    fpCited: pruned.filter((o) => o.citedLater).length,
    keptCited: kept.filter((o) => o.citedLater).length,
    fnUntouchedKept: kept.filter((o) => !o.touchedLater).length,
  };
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, `${file.id}.decisions.jsonl`), records.map((r) => JSON.stringify({ session: file.id, ...r })).join("\n") + "\n");
  writeFileSync(join(outDir, `${file.id}.outcomes.json`), JSON.stringify(outcomes, null, 1));
  return { summary, outcomes };
}

function isPathTool(t: string): boolean {
  return t === "read" || t === "edit" || t === "write" || t === "ls";
}

/** Threshold sweep over first-verdict p: prune iff firstP < t. */
export function sweep(outcomes: CandidateOutcome[], thresholds: number[]) {
  const judged = outcomes.filter((o) => o.firstP !== undefined);
  return thresholds.map((t) => {
    const P = judged.filter((o) => o.firstP! < t);
    const K = judged.filter((o) => o.firstP! >= t);
    const fp = P.filter((o) => o.rereadLater || o.editLater).length;
    const fpTouched = P.filter((o) => o.touchedLater).length;
    const fpCited = P.filter((o) => o.citedLater).length;
    const keptCited = K.filter((o) => o.citedLater).length;
    return {
      t,
      pruned: P.length,
      pruneRate: judged.length ? P.length / judged.length : 0,
      tokensSaved: P.reduce((n, o) => n + o.sizeTokens, 0),
      tokensKept: K.reduce((n, o) => n + o.sizeTokens, 0),
      fpRereadOrEdit: fp,
      fpRate: P.length ? fp / P.length : 0,
      fpTouchedRate: P.length ? fpTouched / P.length : 0,
      fpCited,
      fpCitedRate: P.length ? fpCited / P.length : 0,
      keptCited,
      /** Of all cited (needed) candidates, how many did we keep? */
      citedRecall: fpCited + keptCited ? keptCited / (fpCited + keptCited) : NaN,
      untouchedKept: K.filter((o) => !o.touchedLater).length,
    };
  });
}

export function histogram(ps: number[], bins = 10): string {
  const counts = new Array<number>(bins).fill(0);
  for (const p of ps) counts[Math.min(bins - 1, Math.floor(p * bins))]!++;
  const max = Math.max(1, ...counts);
  return counts
    .map((c, i) => `${(i / bins).toFixed(1)}–${((i + 1) / bins).toFixed(1)} ${"█".repeat(Math.round((c / max) * 40)).padEnd(40)} ${c}`)
    .join("\n");
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const cfg: PruneConfig = { ...DEFAULTS, mode: "on", threshold: args.threshold, timeoutMs: args.timeoutMs, logPath: "/dev/null" };
  let sessions = listSessions();
  if (args.only) sessions = sessions.filter((s) => s.id.startsWith(args.only!));
  sessions = sessions.slice(0, args.limit);
  console.log(`replay: ${sessions.length} sessions, threshold=${cfg.threshold}, jev=${args.dry ? "off" : args.reuse ? `reuse:${args.reuse}` : cfg.model}`);
  let judge: Judge | undefined;
  if (!args.dry && !args.reuse) judge = createJevJudge(new TypeSafeClient({ logLevel: "off" }), cfg.model);
  if (args.reuse && args.out === args.reuse) throw new Error("--out must differ from --reuse");
  mkdirSync(args.out, { recursive: true });
  const df = buildDF(sessions);
  console.log(`background vocabulary: ${df.size} tokens, ${[...df.values()].filter((n) => n > MAX_DF).length} with df>${MAX_DF} ignored`);
  const summaries: SessionSummary[] = [];
  const all: CandidateOutcome[] = [];
  for (const s of sessions) {
    if (judge && judge.usage.input > SPEND_CAP_INPUT) {
      console.log(`spend cap reached (${judge.usage.input} input tokens) — stopping`);
      break;
    }
    const t0 = Date.now();
    const cursor = { step: 0 };
    const sessionJudge = args.reuse ? createReplayJudge(join(args.reuse, `${s.id}.decisions.jsonl`), cursor) : judge;
    const { summary, outcomes } = await replaySession(s, cfg, sessionJudge, args.out, cursor, df);
    summaries.push(summary);
    all.push(...outcomes);
    console.log(
      `${s.id.slice(0, 8)} ${s.dir.replace(/^--Users-[^-]+-/, "").replace(/--$/, "").padEnd(20)} calls=${summary.llmCalls} judged=${summary.candidatesJudged} pruned=${summary.pruned}(${summary.prunedTokens}t) auto=${summary.autoPruned} kept=${summary.kept}(${summary.keptTokens}t) fp=${summary.fpReread}/${summary.fpEdit}/cited${summary.fpCited}(kept${summary.keptCited}) peak=${summary.peakContextTokens}→${summary.peakContextTokensPruned} jev=${summary.jevRequests}req/${summary.jevInputTokens}t p50=${summary.jevMsP50}ms max=${summary.jevMsMax}ms ${((Date.now() - t0) / 1000).toFixed(0)}s`,
    );
    writeFileSync(join(args.out, "summary.json"), JSON.stringify({ args, summaries, sweep: sweep(all, SWEEP), usage: judge?.usage, sessionMeta: sessions }, null, 1));
  }
  const ps = all.map((o) => o.firstP).filter((p): p is number => p !== undefined);
  console.log(`\np-distribution (first verdict, n=${ps.length}):\n${histogram(ps)}`);
  console.log("\nthreshold sweep:");
  for (const r of sweep(all, SWEEP)) {
    console.log(
      `t=${r.t.toFixed(2)} pruned=${String(r.pruned).padStart(4)} rate=${(r.pruneRate * 100).toFixed(0).padStart(3)}% saved=${String(r.tokensSaved).padStart(7)}t kept=${String(r.tokensKept).padStart(7)}t fp(reread|edit)=${(r.fpRate * 100).toFixed(0).padStart(3)}% fp(cited)=${String(r.fpCited).padStart(3)}/${String(r.pruned).padStart(3)}=${(r.fpCitedRate * 100).toFixed(0).padStart(3)}% citedRecall=${(r.citedRecall * 100).toFixed(0).padStart(3)}% untouchedKept=${r.untouchedKept}`,
    );
  }
  if (judge) console.log(`\njev usage: ${judge.usage.requests} req, ${judge.usage.input} in / ${judge.usage.output} out tokens`);
}

const SWEEP = [0.2, 0.25, 0.3, 0.35, 0.4, 0.45, 0.5, 0.55, 0.6];

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
