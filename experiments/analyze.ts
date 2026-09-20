/** Post-hoc analysis over experiments/out/*.outcomes.json (no network). */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { CandidateOutcome } from "./replay.ts";

const dir = process.argv[2] ?? "experiments/out";
const all: CandidateOutcome[] = [];
for (const f of readdirSync(dir)) if (f.endsWith(".outcomes.json")) all.push(...JSON.parse(readFileSync(join(dir, f), "utf8")));
const judged = all.filter((o) => o.firstP !== undefined);
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const fmt = (x: number) => (Number.isNaN(x) ? "  n/a" : x.toFixed(3));

console.log(`candidates=${all.length} judged=${judged.length} auto=${all.filter((o) => o.verdict === "auto").length}`);

// Signal check: does p separate re-read vs not?
const groups: Array<[string, (o: CandidateOutcome) => boolean]> = [
  ["rereadLater", (o) => o.rereadLater],
  ["editLater", (o) => o.editLater],
  ["touchedLater", (o) => o.touchedLater],
];
for (const [name, pred] of groups) {
  const yes = judged.filter(pred).map((o) => o.firstP!);
  const no = judged.filter((o) => !pred(o)).map((o) => o.firstP!);
  // AUC via rank comparison
  let wins = 0;
  for (const y of yes) for (const n of no) wins += y > n ? 1 : y === n ? 0.5 : 0;
  const auc = yes.length && no.length ? wins / (yes.length * no.length) : NaN;
  console.log(`${name.padEnd(13)} n_yes=${String(yes.length).padStart(3)} meanP_yes=${fmt(mean(yes))} n_no=${String(no.length).padStart(3)} meanP_no=${fmt(mean(no))} AUC=${fmt(auc)}`);
}

// Per tool
const tools = new Map<string, CandidateOutcome[]>();
for (const o of judged) tools.set(o.tool, [...(tools.get(o.tool) ?? []), o]);
console.log("\nper tool (judged):");
for (const [t, os] of [...tools].sort((a, b) => b[1].length - a[1].length)) {
  const ps = os.map((o) => o.firstP!);
  console.log(
    `${t.padEnd(12)} n=${String(os.length).padStart(3)} meanP=${fmt(mean(ps))} pruned@.35=${os.filter((o) => o.firstP! < 0.35).length} tokens=${os.reduce((n, o) => n + o.sizeTokens, 0)} touchedLater=${os.filter((o) => o.touchedLater).length}`,
  );
}

// Size vs p correlation (is Jev just reading size?)
const xs = judged.map((o) => Math.log(o.sizeTokens));
const ys = judged.map((o) => o.firstP!);
const mx = mean(xs), my = mean(ys);
let cov = 0, vx = 0, vy = 0;
for (let i = 0; i < xs.length; i++) { cov += (xs[i]! - mx) * (ys[i]! - my); vx += (xs[i]! - mx) ** 2; vy += (ys[i]! - my) ** 2; }
console.log(`\ncorr(log size, p) = ${fmt(cov / Math.sqrt(vx * vy))}`);

// Verdict stability: candidates judged more than once — how much does p move?
const multi = judged.filter((o) => o.ps.length > 1);
const drift = multi.map((o) => Math.max(...o.ps.map((x) => x[1])) - Math.min(...o.ps.map((x) => x[1])));
console.log(`re-judged candidates=${multi.length} mean p-range=${fmt(mean(drift))} max=${fmt(Math.max(0, ...drift))}`);
const flips = multi.filter((o) => o.ps.some((x) => x[1] < 0.35) && o.ps.some((x) => x[1] >= 0.35)).length;
console.log(`would-flip across 0.35 if not sticky: ${flips}`);

// The FPs at 0.35
console.log("\npruned@.35 but re-read/edited later:");
for (const o of judged.filter((o) => o.firstP! < 0.35 && (o.rereadLater || o.editLater)))
  console.log(`  ${o.session.slice(0, 8)} ${o.tool} ${o.keyArg.slice(0, 60)} p=${o.firstP!.toFixed(2)} size=${o.sizeTokens} reread=${o.rereadLater} edit=${o.editLater}`);
console.log("\nkept@.35 (p>=0.35) — top by p:");
for (const o of judged.filter((o) => o.firstP! >= 0.35).sort((a, b) => b.firstP! - a.firstP!).slice(0, 15))
  console.log(`  ${o.session.slice(0, 8)} ${o.tool} ${o.keyArg.slice(0, 60)} p=${o.firstP!.toFixed(2)} size=${o.sizeTokens} touched=${o.touchedLater}`);

// ---- citation proxy (DF-filtered) ----
{
  const cited = judged.filter((o) => o.citedLater);
  const not = judged.filter((o) => !o.citedLater);
  let wins = 0;
  for (const y of cited) for (const n of not) wins += y.firstP! > n.firstP! ? 1 : y.firstP! === n.firstP! ? 0.5 : 0;
  console.log(`\ncitedLater: n=${cited.length}/${judged.length} tokens=${cited.reduce((n, o) => n + o.sizeTokens, 0)} (oracle would keep these) vs notCited tokens=${not.reduce((n, o) => n + o.sizeTokens, 0)}`);
  console.log(`meanP cited=${fmt(mean(cited.map((o) => o.firstP!)))} notCited=${fmt(mean(not.map((o) => o.firstP!)))} AUC(firstP)=${fmt(wins / (cited.length * not.length))}`);
  const lastP = (o: CandidateOutcome) => o.ps.at(-1)?.[1] ?? o.firstP!;
  let w2 = 0;
  for (const y of cited) for (const n of not) w2 += lastP(y) > lastP(n) ? 1 : lastP(y) === lastP(n) ? 0.5 : 0;
  console.log(`AUC(lastP)=${fmt(w2 / (cited.length * not.length))}`);
  const prunedCited = cited.filter((o) => o.verdict === "prune");
  const atFirst = prunedCited.filter((o) => o.pruneStep === o.firstStep).length;
  console.log(`pruned&cited=${prunedCited.length}: pruned at first verdict=${atFirst}, after re-judge drift=${prunedCited.length - atFirst}`);
  const hist = new Map<string, number>();
  for (const o of prunedCited) {
    const b = o.citedAfterSteps <= 2 ? "0-2" : o.citedAfterSteps <= 5 ? "3-5" : o.citedAfterSteps <= 10 ? "6-10" : ">10";
    hist.set(b, (hist.get(b) ?? 0) + 1);
  }
  console.log(`citedAfterSteps (pruned&cited): ${JSON.stringify([...hist])}`);
  console.log("per tool cited rate:");
  for (const [t, os] of tools) console.log(`  ${t.padEnd(18)} cited=${os.filter((o) => o.citedLater).length}/${os.length}`);
  console.log("\nsample pruned&cited (p, after, tokens):");
  for (const o of prunedCited.slice(0, 12)) console.log(`  ${o.tool.padEnd(8)} p=${o.firstP!.toFixed(2)} ps=${o.ps.length} after=${o.citedAfterSteps} ${o.keyArg.slice(0, 50).padEnd(50)} ${JSON.stringify(o.citedTokens).slice(0, 90)}`);
}
