#!/usr/bin/env python3
"""Build the visual report: docs/index.html (self-contained; data inlined; published via GitHub Pages).

Reads experiments/out/ (replay), experiments/out.sweep/ (threshold sweep), experiments/out/live*/ (live A/B).
Usage: python3 experiments/visual/build.py
"""
import glob
import json
import os
import statistics
from collections import Counter, defaultdict
from datetime import datetime

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
EXP = os.path.join(ROOT, "experiments")
OUT = os.path.join(ROOT, "docs")  # served by GitHub Pages (main, /docs)
os.makedirs(OUT, exist_ok=True)


def jl(path):
    with open(path) as f:
        return [json.loads(l) for l in f if l.strip()]


def ts(s):
    return datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp()


def trunc(s, n):
    s = (s or "").replace("\n", " ")
    return s if len(s) <= n else s[: n - 1] + "…"


# ---------------------------------------------------------------- replay (offline)
replay = {}
outcomes = []
for f in sorted(glob.glob(os.path.join(EXP, "out.sweep", "0.35", "*.outcomes.json"))):  # refined citation proxy
    outcomes += json.load(open(f))
replay["n"] = len(outcomes)
replay["firstP"] = [{"p": o["firstP"], "cited": o["citedLater"], "tool": o["tool"], "size": o["sizeTokens"]} for o in outcomes if o.get("firstP") is not None]
summ = json.load(open(os.path.join(EXP, "out", "summary.json")))["summaries"]
replay["sessions"] = len(summ)
replay["llmCalls"] = sum(s["llmCalls"] for s in summ)
replay["toolTokens"] = sum(s["toolTokens"] for s in summ)
replay["jevP50"] = int(statistics.median(s["jevMsP50"] for s in summ if s["jevRequests"]))
replay["jevMax"] = max(s["jevMsMax"] for s in summ)
by_tool = defaultdict(list)
for o in outcomes:
    if o.get("firstP") is not None:
        by_tool[o["tool"]].append(o)
replay["byTool"] = [
    {"tool": t, "n": len(v), "meanP": round(statistics.mean(o["firstP"] for o in v), 2), "cited": sum(o["citedLater"] for o in v)}
    for t, v in sorted(by_tool.items(), key=lambda kv: -len(kv[1]))
]
replay["reread"] = sum(1 for o in outcomes if o.get("rereadLater"))
replay["edited"] = sum(1 for o in outcomes if o.get("editLater"))
cited_tok = sum(o["sizeTokens"] for o in outcomes if o["citedLater"])
uncited_tok = sum(o["sizeTokens"] for o in outcomes if not o["citedLater"])
replay["oracle"] = {"citedTok": cited_tok, "uncitedTok": uncited_tok}
# examples
low = sorted((o for o in outcomes if o.get("firstP") is not None), key=lambda o: o["firstP"])[:8]
replay["lowExamples"] = [{"tool": o["tool"], "arg": trunc(o["keyArg"], 90), "p": o["firstP"], "size": o["sizeTokens"], "cited": o["citedLater"]} for o in low]
fp = [o for o in outcomes if o["verdict"] == "prune" and o["citedLater"] and o.get("firstP") is not None]
fp.sort(key=lambda o: o["firstP"])
replay["fpExamples"] = [
    {"tool": o["tool"], "arg": trunc(o["keyArg"], 90), "p": o["firstP"], "size": o["sizeTokens"], "tokens": o["citedTokens"][:4], "after": o["citedAfterSteps"]}
    for o in fp[:8]
]
# sweep
sweep = []
for d in sorted(glob.glob(os.path.join(EXP, "out.sweep", "*"))):
    t = float(os.path.basename(d))
    oc = []
    for f in glob.glob(os.path.join(d, "*.outcomes.json")):
        oc += json.load(open(f))
    pruned = [o for o in oc if o["verdict"] == "prune"]
    uncited = [o for o in oc if not o["citedLater"]]
    sm = json.load(open(os.path.join(d, "summary.json")))["summaries"]
    peak = sum(s["peakContextTokens"] for s in sm)
    peakp = sum(s["peakContextTokensPruned"] for s in sm)
    sweep.append(
        {
            "t": t,
            "judged": len(oc),
            "pruned": len(pruned),
            "saved": sum(o["sizeTokens"] for o in pruned),
            "fp": round(sum(o["citedLater"] for o in pruned) / max(1, len(pruned)), 3),
            "recall": round(sum(1 for o in pruned if not o["citedLater"]) / max(1, len(uncited)), 3),
            "peakDrop": round(1 - peakp / peak, 3),
            "fpTok": sum(o["sizeTokens"] for o in pruned if o["citedLater"]),
        }
    )
base_rate = round(sum(o["citedLater"] for o in outcomes) / max(1, len(outcomes)), 3)
replay["sweep"] = sweep
replay["baseRate"] = base_rate

# ---------------------------------------------------------------- live
live = {"runs": []}


def analyze_run(d, task, mode, label):
    res = json.load(open(os.path.join(d, "result.json")))
    sess = glob.glob(os.path.join(d, "sessions", "*.jsonl"))
    if not sess:
        return None
    es = jl(sess[0])
    log_path = os.path.join(d, "jev-prune.log.jsonl")
    log = jl(log_path) if os.path.exists(log_path) else []
    applied = [r for r in log if r.get("applied")]
    msgs = [e for e in es if e.get("type") == "message"]
    # per-call series
    calls = []
    turn = 0
    turn_starts = []
    for e in msgs:
        m = e["message"]
        if m["role"] == "user":
            turn += 1
            turn_starts.append(len(calls))
        elif m["role"] == "assistant":
            u = m.get("usage") or {}
            ctx = (u.get("input") or 0) + (u.get("cacheRead") or 0) + (u.get("cacheWrite") or 0)
            calls.append({"i": len(calls), "ctx": ctx, "cw": u.get("cacheWrite") or 0, "cost": ((u.get("cost") or {}).get("total") or 0), "t": ts(e["timestamp"]), "turn": turn})
    # rewrite events → first call at/after event ts
    events = defaultdict(list)
    for r in applied:
        et = ts(r["ts"])
        idx = next((c["i"] for c in calls if c["t"] >= et), None)
        if idx is not None:
            events[idx].append(r)
    rewrites = [{"call": i, "n": len(rs), "saved": sum(r["sizeTokens"] for r in rs), "window": rs[0]["window"]} for i, rs in sorted(events.items())]
    # per turn peaks
    turns = []
    for k in range(1, turn + 1):
        cs = [c for c in calls if c["turn"] == k]
        if cs:
            turns.append({"turn": k, "calls": len(cs), "peak": max(c["ctx"] for c in cs), "cost": round(sum(c["cost"] for c in cs), 2), "cw": sum(c["cw"] for c in cs)})
    # judgments
    judged = [r for r in log if r.get("p") is not None and not r.get("promoted")]
    first = {}
    traj = defaultdict(list)
    for r in judged:
        first.setdefault(r["toolCallId"], {"p": r["p"], "tool": r["tool"], "arg": r.get("keyArg") or ""})
        traj[r["toolCallId"]].append((r["step"], r["p"]))
    # tool result content lookup for pruned items (head + lines)
    content = {}
    for e in msgs:
        m = e["message"]
        if m["role"] == "toolResult":
            txt = "".join(c.get("text", "") for c in m.get("content", []) if c.get("type") == "text")
            content[m["toolCallId"]] = txt
    pruned_items = []
    for r in applied:
        txt = content.get(r["toolCallId"], "")
        pruned_items.append(
            {
                "tool": r["tool"],
                "arg": trunc(r.get("keyArg"), 70),
                "size": r["sizeTokens"],
                "p": r.get("p"),
                "reason": r["reason"],
                "window": r["window"],
                "step": r["step"],
                "lines": txt.count("\n") + 1 if txt else 0,
                "head": trunc(txt, 160),
                "id": r["toolCallId"],
            }
        )
    reasons = Counter("superseded" if r["reason"].startswith("superseded") else r["reason"] for r in applied)
    # backpack snapshot: end of turn 2 (or last call)
    cut_turn = 2 if turn >= 3 else turn
    snap_msgs = []
    tcount = 0
    call_map = {}
    for e in msgs:
        m = e["message"]
        if m["role"] == "user":
            tcount += 1
            if tcount > cut_turn:
                break
        snap_msgs.append(e)
    snap_t = ts(snap_msgs[-1]["timestamp"])
    pruned_ids = {r["toolCallId"] for r in applied if ts(r["ts"]) <= snap_t}
    size_by_id = {r["toolCallId"]: r["sizeTokens"] for r in log if r.get("sizeTokens")}  # pi's estimateTokens, via the engine
    for e in snap_msgs:
        m = e["message"]
        if m["role"] == "assistant":
            for c in m.get("content", []):
                if c.get("type") == "toolCall":
                    call_map[c["id"]] = (c["name"], c.get("arguments") or {})
    blocks = []
    for e in snap_msgs:
        m = e["message"]
        if m["role"] == "user":
            txt = m["content"] if isinstance(m["content"], str) else "".join(c.get("text", "") for c in m["content"] if c.get("type") == "text")
            blocks.append({"role": "user", "tok": max(20, len(txt) // 4)})
        elif m["role"] == "assistant":
            txt = "".join(c.get("text", "") for c in m.get("content", []) if c.get("type") == "text")
            blocks.append({"role": "assistant", "tok": max(20, len(txt) // 4 + 40)})
        elif m["role"] == "toolResult":
            txt = content.get(m["toolCallId"], "")
            name, args = call_map.get(m["toolCallId"], (m.get("toolName"), {}))
            arg = args.get("path") or args.get("command") or args.get("pattern") or args.get("url") or ""
            fp_ = first.get(m["toolCallId"])
            blocks.append({"role": "tool", "tool": name, "arg": trunc(arg, 60), "tok": size_by_id.get(m["toolCallId"], max(10, len(txt) // 4)), "pruned": m["toolCallId"] in pruned_ids, "p": fp_["p"] if fp_ else None})
    snap_ctx = next((c["ctx"] for c in reversed(calls) if c["turn"] <= cut_turn), 0)
    return {
        "label": label,
        "task": task,
        "mode": mode,
        "threshold": res["threshold"],
        "budget": res["budget"],
        "done": res["completed"],
        "wall": round(res["wallMs"] / 1000),
        "llmCalls": res["llmCalls"],
        "toolCalls": res["toolCalls"],
        "peak": res["peakContextTokens"],
        "totalIn": res["totalInputTokens"],
        "cacheWrite": res["cacheWriteTokens"],
        "cacheRead": res["cacheReadTokens"],
        "cost": round(res["cost"], 2),
        "prunes": len({r["toolCallId"] for r in applied}),
        "prunedTok": sum(r["sizeTokens"] for r in {r["toolCallId"]: r for r in applied}.values()),
        "recalls": res["recalls"],
        "judged": len(judged),
        "ids": len(first),
        "jevIn": res.get("jevInputTokens", 0),
        "idsMissing": len((res.get("identifiers") or {}).get("missing", [])),
        "idsTotal": (res.get("identifiers") or {}).get("total", 0),
        "calls": [{"i": c["i"], "ctx": c["ctx"], "cw": c["cw"], "turn": c["turn"]} for c in calls],
        "turnStarts": turn_starts,
        "rewrites": rewrites,
        "turns": turns,
        "firstP": [v["p"] for v in first.values()],
        "firstByTool": {t: round(statistics.mean(v["p"] for v in first.values() if v["tool"] == t), 2) for t in {v["tool"] for v in first.values()}},
        "traj": sorted(
            [{"id": k, "tool": first[k]["tool"], "arg": trunc(first[k]["arg"], 40), "pts": v} for k, v in traj.items() if len(v) >= 4],
            key=lambda x: -len(x["pts"]),
        )[:8],
        "pruned": pruned_items,
        "reasons": dict(reasons),
        "backpack": {"blocks": blocks, "ctx": snap_ctx, "turn": cut_turn},
    }


for d in sorted(glob.glob(os.path.join(EXP, "out", "live", "*-*"))):
    if not os.path.isdir(d):
        continue
    task, mode = os.path.basename(d).split("-", 1)
    r = analyze_run(d, task, mode, f"round1 {task}/{mode}")
    if r:
        r["round"] = 1
        live["runs"].append(r)
for d, lbl in [(os.path.join(EXP, "out", "live-multi", "multi-off"), "off"), (os.path.join(EXP, "out", "live-multi", "multi-on"), "on (t 0.25)"), (os.path.join(EXP, "out", "live-multi", "multi-every-call"), "every-call"), (os.path.join(EXP, "out", "live-multi-t35", "multi-on"), "on (t 0.35)")]:
    if os.path.isdir(d):
        r = analyze_run(d, "multi", lbl, f"round2 multi/{lbl}")
        if r:
            r["round"] = 2
            live["runs"].append(r)

live["totalRuns"] = len(live["runs"])
live["totalRecalls"] = sum(r["recalls"] for r in live["runs"])
live["totalPrunes"] = sum(r["prunes"] for r in live["runs"])
live["totalIdsMissing"] = sum(r["idsMissing"] for r in live["runs"])
live["totalIdsChecked"] = sum(r["idsTotal"] for r in live["runs"])
live["reasons"] = dict(sum((Counter(r["reasons"]) for r in live["runs"]), Counter()))
live["firstPAll"] = [p for r in live["runs"] for p in r["firstP"]]

# ---------------------------------------------------------------- a real Jev request, reconstructed with the pipeline code
import subprocess
sample = None
on_dir = os.path.join(EXP, "out", "live-multi", "multi-on")
sess = glob.glob(os.path.join(on_dir, "sessions", "*.jsonl"))
if sess:
    try:
        raw = subprocess.run(
            ["node", "--experimental-strip-types", os.path.join(EXP, "visual", "sample-request.ts"), sess[0], os.path.join(on_dir, "jev-prune.log.jsonl"), "53"],
            capture_output=True, text=True, check=True, cwd=ROOT,
        ).stdout
        sample = json.loads(raw)
    except subprocess.CalledProcessError as e:
        print("sample-request failed:", e.stderr[-500:])

data = {"replay": replay, "live": live, "sample": sample, "built": datetime.now().strftime("%Y-%m-%d %H:%M")}
import re
payload = re.sub(r"/Users/[^/\"\\ ]+", "~", json.dumps(data))  # home dirs → ~ (paths from replayed sessions)
tpl = open(os.path.join(EXP, "visual", "template.html")).read()
html = tpl.replace("__DATA__", payload)
open(os.path.join(OUT, "index.html"), "w").write(html)
print(os.path.join(OUT, "index.html"), len(html) // 1024, "KB")
