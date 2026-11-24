"""make_figures.py - render the README figures from docs/figdata.json (real
training output exported by scripts/export-figdata.js) using only Pillow.

    node scripts/export-figdata.js
    python scripts/make_figures.py [--jpeg-dir ../../images/projects/digit-recognizer]

Writes docs/{training-curves,confusion-matrix,preprocessing,first-layer-weights}.png
and, with --jpeg-dir, a JPEG copy of each (quality 82) for the portfolio site.
Colours are the portfolio's circuit-board theme tokens.
"""
import argparse
import json
import math
import os

from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
DOCS = os.path.join(ROOT, "docs")

# circuit-board theme (dark)
BG = (7, 17, 12)
BG_ALT = (10, 23, 17)
SURFACE = (14, 29, 22)
SURFACE2 = (19, 38, 29)
BORDER = (31, 46, 38)          # rgba(196,228,208,.10) over SURFACE
BORDER_STRONG = (49, 64, 56)
TEXT = (232, 240, 234)
MUTED = (159, 181, 168)
FAINT = (111, 134, 121)
COPPER = (224, 164, 88)
LED = (62, 224, 143)
SIGNAL = (79, 209, 197)


def font(size, mono=False, bold=False):
    names = (["consolab.ttf", "consola.ttf"] if bold else ["consola.ttf"]) if mono else \
        (["segoeuib.ttf", "seguisb.ttf", "segoeui.ttf"] if bold else ["segoeui.ttf"])
    for n in names + ["DejaVuSansMono.ttf" if mono else "DejaVuSans.ttf"]:
        for d in ["C:/Windows/Fonts", "/usr/share/fonts/truetype/dejavu", "/Library/Fonts"]:
            p = os.path.join(d, n)
            if os.path.exists(p):
                return ImageFont.truetype(p, size)
    return ImageFont.load_default(size)


def mix(a, b, t):
    t = max(0.0, min(1.0, t))
    return tuple(int(round(a[i] + (b[i] - a[i]) * t)) for i in range(3))


def silk(d, xy, text, size=15, fill=FAINT):
    """Small uppercase monospace label with wide letter-spacing (.12em)."""
    f = font(size, mono=True, bold=True)
    x, y = xy
    for ch in text.upper():
        d.text((x, y), ch, font=f, fill=fill)
        x += d.textlength(ch, font=f) + size * 0.12
    return x


def card(img, box, title=None, ref=None):
    d = ImageDraw.Draw(img)
    d.rounded_rectangle(box, radius=14, fill=SURFACE, outline=BORDER, width=1)
    x0, y0 = box[0], box[1]
    for cx in (x0 + 12, box[2] - 19):
        d.rounded_rectangle((cx, y0 + 12, cx + 7, y0 + 19), radius=2, fill=mix(SURFACE, COPPER, 0.55))
    if title:
        x = x0 + 30
        if ref:
            x = silk(d, (x, y0 + 9), ref, fill=COPPER) + 10
        silk(d, (x, y0 + 9), title, fill=MUTED)


def gray_image(data, w, h, color=TEXT, bg=BG_ALT):
    im = Image.new("RGB", (w, h))
    px = im.load()
    for y in range(h):
        for x in range(w):
            px[x, y] = mix(bg, color, data[y * w + x] / 255)
    return im


# ------------------------------------------------------------------ training curves
def training_curves(fd, out):
    m = fd["metrics"]
    curves = m["curves"]
    W, H = 1440, 640
    img = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(img)
    epochs = [c["epoch"] for c in curves]
    panels = [
        ("Cross-entropy loss", "LOSS", [("train", [c["trainLossClean"] for c in curves], COPPER, True),
                                         ("validation", [c["valLoss"] for c in curves], SIGNAL, False)], None),
        ("Accuracy (%)", "ACC", [("train", [100 * c["trainAcc"] for c in curves], COPPER, True),
                                  ("validation", [100 * c["valAcc"] for c in curves], SIGNAL, False)], m["testAccuracy"]),
    ]
    f_tick = font(15, mono=True)
    f_lab = font(17)
    for pi, (title, ref, series, test_acc) in enumerate(panels):
        bx0 = 24 + pi * (W - 24) // 2
        bx1 = bx0 + (W - 24) // 2 - 24
        card(img, (bx0, 24, bx1, H - 24), title, f"FIG {pi + 1}")
        px0, py0, px1, py1 = bx0 + 78, 118, bx1 - 150, H - 84
        allv = [v for _, ys, _, _ in series for v in ys]
        if test_acc is not None:
            lo, hi, nt = 94.0, 100.0, 6
        else:
            lo, hi, nt = 0.0, math.ceil(max(allv) * 20) / 20, 5
        for i in range(nt + 1):  # recessive grid
            v = lo + (hi - lo) * i / nt
            y = py1 - (py1 - py0) * i / nt
            d.line((px0, y, px1, y), fill=BORDER, width=1)
            lab = f"{v:.1f}" if test_acc is not None else f"{v:.2f}"
            d.text((px0 - 12, y), lab, font=f_tick, fill=FAINT, anchor="rm")
        n = len(epochs)
        sx = lambda e: px0 + (px1 - px0) * (e - 1) / max(1, n - 1)
        sy = lambda v: py1 - (py1 - py0) * (min(max(v, lo), hi) - lo) / (hi - lo)
        for e in epochs:
            if e == 1 or e % 5 == 0:
                d.text((sx(e), py1 + 12), str(e), font=f_tick, fill=FAINT, anchor="mt")
        d.text(((px0 + px1) / 2, py1 + 38), "epoch", font=f_lab, fill=MUTED, anchor="mt")
        # best epoch marker
        be = m["bestEpoch"]
        for y in range(int(py0), int(py1), 10):
            d.line((sx(be), y, sx(be), y + 5), fill=BORDER_STRONG, width=1)
        d.text((sx(be), py0 - 6), f"best val · epoch {be}", font=font(13, mono=True), fill=FAINT, anchor="mb")
        if test_acc is not None:
            ty = sy(test_acc)
            for x in range(int(px0), int(px1), 12):
                d.line((x, ty, min(x + 6, px1), ty), fill=LED, width=2)
            d.text((px1 + 10, ty), f"test {test_acc:.2f}%", font=font(15, mono=True), fill=TEXT, anchor="lm")
        for name, ys, col, dashed in series:
            pts = [(sx(e), sy(v)) for e, v in zip(epochs, ys)]
            if dashed:  # secondary encoding: train dashed, validation solid
                for (x0_, y0_), (x1_, y1_) in zip(pts, pts[1:]):
                    seg = 8
                    L = math.hypot(x1_ - x0_, y1_ - y0_)
                    k = 0.0
                    while k < L:
                        a, b = k / L, min(1, (k + seg) / L)
                        d.line((x0_ + (x1_ - x0_) * a, y0_ + (y1_ - y0_) * a, x0_ + (x1_ - x0_) * b, y0_ + (y1_ - y0_) * b), fill=col, width=3)
                        k += seg * 1.8
            else:
                d.line(pts, fill=col, width=3, joint="curve")
            ex, ey = pts[-1]
            d.ellipse((ex - 5, ey - 5, ex + 5, ey + 5), fill=col, outline=SURFACE, width=2)
            label_y = ey + (14 if name == "train" and test_acc is None else -14 if name == "train" else 14)
            if test_acc is None:
                label_y = ey - 14 if name == "validation" else ey + 14
            d.text((ex + 12, label_y), f"{name} {ys[-1]:.3f}" if test_acc is None else f"{name} {ys[-1]:.2f}",
                   font=font(15, mono=True), fill=TEXT, anchor="lm")
        # legend
        lx = px0
        for name, _, col, dashed in series:
            if dashed:
                d.line((lx, py0 - 40, lx + 8, py0 - 40), fill=col, width=3)
                d.line((lx + 14, py0 - 40, lx + 22, py0 - 40), fill=col, width=3)
            else:
                d.line((lx, py0 - 40, lx + 22, py0 - 40), fill=col, width=3)
            d.text((lx + 30, py0 - 40), name, font=f_lab, fill=MUTED, anchor="lm")
            lx += 30 + d.textlength(name, font=f_lab) + 26
    img.save(out)
    return img


# ------------------------------------------------------------------ confusion matrix
def confusion(fd, out):
    m = fd["metrics"]
    cm = m["confusion"]
    pc = m["perClassAccuracy"]
    cell = 70
    W, H = 1040, 1000
    img = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(img)
    card(img, (24, 24, W - 24, H - 24), f"Confusion matrix · MNIST test set · {m['testAccuracy']:.2f}%", "FIG 3")
    gx, gy = 150, 140
    off = [cm[t][p] for t in range(10) for p in range(10) if t != p]
    mx = max(off) if off else 1
    f_num = font(19, mono=True)
    f_ax = font(20, mono=True, bold=True)
    for t in range(10):
        d.text((gx - 22, gy + t * cell + cell / 2), str(t), font=f_ax, fill=MUTED, anchor="rm")
        d.text((gx + t * cell + cell / 2, gy - 18), str(t), font=f_ax, fill=MUTED, anchor="mb")
        for p in range(10):
            x, y = gx + p * cell, gy + t * cell
            v = cm[t][p]
            if t == p:
                fill, tc = SURFACE2, LED
            elif v == 0:
                fill, tc = BG_ALT, None
            else:
                k = math.sqrt(v / mx)
                fill, tc = mix(BG_ALT, COPPER, 0.15 + 0.85 * k), (BG if k > 0.55 else TEXT)
            d.rounded_rectangle((x + 2, y + 2, x + cell - 2, y + cell - 2), radius=5, fill=fill)
            if tc:
                d.text((x + cell / 2, y + cell / 2), str(v), font=f_num if t != p else font(17, mono=True, bold=True), fill=tc, anchor="mm")
    # per-class accuracy column
    ax = gx + 10 * cell + 26
    silk(d, (ax, gy - 34), "recall", size=14)
    for t in range(10):
        a = pc[t]
        y = gy + t * cell + cell / 2
        d.text((ax, y), f"{a:.1f}%", font=font(18, mono=True), fill=TEXT if a >= 98 else COPPER, anchor="lm")
    d.text((gx + 5 * cell, gy + 10 * cell + 22), "predicted digit", font=font(19), fill=MUTED, anchor="mt")
    # y-axis label, rotated 90°: drawn on a small image, then pasted
    tmp = Image.new("RGB", (200, 34), SURFACE)
    ImageDraw.Draw(tmp).text((100, 17), "true digit", font=font(19), fill=MUTED, anchor="mm")
    img.paste(tmp.rotate(90, expand=True), (gx - 120, gy + 5 * cell - 100))
    d.text((48, H - 64), "Diagonal: correct (green). Off-diagonal: errors, copper intensity grows with √count.",
           font=font(17), fill=FAINT)
    img.save(out)
    return img


# ------------------------------------------------------------------ preprocessing
def preprocessing(fd, out):
    p = fd["preprocess"]
    W, H = 1440, 660
    img = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(img)
    card(img, (24, 24, W - 24, H - 24), "Preprocessing: canvas drawing → MNIST-style input", "FIG 4")
    S = 300
    top = 110
    xs = [60, 420, 760, 1090]
    titles = ["1 · raw drawing 448×448", "2 · crop + stroke width", "3 · area-scaled to 20 px", "4 · centred by COM 28×28"]
    # 1 raw with bounding box
    raw = gray_image(p["raw"]["data"], p["raw"]["w"], p["raw"]["h"]).resize((S, S), Image.LANCZOS)
    img.paste(raw, (xs[0], top))
    s = S / p["raw"]["w"]
    b = p["bbox"]
    d.rectangle((xs[0] + b["x"] * s, top + b["y"] * s, xs[0] + (b["x"] + b["w"]) * s, top + (b["y"] + b["h"]) * s), outline=COPPER, width=2)
    # 2 crop (after stroke normalisation), fit into S
    c = p["crop"]
    sc = S / max(c["w"], c["h"])
    crop = gray_image(c["data"], c["w"], c["h"]).resize((max(1, round(c["w"] * sc)), max(1, round(c["h"] * sc))), Image.LANCZOS)
    d.rectangle((xs[1], top, xs[1] + S, top + S), fill=BG_ALT)
    img.paste(crop, (xs[1] + (S - crop.width) // 2, top + (S - crop.height) // 2))
    # 3 20-px box, nearest-neighbour so pixels are visible
    bx = p["box"]
    cellsz = S // 20
    boxim = gray_image(bx["data"], bx["w"], bx["h"]).resize((bx["w"] * cellsz, bx["h"] * cellsz), Image.NEAREST)
    d.rectangle((xs[2], top, xs[2] + S, top + S), fill=BG_ALT)
    img.paste(boxim, (xs[2] + (S - boxim.width) // 2, top + (S - boxim.height) // 2))
    # 4 final 28x28 in LED colour with COM crosshair
    fin = gray_image(p["final"], 28, 28, color=LED).resize((28 * 11, 28 * 11), Image.NEAREST)
    img.paste(fin, (xs[3], top))
    S4 = 28 * 11
    cx = xs[3] + 14 * 11
    cy = top + 14 * 11
    for k in range(0, S4, 8):
        d.line((cx, top + k, cx, top + min(k + 4, S4)), fill=COPPER, width=1)
        d.line((xs[3] + k, cy, xs[3] + min(k + 4, S4), cy), fill=COPPER, width=1)
    for i, t in enumerate(titles):
        silk(d, (xs[i], top - 34), t, size=14, fill=MUTED)
    # arrows
    for i in range(3):
        ax = xs[i] + S + 14 if i else xs[0] + S + 14
        ay = top + S / 2
        ex = xs[i + 1] - 14
        d.line((ax, ay, ex, ay), fill=BORDER_STRONG, width=2)
        d.polygon([(ex, ay), (ex - 9, ay - 6), (ex - 9, ay + 6)], fill=BORDER_STRONG)
    # captions
    st = p["stroke"]
    probs = p["probs"]
    pred = max(range(10), key=lambda i: probs[i])
    caps = [
        f"bounding box {b['w']}×{b['h']} px",
        f"stroke {st['before']:.1f} px → {st['target']:.1f} px target (r = {st['radius']:+d})",
        f"{bx['w']}×{bx['h']} px, aspect ratio kept",
        f"COM ({p['com']['x']:.1f}, {p['com']['y']:.1f}) → (14, 14) · predicted {pred} ({100 * probs[pred]:.1f}%)",
    ]
    f_cap = font(16)
    for i, t in enumerate(caps):
        d.text((xs[i], top + S + 18), t, font=f_cap, fill=TEXT if i == 3 else MUTED)
    # real MNIST comparison strip
    yy = top + S + 70
    silk(d, (60, yy + 30), "real mnist test 4s for comparison", size=14, fill=FAINT)
    for i, digit in enumerate(p["mnist"]):
        t = gray_image(digit, 28, 28, color=LED).resize((112, 112), Image.NEAREST)
        img.paste(t, (520 + i * 136, yy))
    img.save(out)
    return img


# ------------------------------------------------------------------ first-layer weights
def weights(fd, out):
    ws = fd["weights"]
    tile, gap, cols = 140, 14, 8
    rows = math.ceil(len(ws) / cols)
    W = 48 + cols * tile + (cols - 1) * gap + 48
    H = 110 + rows * (tile + gap + 22) + 70
    img = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(img)
    card(img, (24, 24, W - 24, H - 24), "First-layer weights · 32 of 256 hidden units", "FIG 5")
    for i, u in enumerate(ws):
        w = u["w"]
        m = max(abs(v) for v in w) or 1
        im = Image.new("RGB", (28, 28))
        px = im.load()
        for k, v in enumerate(w):
            t = v / m
            px[k % 28, k // 28] = mix(BG_ALT, COPPER, t) if t >= 0 else mix(BG_ALT, SIGNAL, -t)
        im = im.resize((tile, tile), Image.NEAREST)
        x = 48 + (i % cols) * (tile + gap)
        y = 96 + (i // cols) * (tile + gap + 22)
        img.paste(im, (x, y))
        d.text((x, y + tile + 4), f"h{u['unit']}", font=font(13, mono=True), fill=FAINT)
    # diverging legend
    lx, ly = 48, H - 64
    for k in range(200):
        t = k / 199 * 2 - 1
        col = mix(BG_ALT, COPPER, t) if t >= 0 else mix(BG_ALT, SIGNAL, -t)
        d.line((lx + k, ly, lx + k, ly + 12), fill=col)
    f = font(15)
    d.text((lx, ly + 18), "negative", font=f, fill=MUTED)
    d.text((lx + 100, ly + 18), "0", font=f, fill=MUTED, anchor="mt")
    d.text((lx + 200, ly + 18), "positive", font=f, fill=MUTED, anchor="rt")
    d.text((lx + 230, ly + 2), "Each tile is one neuron's 784 input weights as a 28×28 image (scaled per tile): it fires for ink on copper, is suppressed by ink on teal.",
           font=f, fill=FAINT)
    img.save(out)
    return img


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--jpeg-dir", default=None)
    args = ap.parse_args()
    with open(os.path.join(DOCS, "figdata.json"), encoding="utf-8") as fh:
        fd = json.load(fh)
    figs = {
        "training-curves": training_curves,
        "confusion-matrix": confusion,
        "preprocessing": preprocessing,
        "first-layer-weights": weights,
    }
    for name, fn in figs.items():
        im = fn(fd, os.path.join(DOCS, f"{name}.png"))
        print(f"docs/{name}.png  {im.width}x{im.height}")
        if args.jpeg_dir:
            os.makedirs(args.jpeg_dir, exist_ok=True)
            if im.width > 1440:
                im = im.resize((1440, round(im.height * 1440 / im.width)), Image.LANCZOS)
            im.save(os.path.join(args.jpeg_dir, f"{name}.jpg"), quality=82, optimize=True, progressive=True)


if __name__ == "__main__":
    main()
