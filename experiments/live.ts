/**
 * Live A/B (D7): run headless pi (`pi -p`) on a fresh clone of ~/Code/mansk under jev-prune modes off / on / every-call.
 *
 * Isolation: each run gets its own PI_CODING_AGENT_DIR (only this extension loaded, compaction off, auth symlinked),
 * its own clone (tasks may edit files) and its own --session-dir (exactly one session file to parse).
 * Never touches ~/Code/mansk itself. Rust builds share CARGO_TARGET_DIR under .exp/.
 *
 * Usage: TYPESAFE_API_KEY=… node --experimental-strip-types experiments/live.ts [--modes off,on,every-call]
 *          [--tasks arch,errors] [--model anthropic/claude-sonnet-4-5:low] [--threshold 0.25] [--budget 50000]
 *          [--out experiments/out/live] [--report-only]
 *
 * `--budget` defaults to 50k (not the 100k production default): mansk is small (~30k tokens of src), so a 100k budget
 * would never open a mid-run window and `on` would equal `off`. 50k keeps the repo/budget ratio close to a real repo at 100k.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const REPO = resolve(import.meta.dirname, "..");
const MANSK = join(homedir(), "Code", "mansk");
const EXP = join(REPO, ".exp");

export interface Task {
  prompt: string;
  /** Extra prompts sent as separate user turns after the first one (`pi -p a b c`) — exercises the user-turn window. */
  followUps?: string[];
  check: (dir: string) => boolean;
}

export const TASKS: Record<string, Task> = {
  arch: {
    prompt: [
      "Read every file in src/ (one `read` call per file, whole file, no offsets). Then write ARCHITECTURE.md at the repo root",
      "describing: (1) how skills.toml is parsed and validated — name the exact structs and functions; (2) every CLI subcommand and its",
      "flags as defined in main.rs; (3) how resolve.rs and get.rs use github.rs — exact function names and what each returns.",
      "Do not guess names: use the identifiers exactly as they appear in the files you read. Finish by printing the file's section headers.",
    ].join(" "),
    check: (dir) => existsSync(join(dir, "ARCHITECTURE.md")) && readFileSync(join(dir, "ARCHITECTURE.md"), "utf8").length > 1500,
  },
  errors: {
    prompt: [
      "Explore the codebase: read every file in src/ fully (one `read` per file), then read tests/get_workflow.rs and tests/git_workflow.rs.",
      "Find `unwrap()`/`expect()` calls in src/ that can panic on user-controlled input (manifest, CLI args, network, filesystem).",
      "Fix the 3 riskiest by propagating errors in the style the codebase already uses (look at how other functions return errors).",
      "Run `cargo check` to confirm it compiles. Finish with a list of the changes as file:line — before/after, one line each.",
    ].join(" "),
    check: (dir) => spawnSync("git", ["diff", "--quiet"], { cwd: dir }).status === 1,
  },
  trace: {
    prompt: [
      "Trace how `mansk get <owner/repo>` works end to end. Explore with grep/find/bash first (find the subcommand, then follow every function it calls),",
      "read the relevant files or sections as needed, and also run `cargo test --test get_workflow 2>&1 | tail -40` once to see the workflow tests.",
      "Then write TRACE.md at the repo root: the ordered call chain as `file.rs:function_name` entries, one line each with what it does,",
      "plus a section on how errors are surfaced to the user. Use identifiers exactly as they appear in the code. Finish by printing the call chain.",
    ].join(" "),
    check: (dir) => existsSync(join(dir, "TRACE.md")) && readFileSync(join(dir, "TRACE.md"), "utf8").length > 1000,
  },
};
/** Multi-turn: the three tasks above as consecutive user turns in one session (realistic; user-turn windows fire between them). */
TASKS.multi = {
  prompt: TASKS.arch!.prompt,
  followUps: [TASKS.errors!.prompt, TASKS.trace!.prompt],
  check: (dir) => TASKS.arch!.check(dir) && TASKS.errors!.check(dir) && TASKS.trace!.check(dir),
};

interface Args {
  modes: string[];
  tasks: string[];
  model: string;
  threshold: number;
  budget: number;
  out: string;
  reportOnly: boolean;
}

function parseArgs(argv: string[]): Args {
  const a: Args = {
    modes: ["off", "on", "every-call"],
    tasks: ["arch", "errors", "trace"],
    model: "anthropic/claude-sonnet-4-5:low",
    threshold: 0.25,
    budget: 50_000,
    out: "experiments/out/live",
    reportOnly: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i]!;
    const v = argv[i + 1];
    if (k === "--modes") a.modes = v!.split(","), i++;
    else if (k === "--tasks") a.tasks = v!.split(","), i++;
    else if (k === "--model") a.model = v!, i++;
    else if (k === "--threshold") a.threshold = Number(v), i++;
    else if (k === "--budget") a.budget = Number(v), i++;
    else if (k === "--out") a.out = v!, i++;
    else if (k === "--report-only") a.reportOnly = true;
  }
  return a;
}

export interface RunResult {
  mode: string;
  task: string;
  model: string;
  threshold: number;
  budget: number;
  wallMs: number;
  exitCode: number | null;
  llmCalls: number;
  toolCalls: number;
  toolCallsByName: Record<string, number>;
  recalls: number;
  prunesApplied: number;
  /** Sum of sizeTokens over distinct applied stubs (upper bound of per-call context saved once all are in place). */
  prunedTokens: number;
  jevJudged: number;
  /** Cumulative Jev input tokens over the run (from the last log record). */
  jevInputTokens: number;
  windows: Record<string, number>;
  peakContextTokens: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  uncachedInputTokens: number;
  cost: number;
  completed: boolean;
  finalText: string;
  /** Backticked identifiers in the written docs (ARCHITECTURE.md / TRACE.md) that do not occur anywhere in the repo source = hallucinations. */
  identifiers?: { total: number; missing: string[] };
}

/** Grounding check: every `identifier` mentioned in the produced markdown must exist somewhere in src/ or tests/. */
export function identifierCheck(dir: string, files = ["ARCHITECTURE.md", "TRACE.md"]): { total: number; missing: string[] } | undefined {
  const present = files.filter((f) => existsSync(join(dir, f)));
  if (present.length === 0) return undefined;
  const src = readdirSync(join(dir, "src")).map((f) => readFileSync(join(dir, "src", f), "utf8")).join("\n")
    + readdirSync(join(dir, "tests")).map((f) => readFileSync(join(dir, "tests", f), "utf8")).join("\n")
    + readFileSync(join(dir, "Cargo.toml"), "utf8");
  const ids = new Set<string>();
  for (const f of present)
    for (const m of readFileSync(join(dir, f), "utf8").matchAll(/`([A-Za-z_][\w:]*)(?:\(\))?`/g)) {
      const id = m[1]!;
      if (id.length < 3) continue;
      ids.add(id);
    }
  const missing: string[] = [];
  for (const id of ids) {
    const seg = id.split("::").pop()!;
    if (!src.includes(seg)) missing.push(id);
  }
  return { total: ids.size, missing };
}

/** `provider/model-id:thinking` → parts (provider defaults to anthropic, thinking to low). */
export function parseModel(spec: string): { provider: string; modelId: string; thinking: string } {
  const [idPart, thinking = "low"] = spec.split(":");
  const slash = idPart!.indexOf("/");
  return slash === -1
    ? { provider: "anthropic", modelId: idPart!, thinking }
    : { provider: idPart!.slice(0, slash), modelId: idPart!.slice(slash + 1), thinking };
}

function agentDirFor(runDir: string, mode: string, threshold: number, budget: number, model: string): string {
  const dir = join(runDir, "agent");
  mkdirSync(dir, { recursive: true });
  const m = parseModel(model);
  writeFileSync(
    join(dir, "settings.json"),
    JSON.stringify(
      {
        defaultProvider: m.provider,
        defaultModel: m.modelId,
        defaultThinkingLevel: m.thinking,
        compaction: { enabled: false },
        quietStartup: true,
        packages: [REPO],
        "jev-prune": { mode, threshold, budget, logPath: join(runDir, "jev-prune.log.jsonl") },
      },
      null,
      2,
    ),
  );
  for (const f of ["auth.json", "trust.json"]) {
    const src = join(homedir(), ".pi", "agent", f);
    if (existsSync(src) && !existsSync(join(dir, f))) symlinkSync(src, join(dir, f));
  }
  return dir;
}

export function analyzeSession(
  runDir: string,
  extra: Pick<RunResult, "mode" | "task" | "model" | "threshold" | "budget" | "wallMs" | "exitCode" | "completed">,
): RunResult {
  const sessDir = join(runDir, "sessions");
  const files = existsSync(sessDir) ? readdirSync(sessDir).filter((f) => f.endsWith(".jsonl")) : [];
  const r: RunResult = {
    ...extra,
    llmCalls: 0,
    toolCalls: 0,
    toolCallsByName: {},
    recalls: 0,
    prunesApplied: 0,
    prunedTokens: 0,
    jevJudged: 0,
    jevInputTokens: 0,
    windows: {},
    peakContextTokens: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    uncachedInputTokens: 0,
    cost: 0,
    finalText: "",
  };
  for (const f of files) {
    for (const line of readFileSync(join(sessDir, f), "utf8").split("\n")) {
      if (!line) continue;
      let e: any;
      try {
        e = JSON.parse(line);
      } catch {
        continue;
      }
      if (e.type === "message" && e.message?.role === "assistant") {
        const u = e.message.usage ?? {};
        const ctx = (u.input ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0);
        r.llmCalls++;
        r.peakContextTokens = Math.max(r.peakContextTokens, ctx);
        r.totalInputTokens += ctx;
        r.uncachedInputTokens += u.input ?? 0;
        r.totalOutputTokens += u.output ?? 0;
        r.cacheReadTokens += u.cacheRead ?? 0;
        r.cacheWriteTokens += u.cacheWrite ?? 0;
        r.cost += u.cost?.total ?? 0;
        for (const c of e.message.content ?? []) {
          if (c.type === "toolCall") {
            r.toolCalls++;
            r.toolCallsByName[c.name] = (r.toolCallsByName[c.name] ?? 0) + 1;
            if (c.name === "recall") r.recalls++;
          } else if (c.type === "text" && c.text.trim()) r.finalText = c.text.trim().slice(0, 600);
        }
      }
    }
  }
  // Applied prunes come from the decision log (custom session entries carry the verdict but not whether it was applied).
  const log = join(runDir, "jev-prune.log.jsonl");
  const applied = new Map<string, number>();
  if (existsSync(log))
    for (const line of readFileSync(log, "utf8").split("\n")) {
      if (!line) continue;
      try {
        const d = JSON.parse(line);
        if (d.p !== undefined && !d.promoted) r.jevJudged++;
        if (typeof d.jevIn === "number") r.jevInputTokens = Math.max(r.jevInputTokens, d.jevIn);
        if (d.window) r.windows[d.window] = (r.windows[d.window] ?? 0) + 1;
        if (d.applied === true && d.verdict === "prune") applied.set(d.toolCallId, d.sizeTokens ?? 0);
      } catch {}
    }
  r.prunesApplied = applied.size;
  r.prunedTokens = [...applied.values()].reduce((a, b) => a + b, 0);
  return r;
}

async function runOne(args: Args, mode: string, task: string): Promise<RunResult> {
  const runDir = resolve(args.out, `${task}-${mode}`);
  rmSync(runDir, { recursive: true, force: true });
  mkdirSync(runDir, { recursive: true });
  const work = join(EXP, `mansk-${task}-${mode}`);
  rmSync(work, { recursive: true, force: true });
  execFileSync("git", ["clone", "-q", MANSK, work]);
  const agent = agentDirFor(runDir, mode, args.threshold, args.budget, args.model);
  const sessDir = join(runDir, "sessions");
  mkdirSync(sessDir, { recursive: true });
  const t0 = Date.now();
  const t = TASKS[task]!;
  const res = spawnSync("pi", ["-p", "--model", args.model, "--session-dir", sessDir, t.prompt, ...(t.followUps ?? [])], {
    cwd: work,
    env: { ...process.env, PI_CODING_AGENT_DIR: agent, CARGO_TARGET_DIR: join(EXP, "cargo-target"), NO_COLOR: "1" },
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    timeout: 25 * 60_000,
  });
  const wallMs = Date.now() - t0;
  writeFileSync(join(runDir, "stdout.txt"), res.stdout ?? "");
  writeFileSync(join(runDir, "stderr.txt"), res.stderr ?? "");
  const completed = t.check(work);
  const r = analyzeSession(runDir, { mode, task, model: args.model, threshold: args.threshold, budget: args.budget, wallMs, exitCode: res.status, completed });
  r.identifiers = identifierCheck(work);
  writeFileSync(join(runDir, "result.json"), JSON.stringify(r, null, 2));
  return r;
}

export function table(results: RunResult[]): string {
  const cols = ["task", "mode", "done", "wall s", "calls", "tools", "peak ctx", "total in", "uncached", "cache rd", "cache wr", "out", "$", "prunes", "pruned tok", "recalls", "judged", "jev in", "ids✗", "windows"];
  const rows = results.map((r) => [
    r.task,
    r.mode,
    r.completed ? "y" : "n",
    (r.wallMs / 1000).toFixed(0),
    r.llmCalls,
    r.toolCalls,
    r.peakContextTokens,
    r.totalInputTokens,
    r.uncachedInputTokens,
    r.cacheReadTokens,
    r.cacheWriteTokens,
    r.totalOutputTokens,
    r.cost.toFixed(2),
    r.prunesApplied,
    r.prunedTokens,
    r.recalls,
    r.jevJudged,
    r.jevInputTokens,
    r.identifiers ? `${r.identifiers.missing.length}/${r.identifiers.total}` : "",
    Object.entries(r.windows)
      .filter(([k]) => k !== "closed")
      .map(([k, v]) => `${k}:${v}`)
      .join(" "),
  ]);
  const w = cols.map((c, i) => Math.max(c.length, ...rows.map((r) => String(r[i]).length)));
  const line = (cells: unknown[]) => "| " + cells.map((c, i) => String(c).padEnd(w[i]!)).join(" | ") + " |";
  return [line(cols), "|" + w.map((n) => "-".repeat(n + 2)).join("|") + "|", ...rows.map(line)].join("\n");
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  mkdirSync(args.out, { recursive: true });
  const results: RunResult[] = [];
  if (args.reportOnly) {
    for (const d of readdirSync(args.out)) {
      const f = join(args.out, d, "result.json");
      if (!existsSync(f)) continue;
      const prev: RunResult = JSON.parse(readFileSync(f, "utf8"));
      // Re-analyze from the stored session + log so metric fixes apply retroactively; keep run-level facts (wall, exit, completed).
      const r = analyzeSession(join(args.out, d), {
        mode: prev.mode,
        task: prev.task,
        model: prev.model,
        threshold: prev.threshold,
        budget: prev.budget,
        wallMs: prev.wallMs,
        exitCode: prev.exitCode,
        completed: prev.completed,
      });
      const work = join(EXP, `mansk-${r.task}-${r.mode}`);
      r.identifiers = existsSync(work) ? identifierCheck(work) : prev.identifiers;
      writeFileSync(f, JSON.stringify(r, null, 2));
      results.push(r);
    }
  } else {
    if (!process.env.TYPESAFE_API_KEY) throw new Error("TYPESAFE_API_KEY not set");
    for (const task of args.tasks)
      for (const mode of args.modes) {
        console.log(`\n▶ ${task} / ${mode}`);
        const r = await runOne(args, mode, task);
        results.push(r);
        console.log(table([r]));
        console.log(`  final: ${r.finalText.replace(/\s+/g, " ").slice(0, 200)}`);
      }
  }
  results.sort((a, b) => a.task.localeCompare(b.task) || ["off", "on", "every-call"].indexOf(a.mode) - ["off", "on", "every-call"].indexOf(b.mode));
  const md = table(results);
  writeFileSync(join(args.out, "summary.md"), md + "\n");
  writeFileSync(join(args.out, "summary.json"), JSON.stringify(results, null, 2));
  console.log("\n" + md);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
