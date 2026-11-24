/**
 * LineChart - a small <canvas> time-series chart, no library.
 *
 * Draws: threshold "danger zones" (shaded outside the safe range) with dashed limit lines,
 * visit spans (vertical bands), a line for raw points or a min-max band + avg line for
 * downsampled buckets, gaps where data is missing, axes, and a hover read-out.
 * Colours come from CSS custom properties, so the chart follows the theme.
 */
const PAD = { l: 44, r: 12, t: 10, b: 22 };
const TIME_STEPS = [5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 10800, 21600].map((s) => s * 1000);

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#888';
}

/** Picks a "nice" step (1/2/2.5/5 x 10^n) for about `count` ticks. */
function niceStep(range, count) {
  const raw = range / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  return (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10) * mag;
}

const two = (n) => String(n).padStart(2, '0');
function timeLabel(ts, stepMs) {
  const d = new Date(ts);
  const hm = `${two(d.getHours())}:${two(d.getMinutes())}`;
  return stepMs < 60_000 ? `${hm}:${two(d.getSeconds())}` : hm;
}

export class LineChart {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {{unit:string, decimals:number, color:string, minSpan?:number}} opts color = CSS var name
   */
  constructor(canvas, opts) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.opts = { unit: '', decimals: 1, color: '--accent', ...opts };
    this.data = { points: [], kind: 'raw', from: Date.now() - 60_000, to: Date.now() };
    this.hoverX = null;
    new ResizeObserver(() => this.draw()).observe(canvas);
    canvas.addEventListener('pointermove', (e) => {
      this.hoverX = e.offsetX;
      this.draw();
    });
    canvas.addEventListener('pointerleave', () => {
      this.hoverX = null;
      this.draw();
    });
  }

  /**
   * @param {object} d
   * @param {'raw'|'bucket'} d.kind   raw: [{t, v}] - bucket: [{t, min, avg, max}] (t = bucket start)
   * @param {number} d.from, d.to     visible window (ms)
   * @param {number} [d.low], [d.high] safe range; outside is shaded
   * @param {{from:number,to:number,kind:string}[]} [d.spans] visit bands
   * @param {number} [d.bucketMs]
   */
  setData(d) {
    this.data = d;
    this.draw();
  }

  #yRange(values) {
    const { low, high } = this.data;
    let min = Math.min(...values);
    let max = Math.max(...values);
    if (!values.length) {
      min = low ?? 0;
      max = high ?? 1;
    }
    // A minimum span keeps sensor noise from being magnified into dramatic zig-zags.
    const minSpan = this.opts.minSpan ?? 0;
    if (max - min < minSpan) {
      const mid = (max + min) / 2;
      min = mid - minSpan / 2;
      max = mid + minSpan / 2;
    }
    // Include the thresholds when they are reasonably close, so the bands give context.
    const span = Math.max(max - min, 1e-6);
    if (low != null && low > min - span * 1.5) min = Math.min(min, low);
    if (high != null && high < max + span * 1.5) max = Math.max(max, high);
    if (max - min < 1e-6) {
      min -= 1;
      max += 1;
    }
    const pad = (max - min) * 0.08;
    return [min - pad, max + pad];
  }

  draw() {
    const { canvas, ctx } = this;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (!w || !h) return;
    const dpr = window.devicePixelRatio || 1;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const colors = {
      line: cssVar(this.opts.color),
      grid: cssVar('--grid'),
      muted: cssVar('--muted'),
      danger: cssVar('--danger'),
      warn: cssVar('--warn'),
      span: cssVar('--accent-2'),
      text: cssVar('--text'),
      surface: cssVar('--surface-2'),
    };
    const { points, kind, from, to, low, high, spans = [], bucketMs = 0 } = this.data;
    const isBucket = kind === 'bucket';
    const values = isBucket ? points.flatMap((p) => [p.min, p.max]) : points.filter((p) => p.v != null).map((p) => p.v);
    const [y0, y1] = this.#yRange(values);

    const plotW = w - PAD.l - PAD.r;
    const plotH = h - PAD.t - PAD.b;
    const xOf = (t) => PAD.l + ((t - from) / (to - from)) * plotW;
    const yOf = (v) => PAD.t + (1 - (v - y0) / (y1 - y0)) * plotH;
    const tOfPoint = (p) => (isBucket ? p.t + bucketMs / 2 : p.t);

    ctx.font = '11px Inter, system-ui, sans-serif';
    ctx.textBaseline = 'middle';

    // Danger zones outside the safe range.
    ctx.save();
    ctx.beginPath();
    ctx.rect(PAD.l, PAD.t, plotW, plotH);
    ctx.clip();
    ctx.fillStyle = colors.danger;
    ctx.globalAlpha = 0.07;
    if (high != null && high < y1) ctx.fillRect(PAD.l, PAD.t, plotW, yOf(high) - PAD.t);
    if (low != null && low > y0) ctx.fillRect(PAD.l, yOf(low), plotW, PAD.t + plotH - yOf(low));

    // Visit spans.
    ctx.fillStyle = colors.span;
    ctx.globalAlpha = 0.1;
    for (const s of spans) {
      const a = Math.max(PAD.l, xOf(s.from));
      const b = Math.min(PAD.l + plotW, xOf(s.to));
      if (b > a - 1) ctx.fillRect(a, PAD.t, Math.max(2, b - a), plotH);
    }
    ctx.restore();

    // Horizontal grid + y labels.
    const step = niceStep(y1 - y0, 4);
    ctx.strokeStyle = colors.grid;
    ctx.lineWidth = 1;
    ctx.fillStyle = colors.muted;
    ctx.textAlign = 'right';
    const decimals = step < 0.1 ? 2 : step < 1 ? 1 : 0;
    for (let v = Math.ceil(y0 / step) * step; v <= y1; v += step) {
      const y = Math.round(yOf(v)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(PAD.l, y);
      ctx.lineTo(PAD.l + plotW, y);
      ctx.stroke();
      ctx.fillText(v.toFixed(decimals), PAD.l - 6, y);
    }

    // Time axis.
    const tStep = TIME_STEPS.find((s) => (to - from) / s <= Math.max(2, Math.floor(plotW / 90))) ?? TIME_STEPS.at(-1);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    const tzOffset = new Date(from).getTimezoneOffset() * 60_000; // align ticks to local clock
    for (let t = Math.ceil((from - tzOffset) / tStep) * tStep + tzOffset; t <= to; t += tStep) {
      const x = xOf(t);
      if (x < PAD.l + 14 || x > PAD.l + plotW - 14) continue;
      ctx.fillText(timeLabel(t, tStep), x, PAD.t + plotH + 6);
    }

    // Threshold lines.
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = colors.warn;
    ctx.globalAlpha = 0.8;
    for (const lim of [low, high]) {
      if (lim == null || lim < y0 || lim > y1) continue;
      const y = Math.round(yOf(lim)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(PAD.l, y);
      ctx.lineTo(PAD.l + plotW, y);
      ctx.stroke();
    }
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;

    if (!points.length) {
      ctx.fillStyle = colors.muted;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('Waiting for data…', PAD.l + plotW / 2, PAD.t + plotH / 2);
      return;
    }

    // Series, split into segments where data is missing for longer than gapMs
    // (a single failed read is bridged; a long outage or a sensor fault shows as a gap).
    const gapMs = isBucket ? bucketMs * 2.5 : 15_000;
    const segments = [];
    let seg = [];
    let prevT = null;
    for (const p of points) {
      const v = isBucket ? p.avg : p.v;
      if (v == null) continue;
      const t = tOfPoint(p);
      if (prevT != null && t - prevT > gapMs && seg.length) {
        segments.push(seg);
        seg = [];
      }
      seg.push(p);
      prevT = t;
    }
    if (seg.length) segments.push(seg);

    ctx.save();
    ctx.beginPath();
    ctx.rect(PAD.l, PAD.t, plotW, plotH);
    ctx.clip();
    ctx.lineJoin = 'round';
    for (const s of segments) {
      if (isBucket) {
        // min-max band
        ctx.beginPath();
        s.forEach((p, i) => (i ? ctx.lineTo(xOf(tOfPoint(p)), yOf(p.max)) : ctx.moveTo(xOf(tOfPoint(p)), yOf(p.max))));
        for (let i = s.length - 1; i >= 0; i--) ctx.lineTo(xOf(tOfPoint(s[i])), yOf(s[i].min));
        ctx.closePath();
        ctx.fillStyle = colors.line;
        ctx.globalAlpha = 0.2;
        ctx.fill();
      } else {
        // soft area under the line
        const grad = ctx.createLinearGradient(0, PAD.t, 0, PAD.t + plotH);
        grad.addColorStop(0, colors.line);
        grad.addColorStop(1, 'transparent');
        ctx.beginPath();
        s.forEach((p, i) => (i ? ctx.lineTo(xOf(p.t), yOf(p.v)) : ctx.moveTo(xOf(p.t), yOf(p.v))));
        ctx.lineTo(xOf(s.at(-1).t), PAD.t + plotH);
        ctx.lineTo(xOf(s[0].t), PAD.t + plotH);
        ctx.closePath();
        ctx.fillStyle = grad;
        ctx.globalAlpha = 0.14;
        ctx.fill();
      }
      ctx.globalAlpha = 1;
      ctx.beginPath();
      s.forEach((p, i) => {
        const x = xOf(tOfPoint(p));
        const y = yOf(isBucket ? p.avg : p.v);
        if (i) ctx.lineTo(x, y);
        else ctx.moveTo(x, y);
      });
      ctx.strokeStyle = colors.line;
      ctx.lineWidth = 1.75;
      ctx.stroke();
    }
    ctx.restore();

    // Latest value marker.
    const last = segments.at(-1)?.at(-1);
    if (last) {
      ctx.beginPath();
      ctx.arc(xOf(tOfPoint(last)), yOf(isBucket ? last.avg : last.v), 3.5, 0, Math.PI * 2);
      ctx.fillStyle = colors.line;
      ctx.fill();
    }

    this.#drawHover(points, { xOf, yOf, tOfPoint, isBucket, plotH, plotW, colors, from, to });
  }

  #drawHover(points, { xOf, yOf, tOfPoint, isBucket, plotH, plotW, colors, from, to }) {
    if (this.hoverX == null || this.hoverX < PAD.l || this.hoverX > PAD.l + plotW) return;
    const { ctx } = this;
    const t = from + ((this.hoverX - PAD.l) / plotW) * (to - from);
    let best = null;
    for (const p of points) {
      const v = isBucket ? p.avg : p.v;
      if (v == null) continue;
      if (!best || Math.abs(tOfPoint(p) - t) < Math.abs(tOfPoint(best) - t)) best = p;
    }
    if (!best) return;
    const x = xOf(tOfPoint(best));
    const v = isBucket ? best.avg : best.v;
    ctx.strokeStyle = colors.muted;
    ctx.globalAlpha = 0.5;
    ctx.beginPath();
    ctx.moveTo(x + 0.5, PAD.t);
    ctx.lineTo(x + 0.5, PAD.t + plotH);
    ctx.stroke();
    ctx.globalAlpha = 1;

    const d = this.opts.decimals;
    const time = new Date(tOfPoint(best)).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const text = isBucket
      ? `${time}  avg ${v.toFixed(d)} (${best.min.toFixed(d)}–${best.max.toFixed(d)}) ${this.opts.unit}`
      : `${time}  ${v.toFixed(d)} ${this.opts.unit}`;
    ctx.font = '12px Inter, system-ui, sans-serif';
    const tw = ctx.measureText(text).width + 14;
    const bx = Math.min(Math.max(PAD.l, x - tw / 2), PAD.l + plotW - tw);
    ctx.fillStyle = colors.surface;
    ctx.strokeStyle = colors.grid;
    ctx.beginPath();
    ctx.roundRect(bx, PAD.t + 2, tw, 22, 6);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = colors.text;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, bx + 7, PAD.t + 13);
    ctx.beginPath();
    ctx.arc(x, yOf(v), 4, 0, Math.PI * 2);
    ctx.fillStyle = colors.line;
    ctx.fill();
  }
}
