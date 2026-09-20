/**
 * pi-jev-prune — Jev-driven context pruning for pi.
 *
 * Before each LLM call, decides which completed tool results are stale and replaces their content
 * with a short recoverable stub. Ephemeral (session file untouched), cache-aware (only changes the
 * prefix at "windows"), recoverable (`recall` tool).
 */
import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { TypeSafeClient } from "@typesafe-ai/sdk";
import { loadConfig, type PruneMode } from "./config.ts";
import { type Decision, DecisionStore, ENTRY_TYPE } from "./decisions.ts";
import { Engine, type EngineStatus, type LogRecord } from "./engine.ts";
import { createJevJudge, type Judge } from "./judge.ts";

const REPORT_ENTRY = "jev-prune-report";

function fmtK(n: number): string {
  return n >= 1000 ? `${Math.round(n / 1000)}k` : `${n}`;
}

export function statusLine(s: EngineStatus): string {
  if (s.mode === "off") return "prune: off";
  const tag = s.mode === "dry" ? "prune[dry]" : s.mode === "every-call" ? "prune[every]" : "prune";
  const saved = s.mode === "dry" ? `${fmtK(s.wouldSaveTokens)} would-save` : `${fmtK(s.savedTokens)} saved`;
  const staged = s.stagedTokens > 0 ? ` · ${fmtK(s.stagedTokens)} staged` : "";
  return `${tag}: ${saved}${staged} · ${fmtK(s.pendingTokens)} pending · ${fmtK(s.usedTokens)}/${fmtK(s.budget)}`;
}

export interface JevPruneOptions {
  /** Override the settings.json path (tests). */
  settingsPath?: string;
}

export default function jevPrune(pi: ExtensionAPI, opts: JevPruneOptions = {}): void {
  const config = loadConfig(opts.settingsPath);
  let engine = new Engine({ config, decisions: new DecisionStore() });
  let judge: Judge | undefined;
  let keyWarned = false;
  let logDirReady = false;

  const logLine = (r: LogRecord): void => {
    const line = `${JSON.stringify({ ...r, session: sessionId })}\n`;
    void (async () => {
      try {
        if (!logDirReady) {
          await mkdir(dirname(config.logPath), { recursive: true });
          logDirReady = true;
        }
        await appendFile(config.logPath, line);
      } catch {
        /* logging must never break the agent */
      }
    })();
  };
  let sessionId = "";

  function ensureJudge(ctx: ExtensionContext): Judge | undefined {
    if (judge) return judge;
    if (config.mode === "off") return undefined;
    try {
      const client = new TypeSafeClient({ logLevel: "off" });
      judge = createJevJudge(client, config.model);
      return judge;
    } catch (e) {
      if (!keyWarned) {
        keyWarned = true;
        ctx.ui.notify(
          `jev-prune: ${e instanceof Error ? e.message : String(e)} — running code-only (superseded reads) until TYPESAFE_API_KEY is set.`,
          "warning",
        );
      }
      return undefined;
    }
  }

  function rebuild(ctx: ExtensionContext): void {
    sessionId = ctx.sessionManager.getSessionId();
    const decisions = DecisionStore.fromEntries(ctx.sessionManager.getEntries());
    engine = new Engine({
      config,
      decisions,
      judge: ensureJudge(ctx),
      persist: (d: Decision) => pi.appendEntry(ENTRY_TYPE, d),
      log: logLine,
    });
    updateFooter(ctx);
  }

  function updateFooter(ctx: ExtensionContext): void {
    const s = engine.lastStatus;
    ctx.ui.setStatus("jev-prune", s ? statusLine(s) : config.mode === "off" ? "prune: off" : `prune[${config.mode}]: idle`);
  }

  pi.on("session_start", async (_event, ctx) => {
    rebuild(ctx);
  });

  pi.on("cache_warming_decision", (event) => {
    if (event.action === "warm") engine.lastWarmAt = Date.now();
    else engine.warmingStopped = true;
  });

  pi.on("context", async (event, ctx) => {
    if (config.mode === "off") return undefined;
    try {
      engine.judge = engine.judge ?? ensureJudge(ctx);
      // pi declares prompt-cache lifetimes in seconds (see cache-warmer getPromptCacheTtlMs).
      const ttlSec = ctx.model?.promptCache?.short;
      engine.cacheTtlMs = typeof ttlSec === "number" && ttlSec > 0 ? ttlSec * 1000 : undefined;
      const hint = ctx.getContextUsage()?.tokens ?? undefined;
      const res = await engine.onContext(event.messages, hint);
      updateFooter(ctx);
      return res.changed ? { messages: res.messages } : undefined;
    } catch {
      // Never throw, never block: on any internal error the context goes through unchanged.
      return undefined;
    }
  });

  pi.registerTool({
    name: "recall",
    label: "Recall pruned tool result",
    description:
      "Restore the full original output of a tool result that was replaced by a `[pruned: …]` stub. Pass the toolCallId shown in the stub.",
    parameters: Type.Object({
      toolCallId: Type.String({ description: "The toolCallId from the [pruned: …] stub" }),
    }),
    async execute(toolCallId, params, _signal, _onUpdate, ctx) {
      const id = params.toolCallId.trim();
      for (const entry of ctx.sessionManager.getBranch()) {
        if (entry.type !== "message") continue;
        const m = entry.message;
        if (m.role === "toolResult" && m.toolCallId === id) {
          engine.recall(id, toolCallId);
          return { content: m.content, details: { toolCallId: id, toolName: m.toolName, isError: m.isError } };
        }
      }
      return {
        content: [{ type: "text", text: `recall: no tool result with toolCallId "${id}" in this session branch.` }],
        details: { toolCallId: id },
        isError: true,
      };
    },
  });

  pi.registerEntryRenderer<{ text: string }>(REPORT_ENTRY, (entry, _opts, theme) => {
    return new Text(theme.fg("dim", entry.data?.text ?? ""), 0, 0);
  });

  function report(text: string): void {
    pi.appendEntry(REPORT_ENTRY, { text });
  }

  function statusReport(): string {
    const s = engine.lastStatus;
    const d = engine.decisions;
    const u = engine.judge?.usage;
    const lines = [
      `jev-prune ${statusLine(s ?? emptyStatus())}`,
      `mode=${config.mode} threshold=${config.threshold} minTokens=${config.minTokens} exemptSteps=${config.exemptSteps} budget=${config.budget} minApplyPct=${config.minApplyPct}`,
      `decisions: prune=${d.byVerdict("prune").length} staged=${d.byVerdict("staged").length} keep=${d.byVerdict("keep").length} recall=${d.byVerdict("recall").length} pin=${d.byVerdict("pin").length}`,
      s ? `last window: ${s.window}${s.jev ? ` · jev ${s.jev.judged} judged in ${s.jev.ms}ms (${s.jev.batches} req${s.jev.errors.length ? `, errors: ${s.jev.errors.join("; ")}` : ""})` : ""}` : "no context event yet",
      s
        ? `signals: idle=${s.signals.idleMs < 0 ? "—" : `${Math.round(s.signals.idleMs / 1000)}s`} ttl=${Math.round(s.signals.ttlMs / 1000)}s cold=${s.signals.coldCache} warmingStopped=${s.signals.warmingStopped} usage=${s.signals.usageSource} · now idle=${Math.round(Math.max(0, engine.idleMs()) / 1000)}s`
        : "",
      u ? `jev usage: ${u.requests} req · ${u.input} in / ${u.output} out tokens` : `jev: ${engine.judge ? "ready" : "unavailable (no key)"}`,
      `log: ${config.logPath}`,
    ];
    return lines.join("\n");
  }

  function emptyStatus(): EngineStatus {
    return {
      mode: config.mode,
      usedTokens: 0,
      budget: config.budget,
      savedTokens: 0,
      wouldSaveTokens: 0,
      pendingTokens: 0,
      stagedTokens: 0,
      window: "closed",
      pruned: 0,
      signals: {
        idleMs: -1,
        ttlMs: engine.ttlMs,
        coldCache: false,
        warmingStopped: false,
        userTurn: false,
        forced: false,
        usageSource: "estimate",
      },
    };
  }

  function showReport(): string {
    const rows = engine.decisions
      .all()
      .filter((d) => d.verdict !== "pin")
      .sort((a, b) => (a.at < b.at ? -1 : 1))
      .map(
        (d) =>
          `${d.verdict.padEnd(6)} p=${d.p === undefined ? "  — " : d.p.toFixed(2)} ${String(d.sizeTokens).padStart(6)}tok ${d.tool.padEnd(12)} ${d.keyArg.slice(0, 60)}  [${d.toolCallId}] ${d.reason}`,
      );
    return rows.length ? rows.join("\n") : "no decisions yet";
  }

  pi.registerCommand("prune", {
    description: "jev-prune: status | dry | on | off | now | show",
    getArgumentCompletions: (prefix) =>
      ["status", "dry", "on", "off", "now", "show"].filter((s) => s.startsWith(prefix)).map((s) => ({ value: s, label: s })),
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const sub = args.trim().split(/\s+/)[0] ?? "";
      switch (sub) {
        case "":
        case "status":
          report(statusReport());
          break;
        case "show":
          report(showReport());
          break;
        case "dry":
        case "on":
        case "off": {
          engine.mode = sub as PruneMode;
          if (sub !== "off") engine.judge = ensureJudge(ctx);
          updateFooter(ctx);
          ctx.ui.notify(`jev-prune: mode → ${sub} (this session)`, "info");
          break;
        }
        case "every-call":
          engine.mode = "every-call";
          engine.judge = ensureJudge(ctx);
          updateFooter(ctx);
          ctx.ui.notify("jev-prune: mode → every-call (experiment mode)", "warning");
          break;
        case "now":
          engine.forced = true;
          ctx.ui.notify("jev-prune: window forced for the next LLM call", "info");
          break;
        default:
          ctx.ui.notify("usage: /prune status | dry | on | off | now | show", "warning");
      }
    },
  });
}
