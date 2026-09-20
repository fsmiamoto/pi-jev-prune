import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import jevPrune, { statusLine } from "../src/index.ts";
import { assistant, big, step, textOf, user } from "./fixtures.ts";

/** Minimal fake of pi's ExtensionAPI capturing handlers, tools, commands, entries. */
function fakePi(settings: Record<string, unknown>) {
  const dir = mkdtempSync(join(tmpdir(), "jev-prune-idx-"));
  const settingsPath = join(dir, "settings.json");
  // Always redirect the JSONL log into the temp dir so tests never touch ~/.pi/agent/jev-prune/log.jsonl.
  const jp = { logPath: join(dir, "log.jsonl"), ...((settings["jev-prune"] as Record<string, unknown> | undefined) ?? {}) };
  writeFileSync(settingsPath, JSON.stringify({ ...settings, "jev-prune": jp }));
  const handlers = new Map<string, Function>();
  const tools = new Map<string, any>();
  const commands = new Map<string, any>();
  const entries: Array<{ type: string; customType: string; data: unknown }> = [];
  const notices: string[] = [];
  const statuses: Array<[string, string | undefined]> = [];
  const renderers = new Map<string, Function>();
  const branch: any[] = [];
  const pi = {
    on: (ev: string, h: Function) => {
      handlers.set(ev, h);
      return () => {};
    },
    registerTool: (t: any) => tools.set(t.name, t),
    registerCommand: (name: string, c: any) => commands.set(name, c),
    registerEntryRenderer: (t: string, r: Function) => renderers.set(t, r),
    appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data }),
  };
  const ctx = {
    sessionManager: {
      getSessionId: () => "sess-1",
      getEntries: () => entries,
      getBranch: () => branch,
    },
    ui: {
      notify: (m: string) => notices.push(m),
      setStatus: (k: string, t: string | undefined) => statuses.push([k, t]),
    },
    getContextUsage: () => ({ tokens: 12_345, contextWindow: 200_000, percent: 6 }),
    // pi declares cache lifetimes in seconds
    model: { promptCache: { short: 300 } },
  };
  return { pi, ctx, handlers, tools, commands, entries, notices, statuses, renderers, branch, settingsPath, dir };
}

const NO_KEY = { TYPESAFE_API_KEY: undefined as string | undefined };

function withoutKey<T>(fn: () => T): T {
  NO_KEY.TYPESAFE_API_KEY = process.env.TYPESAFE_API_KEY;
  delete process.env.TYPESAFE_API_KEY;
  try {
    return fn();
  } finally {
    if (NO_KEY.TYPESAFE_API_KEY !== undefined) process.env.TYPESAFE_API_KEY = NO_KEY.TYPESAFE_API_KEY;
  }
}

test("registers context/session_start/cache handlers, recall tool, /prune command", () => {
  const f = fakePi({});
  jevPrune(f.pi as any, { settingsPath: f.settingsPath });
  for (const ev of ["session_start", "cache_warming_decision", "context"]) assert.ok(f.handlers.has(ev), ev);
  assert.ok(f.tools.has("recall"));
  assert.ok(f.commands.has("prune"));
  assert.ok(f.renderers.has("jev-prune-report"));
});

test("no API key: one warning, code-only mode, context handler still works and never throws", async () => {
  await withoutKey(async () => {
    const f = fakePi({ "jev-prune": { mode: "on" } });
    jevPrune(f.pi as any, { settingsPath: f.settingsPath });
    await f.handlers.get("session_start")!({ type: "session_start" }, f.ctx);
    assert.equal(f.notices.filter((n) => n.includes("TYPESAFE_API_KEY")).length <= 1, true);
    const messages = [user("hi"), ...step("read", { id: "c1", name: "read", args: { path: "a" } }, big(600)), assistant("ok"), user("more")];
    const r = await f.handlers.get("context")!({ type: "context", messages }, f.ctx);
    assert.ok(r === undefined || Array.isArray(r.messages));
    // Second call must not warn again.
    await f.handlers.get("context")!({ type: "context", messages }, f.ctx);
    assert.ok(f.notices.filter((n) => n.includes("TYPESAFE_API_KEY")).length <= 1);
  });
});

test("context handler never throws on garbage input (returns undefined → context unchanged)", async () => {
  const f = fakePi({});
  jevPrune(f.pi as any, { settingsPath: f.settingsPath });
  await f.handlers.get("session_start")!({ type: "session_start" }, f.ctx);
  const h = f.handlers.get("context")!;
  assert.equal(await h({ type: "context", messages: null }, f.ctx), undefined);
  assert.equal(await h({ type: "context", messages: [{ role: "toolResult" }] }, f.ctx), undefined);
  assert.equal(await h({ type: "context", messages: [{ role: "assistant", content: null }] }, f.ctx), undefined);
  assert.equal(await h({ type: "context", messages: [] }, { ...f.ctx, getContextUsage: () => { throw new Error("boom"); } }), undefined);
});

test("recall tool returns the original content from the session branch and appends a recall entry", async () => {
  const f = fakePi({});
  jevPrune(f.pi as any, { settingsPath: f.settingsPath });
  await f.handlers.get("session_start")!({ type: "session_start" }, f.ctx);
  const original = step("read", { id: "call_x", name: "read", args: { path: "a.ts" } }, big(600));
  f.branch.push({ type: "message", message: original[0] }, { type: "message", message: original[1] });
  const tool = f.tools.get("recall");
  const res = await tool.execute("recall_1", { toolCallId: " call_x " }, undefined, undefined, f.ctx);
  assert.equal(res.isError, undefined);
  assert.equal(res.content[0].text, textOf(original[1]!));
  assert.equal(res.details.toolName, "read");
  assert.ok(f.entries.some((e) => e.customType === "jev-prune" && (e.data as any).verdict === "recall" && (e.data as any).toolCallId === "call_x"));
  assert.ok(f.entries.some((e) => e.customType === "jev-prune" && (e.data as any).verdict === "pin" && (e.data as any).toolCallId === "recall_1"));
  const miss = await tool.execute("recall_2", { toolCallId: "nope" }, undefined, undefined, f.ctx);
  assert.equal(miss.isError, true);
});

test("/prune status|show|now|dry|on|off|bogus", async () => {
  const f = fakePi({});
  jevPrune(f.pi as any, { settingsPath: f.settingsPath });
  await f.handlers.get("session_start")!({ type: "session_start" }, f.ctx);
  const cmd = f.commands.get("prune");
  assert.ok(cmd.description.includes("status"));
  assert.deepEqual(
    cmd.getArgumentCompletions("s").map((c: any) => c.value),
    ["status", "show"],
  );
  await cmd.handler("status", f.ctx);
  const report = f.entries.find((e) => e.customType === "jev-prune-report")!;
  assert.ok((report.data as any).text.startsWith("jev-prune prune"));
  await cmd.handler("show", f.ctx);
  assert.ok(f.entries.some((e) => e.customType === "jev-prune-report" && (e.data as any).text === "no decisions yet"));
  await cmd.handler("now", f.ctx);
  assert.ok(f.notices.at(-1)!.includes("forced"));
  await cmd.handler("on", f.ctx);
  assert.ok(f.notices.at(-1)!.includes("mode → on"));
  assert.ok(f.statuses.at(-1)![1]!.startsWith("prune"));
  await cmd.handler("off", f.ctx);
  assert.equal(f.statuses.at(-1)![1], "prune: off");
  await cmd.handler("bogus", f.ctx);
  assert.ok(f.notices.at(-1)!.startsWith("usage:"));
  // Renderer produces a component for a report entry.
  const r = f.renderers.get("jev-prune-report")!;
  assert.ok(r({ data: { text: "x" } }, {}, { fg: (_c: string, s: string) => s }));
});

test("statusLine formats per mode", () => {
  const signals = { idleMs: 1000, ttlMs: 300_000, coldCache: false, warmingStopped: false, userTurn: false, forced: false, usageSource: "hint" as const };
  const base = { usedTokens: 42_000, budget: 100_000, savedTokens: 8_000, wouldSaveTokens: 9_500, pendingTokens: 3_000, stagedTokens: 0, window: "closed" as const, pruned: 3, signals };
  assert.equal(statusLine({ ...base, mode: "off" }), "prune: off");
  assert.equal(statusLine({ ...base, mode: "on" }), "prune: 8k saved · 3k pending · 42k/100k");
  assert.equal(statusLine({ ...base, mode: "on", stagedTokens: 2_000 }), "prune: 8k saved · 2k staged · 3k pending · 42k/100k");
  assert.equal(statusLine({ ...base, mode: "dry" }), "prune[dry]: 10k would-save · 3k pending · 42k/100k");
  assert.equal(statusLine({ ...base, mode: "every-call" }), "prune[every]: 8k saved · 3k pending · 42k/100k");
});

test("regression: model.promptCache.short is in seconds → no cold-cache window seconds after the previous call", async () => {
  await withoutKey(async () => {
    const f = fakePi({ "jev-prune": { mode: "on" } });
    jevPrune(f.pi as any, { settingsPath: f.settingsPath });
    await f.handlers.get("session_start")!({ type: "session_start" }, f.ctx);
    const h = f.handlers.get("context")!;
    // pi's bundled anthropic models declare promptCache: { short: 300, long: 3600 } (seconds).
    const ctx = { ...f.ctx, model: { promptCache: { short: 300 } }, getContextUsage: () => ({ tokens: 20_000, contextWindow: 200_000, percent: 10 }) };
    const msgs = [user("task"), ...step("a", { id: "c1", name: "read", args: { path: "a" } }, big(600))];
    for (let i = 0; i < 6; i++) msgs.push(...step(`s${i}`, { id: `c${i + 2}`, name: "read", args: { path: `p${i}` } }, big(600)));
    await h({ type: "context", messages: msgs }, ctx);
    // Simulate ~1.5 s between LLM calls (well under 300 s, but over 300 ms).
    await new Promise((r) => setTimeout(r, 400));
    const st = f.statuses.at(-1)![1]!;
    assert.ok(!st.includes("cold"), st);
    // Directly inspect the engine's last status through /prune status report entry.
    await f.commands.get("prune")!.handler("status", f.ctx);
    const rep = String((f.entries.at(-1)!.data as any).text);
    assert.match(rep, /ttl=300s/);
    assert.match(rep, /cold=false/);
    await h({ type: "context", messages: msgs }, ctx);
    await f.commands.get("prune")!.handler("status", f.ctx);
    const rep2 = String((f.entries.at(-1)!.data as any).text);
    assert.doesNotMatch(rep2, /last window: cold-cache/);
    assert.match(rep2, /ttl=300s/);
  });
});
