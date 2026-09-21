#!/usr/bin/env python3
"""Build docs/assets/results.svg using only the Python standard library.

Run: python3 experiments/visual/results.py
Source: docs/index.html, const DATA.live.runs, round=2, task=multi,
threshold=0.25, budget=100000. See experiments/REPORT.md §2.3.
The archived HTML retains exact peak/cacheWrite values; the report rounds
cache writes. build.py maps these fields from result.json's
peakContextTokens/cacheWriteTokens in experiments/out/live-multi/multi-*.
Cache writes are cumulative tokens, not dollars or peak context.
"""

import json
from html import escape
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
COLORS = {"Off": "#63758A", "Batched (on)": "#087F8C", "Every-call": "#B65C24"}
INK, MUTED, GRID, BACKGROUND = "#152C43", "#4B6075", "#DCE4EC", "#F8FAFC"


def build():
    html = (ROOT / "docs/index.html").read_text(encoding="utf-8")
    data, _ = json.JSONDecoder().raw_decode(html.split("const DATA = ", 1)[1])
    runs = [r for r in data["live"]["runs"] if r["round"] == 2
            and r["task"] == "multi" and r["threshold"] == 0.25
            and r["budget"] == 100000]
    modes = [("off", "Off"), ("on (t 0.25)", "Batched (on)"), ("every-call", "Every-call")]
    rows = []
    for mode, label in modes:
        matches = [r for r in runs if r["mode"] == mode]
        if len(matches) != 1:
            raise ValueError(f"Expected exactly one source run for {mode}")
        rows.append((label, matches[0]))

    description = "; ".join(
        f'{label}: peak context {r["peak"]:,} tokens, cache writes {r["cacheWrite"]:,} tokens'
        for label, r in rows
    )
    svg = [
        '<svg xmlns="http://www.w3.org/2000/svg" width="880" height="370" '
        'viewBox="0 0 880 370" role="img" aria-labelledby="title desc">',
        '<title id="title">Less context, more cache writes</title>',
        f'<desc id="desc">{escape(description)}. Both bar charts start at zero; '
        'their scales differ. One three-task session per mode, Claude Sonnet 4.5; '
        'not a benchmark. Pruning threshold 0.25, budget 100,000 tokens.</desc>',
        f'<rect width="880" height="370" rx="12" fill="{BACKGROUND}"/>',
        '<g font-family="-apple-system, BlinkMacSystemFont, Segoe UI, sans-serif">',
    ]

    def text(x, y, value, size=14, fill=INK, weight=400, anchor="start", numeric=False):
        font = ' font-family="ui-monospace, SFMono-Regular, Consolas, monospace"' if numeric else ""
        svg.append(f'<text x="{x}" y="{y}" font-size="{size}" fill="{fill}" '
                   f'font-weight="{weight}" text-anchor="{anchor}"{font}>{escape(str(value))}</text>')

    text(32, 37, "Less context, more cache writes", 24, weight=700)
    text(32, 61, "Live session: architecture → error fixes → execution trace", fill=MUTED)
    svg.append(f'<path d="M440 87V316" stroke="{GRID}"/>')

    for x, title, subtitle, key, maximum, tick in [
        (32, "Peak context", "Tokens · maximum per session", "peak", 100000, 25000),
        (468, "Cache writes", "Tokens · cumulative per session", "cacheWrite", 600000, 150000),
    ]:
        width = 380
        text(x, 103, title, 18, weight=700)
        text(x, 124, subtitle, 13, fill=MUTED)
        for i, (label, run) in enumerate(rows):
            y = 150 + i * 55
            value = run[key]
            if not 0 <= value <= maximum:
                raise ValueError(f"Value outside axis: {key}={value}")
            text(x, y, label, weight=600)
            text(x + width, y, f"{value:,}", anchor="end", numeric=True)
            svg.append(f'<rect x="{x}" y="{y + 8}" width="{value / maximum * width:.3f}" '
                       f'height="17" rx="2" fill="{COLORS[label]}"/>')
        # Visible zero baseline and independent, explicitly labelled linear scales.
        svg.append(f'<path d="M{x} 154V296H{x + width}" fill="none" stroke="{MUTED}"/>')
        for value in range(0, maximum + 1, tick):
            tx = x + value / maximum * width
            svg.append(f'<path d="M{tx} 296v4" stroke="{MUTED}"/>')
            text(tx, 315, "0" if value == 0 else f"{value // 1000}k", 12,
                 fill=MUTED, anchor="middle", numeric=True)

    text(32, 342, "One 3-task session per mode · Sonnet 4.5 · Not a benchmark", 14, weight=600)
    text(32, 361, "Threshold 0.25 · Budget 100k tokens · Cache writes are not total cost · Source: experiment report §2.3", 12, fill=MUTED)
    svg.extend(["</g>", "</svg>"])
    output = ROOT / "docs/assets/results.svg"
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text("\n".join(svg) + "\n", encoding="utf-8")
    print(output)


if __name__ == "__main__":
    build()
