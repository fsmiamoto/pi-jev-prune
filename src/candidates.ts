import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";
import { estimateTokens } from "@earendil-works/pi-coding-agent";
import type { DecisionStore } from "./decisions.ts";

export type SupersededBy = "read" | "write" | "edit";

export interface Candidate {
  toolCallId: string;
  tool: string;
  /** The one argument that identifies the target: path / command / pattern / url / query. */
  keyArg: string;
  /** Index of the toolResult message in the message array this was built from. */
  msgIndex: number;
  /** Assistant step (0-based count of assistant messages) that issued the call. */
  step: number;
  /** Assistant steps since the call: 0 = issued by the latest assistant message. */
  turnsAgo: number;
  sizeTokens: number;
  lines: number;
  isError: boolean;
  /** Full text content (joined text blocks). */
  text: string;
  head: string;
  tail: string;
  /** First ~200 chars of the assistant text that followed this result. */
  agentReaction: string;
  /** Within the last `exemptSteps` assistant steps → never a candidate. */
  exempt: boolean;
  /** Set when a later read/write/edit targets the same path. */
  supersededBy?: SupersededBy;
  /** Code-only decision: superseded read outside the exempt window → prune without asking Jev. */
  autoPrune: boolean;
  /** Not exempt, ≥ minTokens, no sticky decision → may be sent to Jev. */
  eligible: boolean;
}

export interface BuildOptions {
  exemptSteps: number;
  minTokens: number;
  /** Already-decided ids (sticky ones are not eligible). Optional for pure analysis. */
  decisions?: Pick<DecisionStore, "isFinal">;
  headChars?: number;
  tailChars?: number;
  reactionChars?: number;
}

export interface Snapshot {
  candidates: Candidate[];
  /** Number of assistant messages in context. */
  steps: number;
  /** Last user message text (≤ 1000 chars) — the task. */
  task: string;
  /** Latest assistant text (≤ 1000 chars) — what the agent is doing now. */
  now: string;
  /** Last message is a user message (new user turn). */
  userTurn: boolean;
}

const KEY_ARG_ORDER: Record<string, string[]> = {
  read: ["path", "file_path"],
  write: ["path", "file_path"],
  edit: ["path", "file_path"],
  ls: ["path"],
  find: ["pattern", "path"],
  grep: ["pattern", "path"],
  bash: ["command"],
  fetch_content: ["url", "urls"],
  web_search: ["query", "queries"],
  get_search_content: ["responseId"],
};

/** Extract the single most identifying argument for a tool call. */
export function keyArgOf(tool: string, args: Record<string, unknown> | undefined): string {
  if (!args) return "";
  const order = KEY_ARG_ORDER[tool] ?? [];
  for (const k of order) {
    const v = args[k];
    if (typeof v === "string" && v.length > 0) return v;
    if (Array.isArray(v) && v.length > 0 && typeof v[0] === "string") return v[0];
  }
  for (const v of Object.values(args)) {
    if (typeof v === "string" && v.length > 0) return v;
  }
  return "";
}

const PATH_TOOLS = new Set(["read", "write", "edit"]);

function textOf(m: ToolResultMessage): string {
  let out = "";
  for (const c of m.content) {
    if (c.type === "text") out += (out ? "\n" : "") + c.text;
    else if (c.type === "image") out += (out ? "\n" : "") + "[image]";
  }
  return out;
}

function assistantText(m: AssistantMessage): string {
  let out = "";
  for (const c of m.content) if (c.type === "text") out += (out ? "\n" : "") + c.text;
  return out;
}

function clip(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n)}…`;
}

function clipTail(s: string, n: number): string {
  return s.length <= n ? s : `…${s.slice(-n)}`;
}

function userText(m: { content: unknown }): string {
  if (typeof m.content === "string") return m.content;
  if (Array.isArray(m.content)) {
    return (m.content as Array<{ type: string; text?: string }>)
      .filter((c) => c.type === "text")
      .map((c) => c.text ?? "")
      .join("\n");
  }
  return "";
}

/** Range key for read supersession: same path + same offset/limit. */
function readRangeKey(args: Record<string, unknown>): string {
  return `${args.offset ?? ""}:${args.limit ?? ""}`;
}

/**
 * Build the candidate snapshot from the current context messages.
 * Pure: never mutates `messages`.
 */
export function buildSnapshot(messages: readonly AgentMessage[], opts: BuildOptions): Snapshot {
  const headChars = opts.headChars ?? 300;
  const tailChars = opts.tailChars ?? 100;
  const reactionChars = opts.reactionChars ?? 200;

  // Pass 1: map toolCallId → { call, step }, count steps, find task/now.
  const calls = new Map<string, { call: ToolCall; step: number; msgIndex: number }>();
  let steps = 0;
  let task = "";
  let now = "";
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]!;
    if (m.role === "assistant") {
      const step = steps++;
      for (const c of m.content) if (c.type === "toolCall") calls.set(c.id, { call: c, step, msgIndex: i });
      const t = assistantText(m);
      if (t) now = t;
    } else if (m.role === "user") {
      task = userText(m);
    }
  }
  const last = messages[messages.length - 1];
  const userTurn = last?.role === "user";

  // Pass 2: candidates.
  const candidates: Candidate[] = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]!;
    if (m.role !== "toolResult") continue;
    const paired = calls.get(m.toolCallId);
    if (!paired) continue; // orphan result — leave alone
    const text = textOf(m);
    const args = (paired.call.arguments ?? {}) as Record<string, unknown>;
    const step = paired.step;
    const turnsAgo = steps - 1 - step;

    // agentReaction: text of the next assistant message after this result.
    let reaction = "";
    for (let j = i + 1; j < messages.length; j++) {
      const n = messages[j]!;
      if (n.role === "assistant") {
        reaction = clip(assistantText(n), reactionChars);
        break;
      }
    }

    const sizeTokens = estimateTokens(m);
    const lines = text.length === 0 ? 0 : text.split("\n").length;
    candidates.push({
      toolCallId: m.toolCallId,
      tool: m.toolName || paired.call.name,
      keyArg: keyArgOf(paired.call.name, args),
      msgIndex: i,
      step,
      turnsAgo,
      sizeTokens,
      lines,
      isError: m.isError,
      text,
      head: clip(text, headChars),
      tail: text.length > headChars ? clipTail(text, tailChars) : "",
      agentReaction: reaction,
      exempt: turnsAgo < opts.exemptSteps,
      autoPrune: false,
      eligible: false,
    });
  }

  // Pass 3: supersession. For each read, is there a later read (same range) / write / edit of the same path?
  const byPath = new Map<string, Candidate[]>();
  for (const c of candidates) {
    if (PATH_TOOLS.has(c.tool) && c.keyArg) {
      const list = byPath.get(c.keyArg) ?? [];
      list.push(c);
      byPath.set(c.keyArg, list);
    }
  }
  for (const list of byPath.values()) {
    list.sort((a, b) => a.msgIndex - b.msgIndex);
    for (let a = 0; a < list.length; a++) {
      const c = list[a]!;
      if (c.tool !== "read") continue;
      const range = readRangeKey(calls.get(c.toolCallId)!.call.arguments as Record<string, unknown>);
      for (let b = a + 1; b < list.length; b++) {
        const later = list[b]!;
        if (later.tool === "read") {
          if (readRangeKey(calls.get(later.toolCallId)!.call.arguments as Record<string, unknown>) === range) {
            c.supersededBy = "read";
            break;
          }
        } else {
          c.supersededBy = later.tool as SupersededBy;
          break;
        }
      }
    }
  }

  // Pass 4: eligibility.
  for (const c of candidates) {
    const final = opts.decisions?.isFinal(c.toolCallId) ?? false;
    if (final || c.exempt) continue;
    if (c.sizeTokens < opts.minTokens) continue;
    if (c.supersededBy) {
      c.autoPrune = true;
      continue;
    }
    c.eligible = true;
  }

  return { candidates, steps, task: clip(task, 1000), now: clip(now, 1000), userTurn };
}
