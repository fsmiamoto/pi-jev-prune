// Live Jev smoke test: 3 synthetic candidates, one Noul each. Requires TYPESAFE_API_KEY.
import { noul, TypeSafeClient } from "@typesafe-ai/sdk";

const client = new TypeSafeClient({ logLevel: "off" });

const state = {
  task: "Fix the typo in the CLI help text for the `install` subcommand and make sure tests pass.",
  now: "I found the typo in src/cli.rs line 42 ('instal' -> 'install'). Editing now.",
  candidates: [
    {
      id: 0,
      tool: "read",
      arg: "README.md",
      turnsAgo: 6,
      sizeTokens: 1800,
      isError: false,
      head: "# mansk\n\nA manifest-driven skill manager...\n## Install\n```\ncargo install mansk\n```",
      tail: "MIT License",
      agentReaction: "The README describes the overall project; the CLI code is probably in src/.",
    },
    {
      id: 1,
      tool: "read",
      arg: "src/cli.rs",
      turnsAgo: 2,
      sizeTokens: 1200,
      isError: false,
      head: "use clap::Parser;\n#[derive(Parser)]\nstruct Cli { ... }\n/// Instal a skill\nInstall { name: String },",
      tail: "}",
      agentReaction: "Found it: line 42 has 'Instal'. I'll fix this with an edit.",
    },
    {
      id: 2,
      tool: "bash",
      arg: "cargo test",
      turnsAgo: 8,
      sizeTokens: 900,
      isError: true,
      head: "error[E0425]: cannot find value `foo` in this scope\n --> src/lib.rs:10:5",
      tail: "error: could not compile `mansk` due to previous error",
      agentReaction: "The build fails on an unrelated error in lib.rs; I'll look at that first.",
    },
  ],
};

const q = (i: number) =>
  noul(
    {
      candidate: `candidates[${i}]`,
      question:
        "Will the agent need to re-read the full output of this tool result (`candidate`) to finish `task`, given what it is doing `now`?",
    },
    {
      true: "The output contains details the agent still has to consult (exact code to edit, error text to fix, values to copy) and has not been superseded.",
      false: "The agent already extracted what it needed, the output was only orientation, it has been superseded by a newer read/edit of the same target, or it is unrelated to the remaining work.",
    },
  );

const t0 = performance.now();
const res = await client.systemOne(
  { state, questions: { c0: q(0), c1: q(1), c2: q(2) } },
  { timeout: 5000, retry: { maxRetries: 0 } },
);
const ms = Math.round(performance.now() - t0);
console.log(JSON.stringify({ model: res.model, ms, usage: res.usage, answers: res.answers }, null, 2));
