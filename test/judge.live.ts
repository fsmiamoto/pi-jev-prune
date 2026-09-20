// Live Jev test (D3): needs TYPESAFE_API_KEY. Run: TYPESAFE_API_KEY=… npm run test:live
import assert from "node:assert/strict";
import test from "node:test";
import { TypeSafeClient } from "@typesafe-ai/sdk";
import { buildSnapshot } from "../src/candidates.ts";
import { createJevJudge } from "../src/judge.ts";
import { assistant, big, nextId, step, user } from "./fixtures.ts";

test("one request with 3 synthetic candidates returns 3 nouls in < 2 s", async () => {
  assert.ok(process.env.TYPESAFE_API_KEY, "TYPESAFE_API_KEY required");
  const judge = createJevJudge(new TypeSafeClient({ logLevel: "off" }));
  const r1 = nextId();
  const r2 = nextId();
  const r3 = nextId();
  const messages = [
    user("Fix the typo in the CLI help text for the `install` subcommand and make sure tests pass."),
    ...step("Let me look at the README first.", { id: r1, name: "read", args: { path: "README.md" } }, `# mansk\n\nA manifest-driven skill manager.\n${big(900, "readme")}`),
    ...step("The README is orientation. Now the CLI code.", { id: r2, name: "read", args: { path: "src/cli.rs" } }, `use clap::Parser;\n/// Instal a skill\nInstall { name: String },\n${big(900, "cli")}`),
    ...step("Found 'Instal' on line 42. Let me check tests.", { id: r3, name: "bash", args: { command: "cargo test" } }, `error[E0425]: cannot find value \`foo\` in this scope\n${big(900, "err")}`, true),
    assistant("a"),
    assistant("b"),
    assistant("c"),
    assistant("Tests fail on an unrelated error in lib.rs. I'll fix the typo in src/cli.rs first, then the lib.rs error."),
  ];
  const snap = buildSnapshot(messages, { exemptSteps: 3, minTokens: 300 });
  const cands = snap.candidates.filter((c) => c.eligible);
  assert.equal(cands.length, 3);
  const res = await judge.judge(snap.task, snap.now, cands, { timeoutMs: 2000 });
  console.log(JSON.stringify({ ms: res.ms, batches: res.batches, errors: res.errors, usage: res.usage, p: [...res.p.entries()].map(([id, p]) => [cands.find((c) => c.toolCallId === id)!.keyArg, p]) }));
  assert.deepEqual(res.errors, []);
  assert.equal(res.batches, 1);
  assert.equal(res.p.size, 3);
  assert.ok(res.ms < 2000, `took ${res.ms}ms`);
  for (const p of res.p.values()) assert.ok(p >= 0 && p <= 1);
  assert.ok(res.usage.input > 0);
});

test("timeout → empty result with error, no throw", async () => {
  const judge = createJevJudge(new TypeSafeClient({ logLevel: "off" }));
  const messages = [
    user("t"),
    ...step("x", { id: nextId(), name: "read", args: { path: "a" } }, big(600)),
    ...step("y", { id: nextId(), name: "read", args: { path: "b" } }, big(600)),
    assistant("a"),
    assistant("b"),
    assistant("c"),
  ];
  const snap = buildSnapshot(messages, { exemptSteps: 3, minTokens: 300 });
  const res = await judge.judge(snap.task, snap.now, snap.candidates.filter((c) => c.eligible), { timeoutMs: 1 });
  assert.equal(res.p.size, 0);
  assert.equal(res.errors.length, 1);
});
