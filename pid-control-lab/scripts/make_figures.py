"""
make_figures.py - draw the README figures from real simulation output.

    node scripts/export-figure-data.mjs        # writes docs/figure-data.json
    python -E -P scripts/make_figures.py       # writes docs/*.png

Plain Pillow (no matplotlib): each figure is drawn at 2x and downsampled with LANCZOS
for anti-aliased lines. Colours follow the portfolio's dark circuit-board palette.
"""
import json
import os
import sys
from math import floor, log10

from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DOCS = os.path.join(ROOT, "docs")
SS = 2  # supersampling factor

PAL = {
    "bg": (7, 17, 12), "surface": (14, 29, 22), "border": (40, 58, 48), "grid": (24, 40, 32),
    "text": (232, 240, 234), "muted": (159, 181, 168), "faint": (111, 134, 121),
    "copper": (224, 164, 88), "copper_bright": (247, 200, 134), "led": (62, 224, 143),
    "signal": (79, 209, 197), "warn": (255, 204, 102), "danger": (255, 107, 94),
}


def font(names, size):
    for n in names:
        for d in ("C:/Windows/Fonts", "/usr/share/fonts/truetype/dejavu", "/Library/Fonts"):
            p = os.path.join(d, n)
            if os.path.exists(p):
                return ImageFont.truetype(p, size * SS)
    return ImageFont.load_default()


SANS = lambda s: font(["segoeui.ttf", "Inter-Regular.ttf", "DejaVuSans.ttf", "Arial.ttf"], s)
SANS_B = lambda s: font(["segoeuib.ttf", "Inter-SemiBold.ttf", "DejaVuSans-Bold.ttf", "Arial Bold.ttf"], s)
MONO = lambda s: font(["consola.ttf", "IBMPlexMono-Regular.ttf", "DejaVuSansMono.ttf", "Menlo.ttc"], s)


def nice_step(span, count=5):
    raw = span / max(1, count)
    mag = 10 ** floor(log10(raw))
    n = raw / mag
    m = 1 if n < 1.5 else 2 if n < 2.25 else 2.5 if n < 3.5 else 5 if n < 7.5 else 10
    return m * mag


def fmt(v, step):
    d = max(0, -floor(log10(step) + 1e-9))
    s = f"{v:.{d}f}"
    return "0" if s in ("-0", "-0.0") else s


class Axes:
    """A rectangular plot area with linear x/y mapping, grid and tick labels."""

    def __init__(self, draw, box, xr, yr, title=None, xlabel=None, ylabel=None):
        self.d, self.box, self.xr, self.yr = draw, [v * SS for v in box], xr, yr
        x0, y0, x1, y1 = self.box
        draw.rectangle(self.box, fill=PAL["surface"], outline=PAL["border"], width=SS)
        f = MONO(11)
        ys = nice_step(yr[1] - yr[0], 5)
        v = (yr[0] // ys) * ys
        while v <= yr[1] + 1e-9:
            if v >= yr[0] - 1e-9:
                py = self.Y(v)
                draw.line([(x0, py), (x1, py)], fill=PAL["grid"], width=SS)
                draw.text((x0 - 8 * SS, py), fmt(v, ys), font=f, fill=PAL["faint"], anchor="rm")
            v += ys
        xs = nice_step(xr[1] - xr[0], 6)
        v = (xr[0] // xs) * xs
        while v <= xr[1] + 1e-9:
            if v >= xr[0] - 1e-9:
                px = self.X(v)
                draw.line([(px, y0), (px, y1)], fill=PAL["grid"], width=SS)
                draw.text((px, y1 + 6 * SS), fmt(v, xs), font=f, fill=PAL["faint"], anchor="mt")
            v += xs
        draw.rectangle(self.box, outline=PAL["border"], width=SS)
        if title:
            draw.text((x0, y0 - 10 * SS), title.upper(), font=MONO(11), fill=PAL["muted"], anchor="ls")
        if xlabel:
            draw.text((x1, y1 + 22 * SS), xlabel, font=MONO(11), fill=PAL["faint"], anchor="rt")

    def X(self, x):
        x0, _, x1, _ = self.box
        return x0 + (x - self.xr[0]) / (self.xr[1] - self.xr[0]) * (x1 - x0)

    def Y(self, y):
        _, y0, _, y1 = self.box
        y = min(max(y, self.yr[0] - (self.yr[1] - self.yr[0]) * 0.05), self.yr[1] + (self.yr[1] - self.yr[0]) * 0.05)
        return y1 - (y - self.yr[0]) / (self.yr[1] - self.yr[0]) * (y1 - y0)

    def line(self, xs, ys, color, width=2.0, dash=None):
        pts = [(self.X(x), self.Y(y)) for x, y in zip(xs, ys) if self.xr[0] <= x <= self.xr[1]]
        if len(pts) < 2:
            return
        w = max(1, round(width * SS))
        if not dash:
            self.d.line(pts, fill=color, width=w, joint="curve")
            return
        on, off = dash[0] * SS, dash[1] * SS
        acc, draw_on = 0.0, True
        for (ax, ay), (bx, by) in zip(pts, pts[1:]):
            seg = ((bx - ax) ** 2 + (by - ay) ** 2) ** 0.5
            pos = 0.0
            while pos < seg:
                lim = on if draw_on else off
                step = min(lim - acc, seg - pos)
                if draw_on:
                    t0, t1 = pos / seg, (pos + step) / seg
                    self.d.line([(ax + (bx - ax) * t0, ay + (by - ay) * t0), (ax + (bx - ax) * t1, ay + (by - ay) * t1)], fill=color, width=w)
                pos += step
                acc += step
                if acc >= lim - 1e-9:
                    acc, draw_on = 0.0, not draw_on

    def hband(self, y0, y1, color):
        x0, _, x1, _ = self.box
        self.d.rectangle([x0 + SS, self.Y(y1), x1 - SS, self.Y(y0)], fill=color)


def canvas(w, h, title, subtitle):
    img = Image.new("RGB", (w * SS, h * SS), PAL["bg"])
    d = ImageDraw.Draw(img)
    for gx in range(0, w * SS, 48 * SS):  # faint PCB trace grid
        d.line([(gx, 0), (gx, h * SS)], fill=(14, 26, 19), width=SS)
    for gy in range(0, h * SS, 48 * SS):
        d.line([(0, gy), (w * SS, gy)], fill=(14, 26, 19), width=SS)
    d.text((32 * SS, 26 * SS), title, font=SANS_B(22), fill=PAL["text"])
    d.text((32 * SS, 58 * SS), subtitle, font=SANS(14), fill=PAL["muted"])
    return img, d


def legend(d, x, y, items):
    f = MONO(12)
    for label, color, dash in items:
        if dash:
            for k in range(3):
                d.line([((x + k * 8) * SS, y * SS), ((x + k * 8 + 5) * SS, y * SS)], fill=color, width=3 * SS)
        else:
            d.line([(x * SS, y * SS), ((x + 22) * SS, y * SS)], fill=color, width=3 * SS)
        d.text(((x + 30) * SS, y * SS), label, font=f, fill=PAL["text"], anchor="lm")
        x += 40 + int(d.textlength(label, font=f) / SS) + 18


def save(img, name):
    out = img.resize((img.width // SS, img.height // SS), Image.LANCZOS)
    path = os.path.join(DOCS, name)
    out.save(path, optimize=True)
    print("wrote", path, out.size)
    return out


def fig_windup(data):
    W, H = 1400, 820
    w = data["windup"]
    img, d = canvas(W, H, "Integrator windup vs anti-windup",
                    f"{w['plant']}: step {w['step'][0]} → {w['step'][1]} °C, PID Kp {w['gains']['Kp']}, Ki {w['gains']['Ki']}, Kd {w['gains']['Kd']}, heater limited to 0-100 %")
    colors = [PAL["danger"], PAL["led"], PAL["copper"]]
    T = w["runs"][0]["t"][-1]
    a = Axes(d, (90, 130, 960, 470), (0, T), (15, 85), "Temperature [°C]")
    a.hband(w["step"][1] * 0.98 + 0.02 * w["step"][0], w["step"][1] * 1.02 - 0.02 * w["step"][0], (18, 44, 40))
    a.line([0, T], [w["step"][1]] * 2, PAL["signal"], 1.6, dash=(6, 5))
    for r, c in zip(w["runs"], colors):
        a.line(r["t"], r["yTrue"], c, 2.4)
    b = Axes(d, (90, 540, 960, 760), (0, T), (-10, 110), "Heater power u [%]", xlabel="time [s]")
    b.line([0, T], [100, 100], PAL["warn"], 1.2, dash=(4, 4))
    b.line([0, T], [0, 0], PAL["warn"], 1.2, dash=(4, 4))
    for r, c in zip(w["runs"], colors):
        b.line(r["t"], r["u"], c, 2.0)
    legend(d, 90, 104, [("setpoint", PAL["signal"], True)] + [(r["label"], c, False) for r, c in zip(w["runs"], colors)])
    # metrics panel
    x0 = 1000
    d.rectangle([x0 * SS, 130 * SS, (W - 32) * SS, 760 * SS], fill=PAL["surface"], outline=PAL["border"], width=SS)
    d.text(((x0 + 20) * SS, 158 * SS), "STEP METRICS", font=MONO(12), fill=PAL["muted"], anchor="ls")
    y = 200
    for r, c in zip(w["runs"], colors):
        m = r["metrics"]
        d.rectangle([(x0 + 20) * SS, (y - 8) * SS, (x0 + 32) * SS, (y + 4) * SS], fill=c)
        d.text(((x0 + 42) * SS, y * SS), r["label"], font=SANS_B(15), fill=PAL["text"], anchor="lm")
        rows = [("overshoot", f"{m['overshoot']:.1f} %"), ("settling 2 %", f"{m['settle']:.0f} s"), ("ITAE", f"{m['itae']:.0f}")]
        for i, (k, v) in enumerate(rows):
            yy = y + 30 + i * 24
            d.text(((x0 + 42) * SS, yy * SS), k, font=MONO(12), fill=PAL["faint"], anchor="lm")
            d.text(((W - 52) * SS, yy * SS), v, font=MONO(14), fill=c, anchor="rm")
        y += 140
    note = ["Without anti-windup the integrator keeps", "growing while the heater is pinned at",
            "100 %, then has to unwind: big overshoot.", "Clamping freezes I while saturated;",
            "back-calculation bleeds it off with Tt."]
    for i, line in enumerate(note):
        d.text(((x0 + 20) * SS, (628 + i * 22) * SS), line, font=SANS(13), fill=PAL["muted"], anchor="lm")
    return save(img, "windup.png")


def fig_ppid(data):
    W, H = 1400, 820
    p = data["ppid"]
    img, d = canvas(W, H, "What P, I and D each do",
                    f"{p['plant']}: step {p['step'][0]} → {p['step'][1]} m with the same Kp, adding I and then D (thrust limited to 0-20 N)")
    colors = [PAL["copper"], PAL["signal"], PAL["led"]]
    T = p["runs"][0]["t"][-1]
    a = Axes(d, (90, 130, 960, 470), (0, T), (0, 7), "Altitude [m]")
    a.line([0, T], [p["step"][1]] * 2, PAL["muted"], 1.6, dash=(6, 5))
    for r, c in zip(p["runs"], colors):
        a.line(r["t"], r["yTrue"], c, 2.4)
    b = Axes(d, (90, 540, 960, 760), (0, T), (-2, 22), "Thrust u [N]", xlabel="time [s]")
    b.line([0, T], [20, 20], PAL["warn"], 1.2, dash=(4, 4))
    b.line([0, T], [9.81, 9.81], PAL["faint"], 1.2, dash=(2, 4))
    for r, c in zip(p["runs"], colors):
        b.line(r["t"], r["u"], c, 2.0)
    legend(d, 90, 104, [("setpoint", PAL["muted"], True)] + [
        (f"{r['label']}  (Kp {r['pid']['Kp']}, Ki {r['pid']['Ki']}, Kd {r['pid']['Kd']})", c, False) for r, c in zip(p["runs"], colors)])
    x0 = 1000
    d.rectangle([x0 * SS, 130 * SS, (W - 32) * SS, 760 * SS], fill=PAL["surface"], outline=PAL["border"], width=SS)
    texts = [
        ("P", "reacts to the present error. Alone it leaves", "an offset (hover needs m·g = 9.81 N, which P", "only gives while e ≠ 0) and barely damps."),
        ("+ I", "accumulates past error until the offset", "is gone - but its phase lag destabilises", "this loop: the oscillation grows."),
        ("+ D", "reacts to the trend (rate of change of", "the measurement) and adds damping:", "fast, settled, no overshoot."),
    ]
    y = 170
    for (head, *lines), r, c in zip(texts, p["runs"], colors):
        m = r["metrics"]
        d.text(((x0 + 20) * SS, y * SS), head, font=SANS_B(17), fill=c, anchor="lm")
        settle = "never" if m["settle"] is None or m["settle"] > 1e9 else f"{m['settle']:.1f} s"
        d.text(((W - 52) * SS, y * SS), f"OS {m['overshoot']:.0f} %  ·  SSE {abs(m['sse']) if abs(m['sse']) < 0.005 else m['sse']:.2f} m  ·  settle {settle}",
               font=MONO(11), fill=PAL["muted"], anchor="rm")
        for i, line in enumerate(lines):
            d.text(((x0 + 20) * SS, (y + 28 + i * 21) * SS), line, font=SANS(13), fill=PAL["text"], anchor="lm")
        y += 190
    return save(img, "p-pi-pid.png")


def fig_relay(data):
    W, H = 1400, 820
    r = data["relay"]
    tr = r["trace"]
    img, d = canvas(W, H, "Relay-feedback autotune (Åström-Hägglund)",
                    f"{r['plant']}: relay u = {tr['bias']:.2f} ± {tr['h']:g} N around hover thrust → limit cycle → Ku, Tu → Ziegler-Nichols gains")
    T = tr["t"][-1]
    a = Axes(d, (90, 130, 960, 420), (0, T), (0, 7), "Relay experiment: altitude [m]")
    a.d.rectangle([a.X(tr["tStart"]), a.box[1] + SS, a.X(tr["tEnd"]), a.box[3] - SS], fill=(20, 38, 30))
    a.line([0, T], [5, 5], PAL["signal"], 1.4, dash=(6, 5))
    a.line(tr["t"], tr["y"], PAL["led"], 2.2)
    a.d.text((a.X((tr["tStart"] + tr["tEnd"]) / 2), a.box[1] + 14 * SS), "measured cycles", font=MONO(11), fill=PAL["muted"], anchor="mt")
    b = Axes(d, (90, 470, 960, 560), (0, T), (0, 20), "Relay output u [N]")
    b.line(tr["t"], tr["u"], PAL["copper"], 2.0)
    colors = [PAL["led"], PAL["copper"]]
    T2 = r["after"][0]["t"][-1]
    c = Axes(d, (90, 620, 960, 770), (0, T2), (0, 7), "Step response with the tuned gains [m]", xlabel="time [s]")
    c.line([0, T2], [5, 5], PAL["muted"], 1.4, dash=(6, 5))
    for run, col in zip(r["after"], colors):
        c.line(run["t"], run["yTrue"], col, 2.2)
    x0 = 1000
    d.rectangle([x0 * SS, 130 * SS, (W - 32) * SS, 770 * SS], fill=PAL["surface"], outline=PAL["border"], width=SS)
    lines = [
        ("RESULT", None), (f"Tu = {tr['Tu']:.3f} s", PAL["text"]), (f"a  = {tr['a']:.3f} m", PAL["text"]),
        (f"Ku = {tr['Ku']:.2f} N/m", PAL["copper_bright"]), ("", None),
        ("GAINS", None),
    ]
    y = 165
    for text, col in lines:
        if col is None:
            d.text(((x0 + 20) * SS, y * SS), text, font=MONO(12), fill=PAL["muted"], anchor="lm")
        else:
            d.text(((x0 + 20) * SS, y * SS), text, font=MONO(16), fill=col, anchor="lm")
        y += 30
    for run, col in zip(r["after"], colors):
        g, m = run["pid"], run["metrics"]
        d.text(((x0 + 20) * SS, y * SS), run["label"], font=SANS_B(14), fill=col, anchor="lm")
        d.text(((x0 + 20) * SS, (y + 24) * SS), f"Kp {g['Kp']:.2f}  Ki {g['Ki']:.2f}  Kd {g['Kd']:.2f}", font=MONO(13), fill=PAL["text"], anchor="lm")
        settle = "> 10 s" if m["settle"] is None or m["settle"] > 1e9 else f"{m['settle']:.1f} s"
        d.text(((x0 + 20) * SS, (y + 46) * SS), f"overshoot {m['overshoot']:.0f} %, settling {settle}", font=MONO(12), fill=PAL["muted"], anchor="lm")
        y += 90
    for i, t in enumerate(["ZN aims for quarter-amplitude decay:", "fast but lively. Tyreus-Luyben is the", "conservative choice."]):
        d.text(((x0 + 20) * SS, (y + 10 + i * 21) * SS), t, font=SANS(13), fill=PAL["muted"], anchor="lm")
    return save(img, "relay-autotune.png")


def main():
    with open(os.path.join(DOCS, "figure-data.json"), encoding="utf-8") as f:
        data = json.load(f)
    # JSON can't hold Infinity: JS wrote null for never-settling runs.
    fig_windup(data)
    fig_ppid(data)
    fig_relay(data)
    return 0


if __name__ == "__main__":
    sys.exit(main())
