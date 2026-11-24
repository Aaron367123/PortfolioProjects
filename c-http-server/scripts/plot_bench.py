#!/usr/bin/env python3
"""Draw the benchmark chart (requests/sec vs worker threads) with Pillow.

    python -E -P scripts/plot_bench.py [--out path/to/bench-chart.jpg]

Reads benchmarks/results.json written by run_benchmarks.py. Two panels (1 KiB
and 100 KiB file), one line per keep-alive mode. Drawn at 2x and downsampled
for smooth anti-aliased lines.
"""
import argparse
import json
import os

from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RESULTS = os.path.join(ROOT, "benchmarks", "results.json")

BG, SURFACE, BORDER = "#0b0f1a", "#141a2e", "#232b47"
TEXT, MUTED, GRID = "#e8ebf5", "#9aa3bd", "#1f2742"
ACCENT, ACCENT2 = "#7c5cff", "#22d3ee"
S = 2  # supersampling factor
W, H = 1440, 780


def font(names, size):
    for n in names:
        p = os.path.join(os.environ.get("WINDIR", "C:/Windows"), "Fonts", n)
        if os.path.exists(p):
            return ImageFont.truetype(p, size * S)
    for p in ("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",):
        if os.path.exists(p):
            return ImageFont.truetype(p, size * S)
    return ImageFont.load_default()


F_TITLE = font(["segoeuib.ttf", "arialbd.ttf"], 30)
F_SUB = font(["segoeui.ttf", "arial.ttf"], 17)
F_PANEL = font(["segoeuisb.ttf", "segoeuib.ttf", "arialbd.ttf"], 19)
F_TICK = font(["segoeui.ttf", "arial.ttf"], 15)
F_LABEL = font(["segoeuisb.ttf", "segoeuib.ttf", "arialbd.ttf"], 15)
F_MONO = font(["consola.ttf", "cour.ttf"], 14)


def nice_max(v):
    for step in (1000, 2000, 2500, 5000, 10000, 20000, 25000, 50000):
        if v / step <= 6:
            return step * (int(v / step) + 1), step
    return v * 1.2, v / 5


def dashed_line(d, pts, fill, width, dash=14 * S, gap=9 * S):
    for (x0, y0), (x1, y1) in zip(pts, pts[1:]):
        length = ((x1 - x0) ** 2 + (y1 - y0) ** 2) ** 0.5
        t = 0.0
        while t < length:
            a, b = t / length, min(t + dash, length) / length
            d.line([(x0 + (x1 - x0) * a, y0 + (y1 - y0) * a),
                    (x0 + (x1 - x0) * b, y0 + (y1 - y0) * b)], fill=fill, width=width)
            t += dash + gap


def panel(d, box, title, series, workers):
    x0, y0, x1, y1 = [v * S for v in box]
    d.rounded_rectangle([x0, y0, x1, y1], radius=16 * S, fill=SURFACE, outline=BORDER, width=S)
    d.text((x0 + 26 * S, y0 + 20 * S), title, font=F_PANEL, fill=TEXT)
    d.text((x0 + 26 * S, y0 + 48 * S), "requests / second (higher is better)", font=F_TICK, fill=MUTED)

    px0, px1 = x0 + 84 * S, x1 - 120 * S
    py0, py1 = y0 + 92 * S, y1 - 64 * S
    vmax = max(v for _, _, vals, _ in series for v in vals)
    top, step = nice_max(vmax)

    v = 0
    while v <= top + 1e-9:
        y = py1 - (py1 - py0) * v / top
        d.line([(px0, y), (px1, y)], fill=GRID if v else BORDER, width=S)
        lab = "%dk" % (v // 1000) if v >= 1000 else "0"
        tw = d.textlength(lab, font=F_TICK)
        d.text((px0 - 14 * S - tw, y - 10 * S), lab, font=F_TICK, fill=MUTED)
        v += step

    xs = [px0 + (px1 - px0) * i / (len(workers) - 1) for i in range(len(workers))]
    for x, w in zip(xs, workers):
        lab = str(w)
        tw = d.textlength(lab, font=F_TICK)
        d.text((x - tw / 2, py1 + 12 * S), lab, font=F_TICK, fill=MUTED)
    cap = "worker threads (-t)"
    d.text(((px0 + px1) / 2 - d.textlength(cap, font=F_TICK) / 2, py1 + 34 * S), cap,
           font=F_TICK, fill=MUTED)

    for name, color, vals, style in series:
        pts = [(x, py1 - (py1 - py0) * val / top) for x, val in zip(xs, vals)]
        if style == "dash":
            dashed_line(d, pts, color, 3 * S)
        else:
            d.line(pts, fill=color, width=3 * S, joint="curve")
        for (x, y) in pts:
            r = 7 * S
            if style == "dash":  # square markers: identity is not colour-only
                d.rectangle([x - r, y - r, x + r, y + r], fill=color, outline=SURFACE, width=2 * S)
            else:
                d.ellipse([x - r, y - r, x + r, y + r], fill=color, outline=SURFACE, width=2 * S)
        # direct label at the line end: series name + final value
        ex, ey = pts[-1]
        d.text((ex + 16 * S, ey - 20 * S), name, font=F_LABEL, fill=TEXT)
        d.text((ex + 16 * S, ey + 0 * S), "{:,.0f}/s".format(vals[-1]), font=F_TICK, fill=MUTED)


def legend_item(d, x, y, color, style, label):
    x, y = x * S, y * S
    if style == "dash":
        dashed_line(d, [(x, y), (x + 40 * S, y)], color, 3 * S, dash=10 * S, gap=6 * S)
        d.rectangle([x + 14 * S, y - 6 * S, x + 26 * S, y + 6 * S], fill=color)
    else:
        d.line([(x, y), (x + 40 * S, y)], fill=color, width=3 * S)
        d.ellipse([x + 14 * S, y - 6 * S, x + 26 * S, y + 6 * S], fill=color)
    d.text((x + 52 * S, y - 11 * S), label, font=F_SUB, fill=TEXT)
    return x / S + 52 + d.textlength(label, font=F_SUB) / S + 36


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=os.path.join(ROOT, "benchmarks", "bench-chart.jpg"))
    ap.add_argument("--machine", default="")
    args = ap.parse_args()
    with open(RESULTS, encoding="utf-8") as f:
        data = json.load(f)
    res = data["results"]
    workers = sorted({r["workers"] for r in res})

    def vals(fname, ka):
        by = {r["workers"]: r["rps"] for r in res if r["file"] == fname and r["keepalive"] == ka}
        return [by[w] for w in workers]

    img = Image.new("RGB", (W * S, H * S), BG)
    d = ImageDraw.Draw(img)
    d.text((48 * S, 34 * S), "tinyhttpd throughput vs worker threads", font=F_TITLE, fill=TEXT)
    meta = data["meta"]
    sub = "bench -c %d -n %d, median of %d runs, client and server on the same machine (loopback)" % (
        meta["concurrency"], meta["requests"], meta["reps"])
    if args.machine:
        sub += "  |  " + args.machine
    d.text((48 * S, 80 * S), sub, font=F_SUB, fill=MUTED)
    lx = legend_item(d, 48, 132, ACCENT, "solid", "keep-alive on (-k)")
    legend_item(d, lx, 132, ACCENT2, "dash", "new connection per request")

    gap, top, bottom = 28, 166, H - 70
    pw = (W - 48 * 2 - gap) / 2
    for i, (fname, title) in enumerate((("small.html", "1 KiB page"), ("large.html", "100 KiB file"))):
        x0 = 48 + i * (pw + gap)
        panel(d, (x0, top, x0 + pw, bottom), title,
              [("keep-alive", ACCENT, vals(fname, True), "solid"),
               ("no keep-alive", ACCENT2, vals(fname, False), "dash")], workers)
    d.text((48 * S, (H - 46) * S), "tinyhttpd  |  HTTP/1.1 static file server in C11 "
           "(bounded queue + fixed worker pool)", font=F_MONO, fill=MUTED)

    img = img.resize((W, H), Image.LANCZOS)
    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    img.save(args.out, "JPEG", quality=90, optimize=True, progressive=True)
    print("wrote", args.out)


if __name__ == "__main__":
    main()
