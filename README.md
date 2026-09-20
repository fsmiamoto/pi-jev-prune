# pi-jev-prune

> **Experimental.** A working, tested prototype of Jev-driven context pruning for [pi](https://github.com/earendil-works/pi-coding-agent) —
> built in one day, measured on ~14 replayed sessions and 13 live runs. It is published as a **reference implementation** for anyone
> trying to do the same thing (in pi or elsewhere): the design decisions, the cache trade-offs and the experiment harness are the
> interesting parts. Run it in `dry` mode first; expect rough edges.

Before each LLM call, asks [TypeSafe's Jev](https://typesafe.ai) which **completed tool results** the agent will not need to look at again,
and replaces their content with a one-line recoverable stub:

```
[pruned: read src/resolve.rs — 734 lines/~8k tok. Use recall("toolu_01…") to restore.]
```

Goal: less context rot, later compaction. Constraints: prompt-cache friendly, never destructive.

- **Ephemeral** — the session file is untouched; stubs are applied in the `context` hook only.
- **Tool results only** — user messages, assistant text and tool *calls* are never modified or removed.
- **Cache-aware** — the prefix only changes at *windows* (user turn, budget pressure, cold cache, big pending backlog); between windows the
  output is byte-identical call to call. Mid-run prunes are batched into one rewrite. Prunes are sticky.
- **Recoverable** — the `recall(toolCallId)` tool returns the original output verbatim from the session.
- **Fails open** — any error, timeout (2 s) or missing API key → messages pass through unchanged.

## What we learned (full write-up: [`experiments/REPORT.md`](experiments/REPORT.md))

- **Jev's signal is in the low tail.** Over 193 replayed candidates, nothing with p(needs it again) < 0.20 was ever used later;
  0.20–0.40 is a coin flip; a threshold of 0.35 is indistinguishable from random pruning at equal volume. Default threshold **0.25**
  (~half the achievable savings at 17 % proxy false-positives, peak context −22 % across 14 sessions).
- **Live: 13 runs, 0 recalls, 0 hallucinated identifiers.** On a 3-task session peak context dropped 89k → 76k (−15 %) with 4 prompt-cache
  rewrites; the benefit compounds — the third task started with the first two already pruned (90k → 47–77k peak).
- **Every applied prune is a cache rewrite from that message onward.** Applying prunes one at a time was net-negative in dollars
  (one run: cache writes 4×). Batching (`minApplyPct`) and re-judging only every `exemptSteps` fixed it. Cost is now ≈ break-even;
  the win is context headroom, not money.
- **The dumbest rule did much of the work:** a `read` followed by an `edit`/`read` of the same file → the old read is dead. No model needed.
- **"Did the agent re-read it later?" is useless ground truth** — agents don't re-read what is still in context. We used a
  novel-identifier citation proxy offline and `recall` counts live.
- **Jev is fast enough to sit synchronously in the hook:** p50 300 ms, max 1.1 s for 10–30 candidates, 0 timeouts at 2 s, |Δp| 0.015 on re-judge.

Ideas not yet built (§4 of the report): ingest-time chunk filtering of large outputs (no cache cost), apply-only-when-cache-is-cold,
a "delegate this to a subagent" nudge.

## Install

```bash
git clone https://github.com/fsmiamoto/pi-jev-prune ~/Code/pi-jev-prune && cd ~/Code/pi-jev-prune && npm install
```

`~/.pi/agent/settings.json`:

```jsonc
{
  "packages": ["/Users/you/Code/pi-jev-prune"],
  "jev-prune": { "mode": "dry" }          // start in dry mode, see below
}
```

Export `TYPESAFE_API_KEY` in the shell that runs pi. Without it the extension still applies its code-only rules
(superseded reads) and shows one warning.

Requires pi ≥ 0.86 (uses `pi.on("context")`, `ctx.getContextUsage()`, `cache_warming_decision`).

## Modes

| mode | what happens |
|---|---|
| `dry` (default) | Jev runs, verdicts are logged and shown in `/prune show` + footer (`would-save`), nothing is applied. Run a day like this first. |
| `on` | Prunes are applied at windows. |
| `off` | Extension does nothing (`recall` and `/prune` still registered). |
| `every-call` | Experiment knob: judge + apply before **every** LLM call. Churns the prompt cache — never the default. |

## Config (`"jev-prune"` in settings.json)

| key | default | meaning |
|---|---|---|
| `mode` | `"dry"` | see above |
| `budget` | `100000` | tokens you treat as 100 % of context |
| `threshold` | `0.25` | prune when Jev's p(needs to re-read) < threshold. 0.20 = conservative, 0.30–0.35 = aggressive (live runs at 0.35 had 0 recalls, but the offline proxy says ~24 % FP; see `experiments/REPORT.md`) |
| `minTokens` | `300` | smaller results are never candidates |
| `exemptSteps` | `3` | results from the last N assistant steps are never candidates |
| `pressurePct` | `0.7` | mid-run window opens when usage ≥ 70 % of budget |
| `pendingPct` | `0.15` | mid-run window opens when un-judged prunable tokens ≥ 15 % of budget |
| `minApplyPct` | `0.05` | mid-run prunes are *staged* until the batch saves ≥ 5 % of budget, then applied together (one prefix rewrite) |
| `timeoutMs` | `2000` | Jev timeout; on timeout skip silently, retry at the next window |
| `cacheTtlMs` | `300000` | fallback prompt-cache lifetime when the model does not declare one |
| `maxStateTokens` | `24000` | max Jev state per request; larger candidate sets are batched |
| `model` | `"jev-latest"` | Jev model id |
| `logPath` | `~/.pi/agent/jev-prune/log.jsonl` | JSONL decision log |

## Commands and tool

- `/prune` or `/prune status` — mode, thresholds, decision counts, last window reason, cache signals, Jev usage, log path.
- `/prune show` — every decision this session: verdict, p, size, tool, key argument, toolCallId, reason.
- `/prune dry | on | off | every-call` — switch mode for this session.
- `/prune now` — force a window before the next LLM call.
- `recall(toolCallId)` — tool the model calls to get a pruned output back. The recall result itself is pinned (never pruned) and the
  original id is marked *recalled* so it is not pruned again.

Footer status: `prune: 12k saved · 3k staged · 4k pending · 56k/100k` (`prune[dry]: 12k would-save …` in dry mode).

## How it decides

1. **Candidates** — every `toolResult` in the context that is paired with an assistant tool call, is older than `exemptSteps` assistant steps,
   is ≥ `minTokens`, and has no sticky decision yet.
2. **Code-only rules** (no Jev) — a `read` that was followed by a later `read`/`edit`/`write` of the same path is pruned automatically.
3. **Window** — Jev is only consulted (and stubs only change) when the last message is a new user message, usage > budget, usage ≥ `pressurePct`,
   the prompt cache is believed cold (idle past the model's TTL, or pi stopped cache warming), or pending prunable tokens ≥ `pendingPct`.
   Otherwise the previously applied stubs are re-applied unchanged (byte-identical prefix).
4. **Judgment** — one Noul per candidate over the state
   `{ task: last user msg, now: latest assistant text, candidates[{tool, arg, turnsAgo, sizeTokens, isError, head, tail, agentReaction}] }`:
   *"Will the agent need to look at the full output of this tool result again to finish `task`, given what it is doing `now`?"*
   → `prune` if p < `threshold`, else `keep`. Keeps are re-asked after `exemptSteps` more steps; prunes are sticky.
   Skipped when fewer than 2 candidates are eligible (one Noul is not worth a round-trip).
   **Staging** — at mid-run windows a prune verdict (Jev or superseded-read) is only *staged*: nothing changes in the prompt until
   staged prunes together save ≥ `minApplyPct × budget`, then all are applied in one window. Each applied stub invalidates the prompt
   cache from that message onward, so applying one small prune at a time costs more (cache re-write) than it saves. User-turn windows
   (and `/prune now`, `every-call`) flush staged prunes immediately — the cache is being rewritten anyway.
5. **Stub** — template only (no generated summary, so identical input → identical bytes). Decisions are persisted as `jev-prune` custom session
   entries keyed by `toolCallId` and rebuilt on `session_start`, so a resumed session keeps its prunes.

Every decision is appended to `logPath` as JSON: tool, key arg, size, turnsAgo, p, verdict, applied, window reason, window signals, session id.

## Limitations

- Only tool results are pruned. Long assistant messages, user pastes and system prompts are out of scope.
- The stub is a template, not a summary; if the agent needs the content it must `recall` it (one extra step, ~200 tokens).
- Jev sees only a compact view (head ≈ 300 chars, tail ≈ 100, the agent's reaction ≈ 200) — it judges *relevance to the task*, not content
  in detail. In the offline replay p < 0.20 was very reliable, 0.20–0.40 ≈ coin flip (`experiments/REPORT.md`).
- Mid-run windows are inherently a trade-off with the prompt cache: every window that applies a new stub invalidates the cache from that
  message onward. Defaults keep windows rare; `every-call` shows the other extreme.
- Usage numbers come from pi's last reported usage when available, otherwise a local estimate (`estimateTokens`).
- No integration with pi-context or pi's native compaction; both can run alongside (compaction sees the original, un-stubbed messages).
- Tested with pi 0.86.x and Anthropic models; the `promptCache` TTL is read from the model definition (seconds).

## Development

```bash
npm test            # typecheck + unit tests (node --test)
npm run test:live   # one real Jev request (needs TYPESAFE_API_KEY)
npm run smoke       # scripts/smoke.ts
```

Experiments (results in `experiments/REPORT.md`):

- `experiments/replay.ts` — offline replay of your own recorded pi sessions through the real pipeline, threshold sweep, citation-proxy FP.
  Reads only the session dirs you allowlist: `JEV_PRUNE_SESSIONS='--Users-me-Code-repo--,…'`; skip anything matching
  `JEV_PRUNE_EXCLUDE='pattern'` before it is sent anywhere. Has a hard Jev spend cap.
- `experiments/live.ts` — headless `pi -p` A/B on fresh clones of a repo (edit `TASKS` / the repo path), isolated agent dir per run,
  usage + prune metrics from the session file. `--report-only` re-analyzes stored runs.
- `experiments/analyze.ts` — p-histograms, per-tool stats, sweep tables from replay output.

## Status / contributing

This is a prototype I use in `dry` mode; PRs and issues welcome, especially: results on other repos/models, ingest-time filtering,
alternative judges (a small local model would be an obvious comparison). No stability guarantees between versions yet.
