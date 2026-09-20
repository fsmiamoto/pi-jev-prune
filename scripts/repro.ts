import { readFileSync } from "node:fs";
import { Engine } from "../src/engine.ts";
import { DEFAULTS } from "../src/config.ts";
import { DecisionStore } from "../src/decisions.ts";
import { FakeJudge } from "../test/fixtures.ts";

const f = process.argv[2]!;
const entries = readFileSync(f, "utf8").trim().split("\n").map((l) => JSON.parse(l));
const msgs: any[] = [];
let now = 0;
const engine = new Engine({ config: { ...DEFAULTS, mode: "dry" }, decisions: new DecisionStore(), judge: new FakeJudge(new Map(), 0.5), now: () => now });
for (const e of entries) {
  if (e.type !== "message") continue;
  const m = e.message;
  // an LLM call happens right before each assistant message: context = msgs so far
  if (m.role === "assistant") {
    now = Date.parse(e.timestamp) - 3000;
    const cold = engine.isCacheCold();
    const res = await engine.onContext(msgs, undefined);
    console.log(e.timestamp, "cold=", cold, "window=", res.status.window, "used=", res.status.usedTokens, "pending=", res.status.pendingTokens, "cands=", res.snapshot.candidates.length);
  }
  msgs.push(m);
}
