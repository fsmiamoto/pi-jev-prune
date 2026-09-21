# Configuration and behavior

[Back to README](../README.md)

Experimental; not ready for general use. Start with `dry` mode.

## Settings

Add a `jev-prune` object to pi's `settings.json` (normally `~/.pi/agent/settings.json`).
`PI_CODING_AGENT_DIR` overrides the settings directory, but not the default log path.
Missing or invalid settings fall back to defaults; invalid individual values retain their defaults.
Export `TYPESAFE_API_KEY` before starting pi to enable Jev judgments.

| Key | Default | Meaning |
|---|---|---|
| `mode` | `"dry"` | `dry`: judge/log, no stubs; `on`: apply at windows; `off`: no pruning; `every-call`: experimental judge/apply before every call |
| `budget` | `100000` | Token reference for triggers, not a hard limit; minimum 1000 |
| `threshold` | `0.25` | Prune when Jev's probability of needing the output again is below this; range 0–1 |
| `minTokens` | `300` | Smaller results are never candidates; minimum 0 |
| `exemptSteps` | `3` | Protect results from the last N assistant steps; nonnegative, rounded down |
| `pressurePct` | `0.7` | Open a mid-run window at this fraction of budget usage; range 0–1 |
| `pendingPct` | `0.15` | Open a window when undecided candidate tokens reach this fraction of budget; range 0–1 |
| `minApplyPct` | `0.05` | Stage mid-run prunes until estimated batch savings reach this fraction of budget; range 0–1 |
| `timeoutMs` | `2000` | Jev request timeout; minimum 100 ms |
| `cacheTtlMs` | `300000` | Fallback cache lifetime when the model declares none; minimum 1000 ms |
| `maxStateTokens` | `24000` | Estimated Jev request size used to split candidate batches; range 1000–30000 |
| `model` | `"jev-latest"` | Jev model ID |
| `logPath` | `~/.pi/agent/jev-prune/log.jsonl` | Decision log; the default resolves to your home directory. Use an absolute path for overrides, not literal `~` |

A threshold of `0.20` was more conservative in the [replay experiments](../experiments/REPORT.md); higher thresholds prune more aggressively. These are not calibrated safety guarantees.

## Commands and diagnostics

- `/prune status`: mode, token estimates, decision counts, last window, cache signals, Jev usage/errors, and log path.
- `/prune show`: decisions with probabilities, sizes, targets, IDs, and reasons.
- `/prune dry|on|off|every-call`: runtime mode change; does not write settings. `off` stops applying previous stubs too.
- `/prune now`: force a window on the next LLM call; does not override `off` or make `dry` apply stubs.
- `recall(toolCallId)`: model tool returning the original result content from the current session branch. The old result stays stubbed; the new recall result is pinned against pruning.

Example footer: `prune: 12k saved · 3k staged · 4k pending · 56k/100k`.
`saved` means estimated tokens removed from current context, not money saved; `dry` shows `would-save` instead.
The JSONL log records decisions and whether they were applied.

## How decisions work

1. Candidates are paired tool results at least `minTokens` large and outside the last `exemptSteps` assistant steps, without a final decision. User/assistant messages and tool calls are not replaced.
2. Windows open on a user turn, a forced request, usage over budget or at `pressurePct`, a cold cache (idle beyond its TTL), or a backlog reaching `pendingPct`. `every-call` bypasses this scheduling.
3. At a window, a superseded `read` is selected without Jev: a later `read` of the same path **and offset/limit**, or a later `edit`/`write` of that path. Normal size/age protections still apply.
4. With at least two candidates needing judgment, Jev receives task/current activity and each candidate's tool, argument, age, size, error flag, head/tail, and next assistant reaction. One Noul question per candidate asks whether the full output will be needed again. Probabilities below `threshold` select pruning.
5. Mid-run selections are staged until estimated savings reach `minApplyPct × budget`. User-turn, forced, and `every-call` windows apply selections without that minimum. `dry` records decisions but never applies stubs.
6. Applied prune decisions are sticky; keeps can be reconsidered after more assistant steps. Staged decisions wait for a batch. Sticky decisions are persisted as session entries keyed by `toolCallId`, including decisions made in `dry` mode; switching to `on` can apply them.

Stubs are applied only in the `context` hook, leaving original session messages intact. Decision/report entries are still appended to the session. Existing stubs are reapplied between windows without new pruning rewrites.

## Failures and limitations

- **Missing API key does not disable pruning.** It disables Jev judgments; code-only superseded-read pruning still works in `on`/`every-call`.
- Jev errors/timeouts leave affected candidates unjudged for retry at a later window. Other decisions and existing stubs can still apply. An uncaught internal context-hook error passes that call's context through unchanged.
- Stubs are templates, not summaries. Retrieval requires an extra `recall` tool call and an original result available in the current session branch.
- Jev sees excerpts, not full outputs: up to 300 head characters, 100 tail characters, and 200 reaction characters, plus metadata and task/current activity. Subtle dependencies can be missed.
- Small-repo “survey everything, then act” tasks showed conservative Jev judgments and little pruning; the superseded-read rule did much of the useful work.
- New stubs rewrite the prompt-cache prefix. Batching limits rewrite frequency, but does not guarantee cost savings. `every-call` can cause substantial cache churn.
- Not integrated with pi compaction or pi-context; those see un-stubbed messages.

See the [experiment report](../experiments/REPORT.md) for evidence and measurement limitations.
