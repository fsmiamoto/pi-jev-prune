import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, ToolResultMessage, UserMessage } from "@earendil-works/pi-ai";
import type { Candidate } from "../src/candidates.ts";
import type { Judge, JudgeResult, JudgeUsage } from "../src/judge.ts";

let idCounter = 0;
export function nextId(prefix = "call"): string {
  return `${prefix}_${++idCounter}`;
}

export function user(text: string): UserMessage {
  return { role: "user", content: [{ type: "text", text }], timestamp: Date.now() };
}

export interface CallSpec {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

/** Assistant message with optional text and tool calls. */
export function assistant(text: string, calls: CallSpec[] = []): AssistantMessage {
  const content: AssistantMessage["content"] = [];
  if (text) content.push({ type: "text", text });
  for (const c of calls) content.push({ type: "toolCall", id: c.id, name: c.name, arguments: c.args as never });
  return {
    role: "assistant",
    content,
    api: "anthropic-messages",
    provider: "anthropic",
    model: "test",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: calls.length ? "toolUse" : "stop",
    timestamp: Date.now(),
  };
}

export function toolResult(id: string, name: string, text: string, isError = false): ToolResultMessage {
  return { role: "toolResult", toolCallId: id, toolName: name, content: [{ type: "text", text }], isError, timestamp: Date.now() };
}

/** ~n tokens of filler text with `lines` lines. */
export function big(tokens: number, label = "x"): string {
  const chars = tokens * 4;
  const line = `${label} `.padEnd(80, "-");
  const n = Math.ceil(chars / (line.length + 1));
  return Array.from({ length: n }, (_, i) => `${i + 1}: ${line}`).join("\n");
}

/** One assistant step: text + a tool call, followed by its result. */
export function step(text: string, call: CallSpec, result: string, isError = false): AgentMessage[] {
  return [assistant(text, [call]), toolResult(call.id, call.name, result, isError)];
}

/**
 * Build a typical conversation:
 * user → N steps of (assistant + read tool) → final assistant text (no tool call).
 * Returns messages and the ids of each read in order.
 */
export function conversation(reads: Array<{ path: string; tokens: number }>, opts: { trailingUser?: string; finalText?: string } = {}): {
  messages: AgentMessage[];
  ids: string[];
} {
  const messages: AgentMessage[] = [user("Explain how the CLI parses the manifest")];
  const ids: string[] = [];
  for (const r of reads) {
    const id = nextId();
    ids.push(id);
    messages.push(...step(`Reading ${r.path}`, { id, name: "read", args: { path: r.path } }, big(r.tokens, r.path)));
  }
  messages.push(assistant(opts.finalText ?? "Now I understand the structure. Moving on."));
  if (opts.trailingUser) messages.push(user(opts.trailingUser));
  return { messages, ids };
}

/** Deterministic fake Judge: p from a map (by toolCallId), default `fallback`. Records calls. */
export class FakeJudge implements Judge {
  usage: JudgeUsage = { input: 0, output: 0, requests: 0 };
  calls: Array<{ task: string; now: string; ids: string[] }> = [];
  /** ids that should be "missing" from the result (simulates timeout). */
  missing = new Set<string>();
  fail = false;
  ps: Map<string, number>;
  fallback: number;
  constructor(ps: Map<string, number> = new Map(), fallback = 0.1) {
    this.ps = ps;
    this.fallback = fallback;
  }
  async judge(task: string, now: string, candidates: Candidate[]): Promise<JudgeResult> {
    this.calls.push({ task, now, ids: candidates.map((c) => c.toolCallId) });
    this.usage.requests++;
    if (this.fail) return { p: new Map(), usage: this.usage, ms: 1, batches: 1, errors: ["jev timeout after 2000ms"] };
    const p = new Map<string, number>();
    for (const c of candidates) {
      if (this.missing.has(c.toolCallId)) continue;
      p.set(c.toolCallId, this.ps.get(c.toolCallId) ?? this.fallback);
    }
    return { p, usage: this.usage, ms: 1, batches: 1, errors: [] };
  }
}

export function textOf(m: AgentMessage): string {
  if (m.role !== "toolResult") return "";
  return m.content.map((c) => (c.type === "text" ? c.text : "")).join("");
}
