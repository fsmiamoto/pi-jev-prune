/**
 * Reconstruct the exact Jev request the engine built at a given assistant step of a recorded live run,
 * using the real pipeline code (buildSnapshot → buildRequest). Output: JSON on stdout.
 *
 * Usage: node --experimental-strip-types experiments/visual/sample-request.ts <session.jsonl> <log.jsonl> <step>
 */
import { readFileSync } from "node:fs";
import { buildSessionContext, parseSessionEntries } from "@earendil-works/pi-coding-agent";
import { buildSnapshot } from "../../src/candidates.ts";
import { buildRequest, estimateStateTokens, CRITERIA, QUESTION } from "../../src/judge.ts";

const [sessionPath, logPath, stepArg] = process.argv.slice(2);
const step = Number(stepArg);
const entries = parseSessionEntries(readFileSync(sessionPath!, "utf8")).filter((entry) => entry.type !== "session");
const log = readFileSync(logPath!, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));

// Context as pi would have sent it for the LLM call that produced assistant message #step:
// = everything before that assistant message. Leaf = the message just before it.
const msgs = entries.filter((e: any) => e.type === "message") as any[];
let count = 0;
let leafId: string | undefined;
for (const e of msgs) {
  if (e.message.role === "assistant") {
    if (count === step) break;
    count++;
  }
  leafId = e.id;
}
const ctx = buildSessionContext(entries, leafId);
const messages = ctx.messages;

// Which ids did the engine actually judge at this step? (log records with step === step, reason jev, not promoted)
const judgedAt = log.filter((r) => r.step === step && r.reason === "jev" && !r.promoted);
const judgedIds = new Set(judgedAt.map((r) => r.toolCallId));
const pById = Object.fromEntries(judgedAt.map((r) => [r.toolCallId, { p: r.p, verdict: r.verdict, window: r.window }]));

const snap = buildSnapshot(messages, { exemptSteps: 3, minTokens: 300 });
const batch = snap.candidates.filter((c) => judgedIds.has(c.toolCallId));
const req = buildRequest(snap.task, snap.now, batch);

const out = {
  step,
  window: judgedAt[0]?.window,
  contextMessages: messages.length,
  contextTokensEstimate: Math.ceil(JSON.stringify(messages).length / 4),
  candidatesInContext: snap.candidates.length,
  eligible: snap.candidates.filter((c) => c.eligible).length,
  exempt: snap.candidates.filter((c) => c.exempt).length,
  sentToJev: batch.length,
  stateTokensEstimate: estimateStateTokens(snap.task, snap.now, batch),
  question: QUESTION,
  criteria: CRITERIA,
  state: req.state,
  questionsExample: req.questions["c0"],
  answers: batch.map((c, i) => ({ id: i, toolCallId: c.toolCallId, tool: c.tool, arg: c.keyArg, ...pById[c.toolCallId] })),
};
process.stdout.write(JSON.stringify(out, null, 2));
