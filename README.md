# pi-jev-prune

Experimental [pi](https://github.com/earendil-works/pi-coding-agent) extension that prunes stale tool results from context using
[TypeSafe's Jev](https://typesafe.ai). Before each LLM call it asks Jev which completed tool outputs the agent won't need again and
replaces them with a recoverable stub:

```
[pruned: read src/resolve.rs — 734 lines/~8k tok. Use recall("toolu_01…") to restore.]
```

Published as a reference implementation. Works, tested, rough edges. Run in `dry` mode first.

- Ephemeral — session file untouched, stubs applied in the `context` hook only.
- Tool results only — never touches user/assistant messages or tool calls.
- Cache-aware — prefix changes only at windows (user turn, budget pressure, cold cache); mid-run prunes are batched into one rewrite.
- Recoverable — `recall(toolCallId)` returns the original verbatim.
- Fails open — any error, timeout, or missing key → context unchanged.

## Results

Full write-up: [`experiments/REPORT.md`](experiments/REPORT.md). Offline replay of 14 sessions + 13 live runs on a small Rust repo (Sonnet 4.5).

- Jev's signal is in the low tail: below p 0.15, 1 of 28 outputs was used later; 0.15–0.30 ≈ 1 in 4, the same as random (24 % base rate). A cutoff of 0.20 is half as wrong as random, 0.35 ≈ random. Default threshold 0.25.
- Live: 0 recalls, 0 hallucinated identifiers in 13 runs. Peak context −15 % on a 3-task session; the benefit compounds across turns.
- Every applied prune is a prompt-cache rewrite. Unbatched it was net-negative in cost; batched it's ≈ break-even. The win is headroom, not money.
- A no-model rule (`read` later superseded by `edit`/`read` of the same file) did much of the useful pruning.
- Jev latency: p50 300 ms, max 1.1 s per 10–30 candidates, 0 timeouts at 2 s.

## Install

```bash
git clone https://github.com/fsmiamoto/pi-jev-prune ~/Code/pi-jev-prune && cd ~/Code/pi-jev-prune && npm install
```

`~/.pi/agent/settings.json`:

```jsonc
{
  "packages": ["/Users/you/Code/pi-jev-prune"],
  "jev-prune": { "mode": "dry" }
}
```

Export `TYPESAFE_API_KEY`. Requires pi ≥ 0.86.

## Config

| key | default | |
|---|---|---|
| `mode` | `"dry"` | `dry` (judge + log, apply nothing) · `on` · `off` · `every-call` (experiment knob, churns cache) |
| `budget` | `100000` | tokens treated as 100 % |
| `threshold` | `0.25` | prune when p(needed again) < threshold. 0.20 conservative, 0.30–0.35 aggressive |
| `minTokens` | `300` | smaller results are never candidates |
| `exemptSteps` | `3` | results from the last N assistant steps are never candidates |
| `pressurePct` | `0.7` | mid-run window when usage ≥ 70 % of budget |
| `pendingPct` | `0.15` | mid-run window when un-judged prunable tokens ≥ 15 % of budget |
| `minApplyPct` | `0.05` | stage mid-run prunes until the batch saves ≥ 5 % of budget |
| `timeoutMs` | `2000` | Jev timeout; skip silently on timeout |

## Usage

- `/prune status` · `/prune show` · `/prune dry|on|off|every-call` · `/prune now` (force a window)
- `recall(toolCallId)` — tool the model calls to restore a pruned output
- Footer: `prune: 12k saved · 3k staged · 4k pending · 56k/100k`
- Decision log: `~/.pi/agent/jev-prune/log.jsonl`

## How it decides

1. Candidates: tool results older than `exemptSteps`, ≥ `minTokens`, no sticky decision yet.
2. Code rule: a `read` followed by a later `read`/`edit`/`write` of the same path → auto-prune.
3. Window check: only consult Jev (and change stubs) at user turn / over budget / pressure / cold cache / big pending backlog. Otherwise
   re-apply previous stubs → byte-identical prefix.
4. Jev: one Noul per candidate over `{ task, now, candidates[{tool, arg, turnsAgo, sizeTokens, head, tail, agentReaction}] }`:
   *"Will the agent need the full output again to finish `task`, given what it is doing `now`?"* → prune if p < `threshold`.
5. Mid-run prunes are staged until they save ≥ `minApplyPct × budget`, then applied together. Decisions are sticky and persisted as
   session entries keyed by `toolCallId`.

## Limitations

- Template stubs, no summaries. If the agent needs it, it calls `recall` (one extra step).
- Jev sees head/tail/reaction only (~600 chars) — good at "obviously irrelevant", not "subtly still needed".
- Small repos with "survey everything, then act" tasks → Jev is conservative and little gets pruned.
- Not integrated with pi's compaction or pi-context (they see un-stubbed messages).

## Development

```bash
npm test            # typecheck + unit tests
npm run test:live   # one real Jev request (needs TYPESAFE_API_KEY)
```

Experiments: `experiments/replay.ts` (replay your own sessions; `JEV_PRUNE_SESSIONS='--Users-me-Code-repo--,…'`,
optional `JEV_PRUNE_EXCLUDE='pattern'`), `experiments/live.ts` (headless A/B on a repo clone), `experiments/analyze.ts`.

Not yet tried: ingest-time chunk filtering of large outputs (no cache cost), apply-only-when-cache-is-cold, a "delegate to subagent" nudge.

MIT
