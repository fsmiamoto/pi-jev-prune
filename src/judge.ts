import { noul, type EntryType, type NoulQuestion, type TypeSafeClient } from "@typesafe-ai/sdk";
import type { Candidate } from "./candidates.ts";

/** Compact view of a candidate as sent to Jev. Keep it small: accuracy drops with irrelevant state. */
export interface JudgeCandidate {
  id: number;
  tool: string;
  arg: string;
  turnsAgo: number;
  sizeTokens: number;
  isError: boolean;
  head: string;
  tail?: string;
  agentReaction?: string;
}

export interface JudgeState {
  task: string;
  now: string;
  candidates: JudgeCandidate[];
}

export interface JudgeRequest {
  state: JudgeState;
  questions: Record<string, NoulQuestion>;
  /** toolCallId per question key. */
  ids: Record<string, string>;
}

export interface JudgeUsage {
  input: number;
  output: number;
  requests: number;
}

export interface JudgeResult {
  /** toolCallId → p(agent needs to re-read). Missing = not judged (timeout/error). */
  p: Map<string, number>;
  usage: JudgeUsage;
  ms: number;
  batches: number;
  errors: string[];
}

export interface Judge {
  judge(task: string, now: string, candidates: Candidate[], opts: JudgeOpts): Promise<JudgeResult>;
  /** Cumulative usage across the process lifetime. */
  readonly usage: JudgeUsage;
}

export interface JudgeOpts {
  timeoutMs: number;
  maxStateTokens?: number;
  signal?: AbortSignal;
}

export const QUESTION =
  "Will the agent need to look at the full output of this tool result (`candidate`) again to finish `task`, given what it is doing `now`?";

export const CRITERIA = {
  true: "The output still holds details the agent has to consult later: exact text it is about to edit, an error it has not fixed yet, values it must copy, a listing it is still working through, or the file it is currently changing.",
  false: "The agent already took what it needed from it (see `candidate.agentReaction`), it was orientation only, a newer read or edit of the same target replaced it, or it is unrelated to the remaining work.",
} as const;

export function toJudgeCandidate(c: Candidate, id: number): JudgeCandidate {
  const j: JudgeCandidate = {
    id,
    tool: c.tool,
    arg: c.keyArg,
    turnsAgo: c.turnsAgo,
    sizeTokens: c.sizeTokens,
    isError: c.isError,
    head: c.head,
  };
  if (c.tail) j.tail = c.tail;
  if (c.agentReaction) j.agentReaction = c.agentReaction;
  return j;
}

export function buildRequest(task: string, now: string, batch: Candidate[]): JudgeRequest {
  const candidates = batch.map((c, i) => toJudgeCandidate(c, i));
  const questions: Record<string, NoulQuestion> = {};
  const ids: Record<string, string> = {};
  batch.forEach((c, i) => {
    const key = `c${i}`;
    ids[key] = c.toolCallId;
    questions[key] = noul({ candidate: `candidates[${i}]`, question: QUESTION }, { ...CRITERIA });
  });
  return { state: { task, now, candidates }, questions, ids };
}

/** Rough token estimate for the serialized state (chars/4). */
export function estimateStateTokens(task: string, now: string, batch: Candidate[]): number {
  const s = JSON.stringify({ task, now, candidates: batch.map((c, i) => toJudgeCandidate(c, i)) });
  // questions add ~120 tokens each
  return Math.ceil(s.length / 4) + batch.length * 120;
}

/** Split candidates so each request stays under `maxTokens` (state + questions). */
export function batchCandidates(task: string, now: string, cands: Candidate[], maxTokens: number): Candidate[][] {
  const base = Math.ceil(JSON.stringify({ task, now }).length / 4);
  const out: Candidate[][] = [];
  let cur: Candidate[] = [];
  let curTokens = base;
  for (const c of cands) {
    const t = Math.ceil(JSON.stringify(toJudgeCandidate(c, 0)).length / 4) + 120;
    if (cur.length > 0 && curTokens + t > maxTokens) {
      out.push(cur);
      cur = [];
      curTokens = base;
    }
    cur.push(c);
    curTokens += t;
  }
  if (cur.length > 0) out.push(cur);
  return out;
}

type Client = Pick<TypeSafeClient, "systemOne">;

/** Create a Judge backed by TypeSafe. Never throws from `judge()`: failures land in `errors`. */
export function createJevJudge(client: Client, model = "jev-latest"): Judge {
  const usage: JudgeUsage = { input: 0, output: 0, requests: 0 };
  return {
    usage,
    async judge(task, now, candidates, opts) {
      const t0 = performance.now();
      const p = new Map<string, number>();
      const errors: string[] = [];
      const batches = batchCandidates(task, now, candidates, opts.maxStateTokens ?? 24_000);
      const settled = await Promise.allSettled(
        batches.map(async (batch) => {
          const req = buildRequest(task, now, batch);
          const res = await withTimeout(
            client.systemOne({ model, state: req.state as unknown as EntryType, questions: req.questions }, {
              timeout: opts.timeoutMs,
              retry: { maxRetries: 0 },
              signal: opts.signal,
            }),
            opts.timeoutMs + 50,
          );
          usage.requests++;
          usage.input += res.usage?.input_tokens ?? 0;
          usage.output += res.usage?.output_tokens ?? 0;
          for (const [key, id] of Object.entries(req.ids)) {
            const a = res.answers[key];
            if (a && typeof a.noul === "number") p.set(id, a.noul);
          }
        }),
      );
      for (const s of settled) if (s.status === "rejected") errors.push(String(s.reason?.message ?? s.reason));
      return { p, usage: { ...usage }, ms: Math.round(performance.now() - t0), batches: batches.length, errors };
    },
  };
}

function withTimeout<T>(pr: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`jev timeout after ${ms}ms`)), ms);
    pr.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}
