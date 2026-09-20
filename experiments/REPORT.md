# pi-jev-prune — experiment report

Two experiments on the question *"can Jev tell which completed tool results the agent will still need?"*:

1. **Offline replay** (D6) — 14 recorded pi sessions (allowlisted dirs only), every LLM call rebuilt exactly as pi sent it,
   pipeline run with real Jev, then a threshold sweep with stored p-values. Ground truth via a *citation proxy*.
2. **Live A/B** (D7) — headless `pi -p` (Sonnet 4.5, thinking low) on fresh clones of `~/Code/mansk`, 3 tasks × {off, on, every-call}.

TL;DR

- Jev's p(need-to-re-read) has real signal **in the low tail only**: p < 0.20 is confidently prunable (8–13 % proxy-FP); 0.20–0.40 ≈ coin flip.
  The original default threshold 0.35 prunes 90 % of everything judged and is indistinguishable from random pruning at equal volume.
- **Recommended threshold 0.25** (saves ~half the prunable tokens at 17 % proxy-FP; peak context −22 % across the replayed sessions).
  0.20 is the conservative choice (13 % FP, −13 % peak).
- Jev is fast and deterministic enough for a synchronous hook: p50 ≈ 300 ms, max 1.1 s per request (10–30 candidates), 0 timeouts at 2 s;
  identical candidate+step re-judged across runs → corr 0.98, mean |Δp| 0.015.
- The obvious ground truth ("did the agent re-read it later?") is useless: agents almost never re-read while the content is still in context
  (2 re-reads in 186 judged). The citation proxy (see §1.3) was necessary and is still only a proxy.
- Live A/B (13 runs, 0 recalls, 0 hallucinated identifiers): pruning cut peak context −15 % on a 3-turn session with 4 prefix rewrites
  (`every-call`: same benefit, 8 rewrites, 2.6× the cache writes of `off`). Dollars ≈ break-even — the win is context/longevity, not cost.
  On a small repo Jev is conservative (p 0.48–0.58 vs 0.28 in replay); the code-only superseded-read rule did much of the useful work.

---

## 1. Offline replay (D6)

### 1.1 Setup

- Sessions: three allowlisted dirs under `~/.pi/agent/sessions/` (my dotfiles repo, [ascii-approve](https://github.com/fsmiamoto/ascii-approve), [mansk](https://github.com/fsmiamoto/mansk)),
  filtered to ≥ 8 tool results and ≥ 5k tool tokens, text checked against the exclusion regex before anything left the machine → **14 sessions**
  (10 `.dotfiles`, 3 `ascii-approve`, 0 `mansk`; 552 LLM calls; 530 tool results; 416k tool tokens).
- For each assistant message on the main branch: `buildSessionContext(entries, parentId)` (compaction-aware) → `Engine.onContext` in mode `on`
  (budget 100k, exemptSteps 3, minTokens 300, simulated clock from entry timestamps, hint = none → local estimate).
  Every decision recorded (`experiments/out/<session>.decisions.jsonl`), plus per-candidate outcomes (`<session>.outcomes.json`).
- Jev: `jev-latest`, one Noul per candidate, state = task / now / candidates[{tool, args, turnsAgo, sizeTokens, isError, head, tail, agentReaction}].
  Two real runs (t = 0.35): 186 and 193 candidates judged, 40 / 46 requests, 122k / 152k input tokens. Total Jev spend for this run ≈ 300k tokens (cap 20M).
- Sweep: `--reuse` replays the stored p per (toolCallId, step) so every threshold sees the exact same judgments and window/stickiness dynamics
  (`experiments/out.sweep/<t>/`). Zero Jev cost.

### 1.2 Jev latency / determinism

| metric | value |
|---|---|
| requests | 46 (10–30 candidates each, state ≤ 24k tokens) |
| latency p50 / max | 300 ms / 1077 ms |
| would-be timeouts at 2 s | 0 |
| inter-run agreement (175 identical candidate+step pairs) | mean \|Δp\| 0.015 · p90 0.040 · corr 0.984 · 10 flips @0.35, 2 flips @0.20 |
| cross-step p-range for re-judged candidates | mean 0.10–0.22 → drift is *context-driven* (task/now/turnsAgo change), not sampling noise |

### 1.3 Ground truth: the re-read proxy is useless → citation proxy

Planned proxy: "pruned result whose same path/command was re-read/re-run later" (`rereadLater`, `editLater`).
Result: **2 re-reads + 1 edit among 186 judged**, flat ≈ 2 % at every threshold. Agents don't re-read what is still in their context, so
historical sessions cannot tell us what would have been re-read *had it been pruned*.

Replacement — **novel-token citation**: a candidate is `citedLater` if a later assistant message or tool argument contains an identifier-like token
(has separators/digits/camelCase, ≥ 3 distinct chars) that (a) first appeared in this tool output, (b) was not re-supplied by a later tool result or
user message, and (c) appears in ≤ 2 of the 14 sessions (document-frequency filter — kills "should", "index.ts", "README"). Iterations:
any token ≥ 6 chars → 65 % FP flat; identifier-like → 45 %; + DF filter → a curve appears. This is *the agent visibly used something only that
output contained*; it over-counts (tokens copied earlier into the agent's own text and re-quoted) and under-counts (semantic use without quoting).

Per tool: bash 31/128 cited, read 13/40, web_search 3/9, fetch_content 2/4, get_search_content 0/11, grep 0/1.
Oracle ceiling: cited outputs = 120k tokens, not-cited = 197k → a perfect judge saves 197k (62 %) at 0 FP.

### 1.4 p-distribution (first verdict per candidate, n = 193)

```
p        n   (cited)
0.10-15  28  (0)
0.15-20  30  (15)
0.20-25  32  (21)
0.25-30  37  (20)
0.30-35  14  (30)
0.35-40  13  (10)
0.40-45   8  (10)
0.45-50  13  (1)
0.50-55   6  (8)
0.55-60   6  (2)
0.60-65   5  (2)
0.75-80   1  (1)
```
No candidate ever scored below 0.10 or above 0.80. Mass sits in 0.10–0.30; the cited ones are spread across the middle.
Per tool mean p: bash 0.29, read 0.25, get_search_content 0.21, web_search 0.38, fetch_content 0.51. corr(log size, p) = 0.14 (size barely matters).

### 1.5 Threshold sweep (sticky windows, replayed p)

| t | judged | pruned | saved tok | cited-FP (pruned ∧ cited) | recall (not-cited ∧ pruned) | Σ peak ctx ↓ | FP tok | TP tok |
|---|---|---|---|---|---|---|---|---|
| 0.15 | 192 | 39 | 40k | 8 % | 26 % | 6 % | 1k | 38k |
| 0.20 | 193 | 72 | 94k | 12 % | 44 % | 13 % | 19k | 75k |
| **0.25** | 193 | 109 | 152k | 17 % | 62 % | 22 % | 38k | 113k |
| 0.30 | 193 | 152 | 225k | 22 % | 81 % | 29 % | 73k | 152k |
| 0.35 (old default) | 193 | 174 | 278k | 24 % | 90 % | 35 % | 97k | 180k |
| ≥ 0.40 | 188 | 177 | 281k | 24 % | 94 % | 36 % | 106k | 175k |

Reading:
- Random pruning at equal volume gives 24 % FP everywhere (base rate). At t = 0.35 Jev = 24 % FP → **no better than random**; at t = 0.20
  Jev = 12 % FP vs random 24 % at 63 % of the recall → clear win. AUC(firstP → cited) = 0.57, AUC(lastP) = 0.65: weak overall, but concentrated
  in the tail (nothing below 0.15 was ever cited; 0.15–0.30 has ~50 % of the mass and ~30 % cited).
- FP source at 0.35: 36/41 pruned-and-cited were pruned on their *first* verdict; only 5 through re-judge drift. Stickiness is not the problem,
  the threshold is.
- Per session at t = 0.25: peak context 78k → 62k (ascii-approve), 54k → 39k, 47k → 23k … (13/14 sessions reduced; the one 6-call session unchanged).

### 1.6 Recommendation

**threshold = 0.25** — default changed from 0.35 (see T3.4). Rationale: the knee of the FP curve (8→12→17→22→24 %) is between 0.25 and 0.30;
0.25 keeps ~half the achievable savings with a FP rate well under the base rate, and `recall(toolCallId)` makes a FP a one-step
(~200 tok) fix rather than a task failure. Users who want more aggressive pruning can set 0.30; below 0.20 it hardly ever fires.
`minTokens` stays at 300 (size does not predict need; the floor is only there to keep stubs from costing more than they save).

---

## 2. Live A/B on mansk (D7)

### 2.1 Setup

`experiments/live.ts`: for each (task, mode) a fresh `git clone` of `~/Code/mansk` into `.exp/mansk-<task>-<mode>` and an isolated
agent dir (`PI_CODING_AGENT_DIR`) whose `settings.json` loads only this package with `"jev-prune": {mode, threshold, budget}`.
`pi -p --model anthropic/claude-sonnet-4-5:low --session-dir …` runs the prompt(s); metrics come from the session JSONL
(`usage` per assistant message: input / cacheRead / cacheWrite / output / cost; `peak ctx` = max `contextTokens` reported by pi) and from
`jev-prune.log.jsonl` (judgments, applied prunes, windows). `done` = task-specific check (file written / `git diff` non-empty).
`ids✗` = identifiers named in the produced doc that do not occur in the repo (hallucination check).

Tasks (mansk = small Rust CLI, ~30k tokens of `src/`):
- **arch** — read every file in `src/`, write `ARCHITECTURE.md` (pure read-then-write; 1 assistant turn of reads).
- **errors** — read all of `src/` + two test files, fix the 3 riskiest `unwrap()`s, `cargo check` (read-heavy then edit-heavy; high variance).
- **trace** — explore with grep/find/bash, run one `cargo test`, write `TRACE.md` (many small outputs).
- **multi** — arch → errors → trace as three consecutive user turns in one session (the realistic case: user-turn windows fire between tasks).

### 2.2 Round 1 — single tasks, pre-T3.4 engine (t = 0.25, budget 50k, `staged` batching not yet implemented)

| task | mode | done | wall s | calls | peak ctx | total in | cache wr | $ | prunes | pruned tok | judged | windows |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| arch | off | y | 67 | 5 | 40126 | 125984 | 38999 | 0.23 | 0 | 0 | 0 | — |
| arch | on | y | 70 | 4 | 40680 | 86621 | 39553 | 0.22 | 0 | 0 | 0 | — |
| arch | every-call | y | 65 | 5 | 40114 | 125956 | 38987 | 0.23 | 0 | 0 | 0 | — |
| errors | off | y | 200 | 39 | 68063 | 2163588 | 66936 | 1.01 | 0 | 0 | 0 | — |
| errors | on | y | 276 | 41 | 73130 | 2478589 | **261485** | **1.80** | 4 | 11429 | 609 | over-budget:613 |
| errors | every-call | **n** | 281 | 32 | 66919 | 1730204 | 176976 | 1.30 | 2 | 5501 | 444 | every-call:444 |
| trace | off | y | 151 | 25 | 34269 | 507328 | 33142 | 0.36 | 0 | 0 | 0 | — |
| trace | on | y | 163 | 20 | 40523 | 442486 | 45861 | 0.39 | 1 | 443 | 50 | pending:31 pressure:19 |
| trace | every-call | y | 652¹ | 22 | 36337 | 428692 | 48794 | 0.42 | 3 | 1700 | 122 | every-call:122 |

recalls = 0 in every run; `ids✗` = 0 in every run that produced a doc. ¹ includes a 479 s provider stall (gap between a tool result and the
next assistant message; Jev timeout is 2 s) — not comparable.

Live p-distribution (first verdict per candidate, all `on`/`every-call` runs, n = 81 ids):
```
p        errors-on  errors-ec  trace-on  trace-ec
0.20-25      -          -         1         1
0.25-30      -          -         2         1
0.30-35      -          1         3         1
0.35-40      1          -         1         2
0.40-45      -          1         1         2
0.45-50      2          5         -         1
0.50-55      1          2         1         1
0.55-60      5          2         4         3
0.60-65      1          3         3         3
0.65-70      5          7         3         1
0.70-75      2          2         1         1
0.75-80      3          -         -         1
```
mean 0.45–0.49 (replay: 0.28). Lowest live p's: `tests/get_workflow.rs` 0.23–0.34 (read only for style), `src/targets.rs` 0.23–0.30,
`cargo test … | tail -40` 0.20–0.22. p is stable per id across steps (|Δ| ≲ 0.05 over 10 steps) and decays slowly with turnsAgo
(`github.rs` 0.73 → 0.51 over 10 steps).

What actually got pruned:
- errors/on: 4 prunes, **all `superseded:edit` auto-prunes** (read of `output.rs`/`main.rs`/`github.rs` followed by an edit of the same
  file), 0 by Jev. Each applied on a different call → 4 prefix rewrites → cacheWrite 261k vs 67k (off), **+$0.79**. The 609 judgments are
  ~15 candidates re-judged on *every* call once over budget (old engine used staleness 1 for over-budget) — all `keep`.
- errors/every-call: 2 Jev prunes (`targets.rs`, `tests/get_workflow.rs` at p 0.23); the agent then concluded "no changes needed" and
  wrote nothing (n = 1, the task is high-variance — anecdote, not causal).
- trace/on: 1 Jev prune (443 tok `cargo test` output) → +12k cacheWrite to save 443 tokens.
- trace/every-call: 3 Jev prunes (1.7k tok), each a rewrite.

Reading: on a small repo where the task is "survey everything, then act", **almost every file is a potential target** and Jev says so —
p rarely drops below 0.25, so `on` ≈ `off` in context terms, and the prunes that did fire were net-negative because the pre-T3.4
engine applied each one on its own call (one prefix rewrite per prune). This is what motivated the T3.4 changes: stage mid-run prunes
until the batch saves ≥ `minApplyPct` (5 % of budget), and re-judge over-budget candidates only every `exemptSteps` steps.

### 2.3 Round 2 — `multi` task, T3.4 engine (staging + `exemptSteps` staleness), budget 100k

One session, three user turns (arch → errors → trace). n = 1 per cell; the `errors` turn is high-variance (37–85 tool calls) and dominates
`total in` / `$`, so read those columns as noise and the **peak ctx / rewrites / recalls** columns as signal.

| mode | done | wall s | calls | peak ctx | total in | cache wr | $ | prunes / tok | rewrites | recalls | judged | Jev in | ids✗ |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| off | y | 598 | 80 | 89361 | 5.54M | 204k | 2.74 | 0 | 0 | 0 | 0 | 0 | 0/37 |
| on (t 0.25) | y | 1101¹ | 114 | **75938 (−15 %)** | 7.23M | 380k | 3.93 | 22 / 24.5k | **4** | 0 | 662 | 283k | 0/22 |
| every-call (t 0.25) | y | 543 | 78 | 76543 (−14 %) | 4.19M | 538k | 3.41 | 20 / 39.2k | 8² | 0 | 1216 | 487k | 0/27 |
| on (t 0.35) | y | 531 | 65 | 81129 (−9 %) | 3.68M | 485k | 3.08 | 30 / 46.5k | 6 | 0 | 304 | 126k | 0/22 |

¹ includes 297 + 67 + 62 s provider-side gaps. ² five of them on consecutive calls (steps 48–52) as candidates aged past `exemptSteps` one at a time.

Per user turn (peak ctx / LLM calls / $):

| mode | arch | errors | trace |
|---|---|---|---|
| off | 41k / 5 / 0.24 | 82k / 53 / 1.58 | **90k** / 22 / 0.92 |
| on 0.25 | 42k / 5 / 0.25 | 75.5k / 85 / 2.84 | 77k / 24 / 0.84 |
| every-call | 41k / 4 / 0.22 | 77k / 50 / 2.29 | **47k** / 24 / 0.91 |
| on 0.35 | 40k / 4 / 0.21 | 81k / 37 / 2.09 | 62k / 24 / 0.79 |

Rewrite events, `on` (t 0.25): step 21 `pending` 2 reads (test files) 8.9k · step 53 `pressure` 6 (superseded `main.rs` + 5 `rg` outputs) 5.3k ·
step 78 `pressure` 7 = 6.3k · step 90 `user-turn` 7 = 3.9k. In `on` (t 0.35): 6 events, incl. step 39 = 4 × superseded `read src/github.rs`
promoted together (the agent re-read the file after each edit — the code-only rule catches exactly the edit-loop bloat).

Live first-p per candidate: mean 0.48 (on), 0.56 (every-call), 0.58 (t 0.35); `read` 0.54 vs `bash` 0.40. Pruned at 0.25: test files read for
style, `rg`/`grep` exploration outputs, superseded reads. Pruned additionally at 0.35: whole-file reads at p 0.29–0.34 (`output.rs`, `get.rs`,
`manifest.rs`, `github.rs`). **0 recalls and 0 hallucinated identifiers in every run** — nothing pruned turned out to be needed.

Reading:
- **Staging does what it was built for.** 22 prunes → 4 prefix rewrites; `every-call` needed 8 for the same volume and produced the
  cache-write pathology (538k vs 380k vs 204k off). Equal peak-context benefit, half the cache churn.
- **The benefit compounds across turns.** Turn 1 is identical in all modes (nothing is old enough). Turn 3 starts with turns 1–2 already
  pruned: peak 90k → 47–77k, and it is the only turn that is *cheaper* with pruning in every mode (0.79–0.91 vs 0.92).
  This is the longevity target: the session stays further from compaction the longer it runs.
- **Cost is ~break-even, not a win**, on a 30-minute session. Anthropic pricing: cache write 1.25×, cache read 0.1× base. A rewrite of the
  suffix R costs 1.25 R; a stub saving S tokens saves 0.1 S per later call → break-even after N ≈ 12.5 R/S calls. Step 21 in `on`:
  R ≈ 50k, S ≈ 8.9k → N ≈ 70 — the whole remainder of the session. So mid-run windows pay in *context* terms, not in dollars;
  user-turn windows are not free either (a stub at message k rewrites k..end). `minApplyPct` is the knob that makes R/S tolerable.
- **Threshold 0.35 looked harmless live** (30 prunes, 0 recalls, all tasks done) but n = 1 on a repo where every file gets re-read via edits
  anyway. Not enough to overturn the replay evidence (§1.5: 24 % proxy-FP at 0.35); default stays 0.25, README documents 0.30–0.35 as aggressive.

---

## 3. Learnings and surprises

1. **Jev's signal lives in the low tail.** Below p 0.20 nothing in 193 replayed candidates was ever cited later; 0.20–0.40 is a coin flip;
   above that it is not consulted. A threshold is therefore a *precision* knob, not a calibration: 0.25 buys ~half the achievable savings at
   17 % proxy-FP, 0.35 is indistinguishable from random pruning at equal volume. The state we show Jev (head/tail/reaction, ~600 chars) is
   enough for "obviously irrelevant", not for "subtly still needed".
2. **Live p is much higher than replay p** (0.48–0.58 vs 0.28). Replayed sessions were long, messy real work; the live tasks were "survey
   the whole small repo, then act", where every file is a plausible target. Jev tracks that correctly — p decays with `turnsAgo` and drops
   once the agent has visibly moved on (`github.rs` 0.73 → 0.51 over 10 steps). Expect the extension to do little on small repos and
   more on long, wandering sessions.
3. **"Did it re-read later?" is not usable ground truth.** Agents do not re-read what is still in context (2 re-reads in 186 judged), so
   historical sessions cannot say what *would* have been re-read after a prune. The novel-identifier citation proxy was needed and still
   over-/under-counts; live `recall` counts (0 in 13 runs) are the honest signal, but they need many more runs.
4. **The code-only superseded-read rule did most of the useful pruning in `on` mode** in round 1 and a large share in round 2
   (4 × `read src/github.rs` in one edit loop). Cheap, zero-FP-by-construction, and it targets the dominant bloat pattern.
5. **Every applied prune is a prompt-cache rewrite from that message onward.** The first engine applied one prune per call once over budget
   and re-judged ~15 candidates on every call (609 all-`keep` judgments in one run) — net negative in dollars. Batching (`staged` until
   ≥ `minApplyPct × budget`) and `exemptSteps` staleness fixed both; those two parameters matter more than the threshold for cost.
6. **Jev is fast and stable enough to sit synchronously in the `context` hook**: p50 300 ms, max 1.1 s per request of 10–30 candidates, 0 timeouts
   at 2 s across ~2,500 live judgments; re-judging the same (candidate, step) gives |Δp| 0.015 mean.
7. **Provider latency dwarfs everything else in wall time** (single gaps of 297 s and 479 s between a tool result and the next assistant
   message, in both `off` and pruning runs). Wall-time comparisons across n = 1 runs are meaningless.
8. Surprise: `pi`'s bundled Anthropic models declare `promptCache.short` in **seconds**, not ms — the first cold-cache detector fired on every
   call (`177cf94`). Also `pi -p a b c` sends consecutive user turns, which made the multi-turn experiment trivial.

## 4. What to try next

1. **Ingest-time chunk filtering** (S1 in PLAN) — the biggest remaining lever. Tool outputs > 3k tokens (whole-file reads, long `cargo test`,
   `rg -B2 -A2 …`) are mostly irrelevant *at ingest time*; score line-chunks against the current step with one Jev request, keep relevant +
   head/tail/error regions, `[… N lines omitted — recall("id") for full]`. No cache cost (the result has not been sent yet), no window logic.
   Measure on replay: tokens dropped vs. citation-proxy FP per chunk.
2. **Apply mid-run prunes only when the cache is already cold** (idle > TTL, or pi's `cache_warming_decision` = stop). Then R is free and
   `minApplyPct` can drop to ~0; keep `pressure`/`over-budget` as the forced fallback.
3. **Subagent nudge** (S2) — Noul on `tool_call` for `bash`/`grep`/`find`: "will this produce large exploratory output better delegated?" →
   one-line hint in the tool result. Attacks the source rather than the symptom.
4. **Re-judge back-off**: keep verdicts re-asked at 3, 6, 12 … steps instead of every `exemptSteps`; the live logs show p barely moves between
   consecutive re-judgments (662 judgments for 47 candidates).
5. **Better ground truth**: run N ≥ 5 seeds per (task, mode) with a fixed model to get a `recall`-rate and task-success estimate with error bars;
   add a "poisoned" task where a pruned result *is* needed later, to measure how gracefully `recall` recovers.
6. **Richer Jev state at a fixed cost**: include the *list of files the agent has edited so far* and the *plan/todo text* if present — both are
   strong "moved on" signals that the current `now` (last assistant text) captures only sometimes.
