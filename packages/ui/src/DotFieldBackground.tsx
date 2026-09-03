import { useEffect, useRef } from "react";

/* Faithful port of the DotFieldBackground canvas from
   docs/Rama/uploads/design-system.html ("DOT-FIELD CANVAS — faithful port of
   DotFieldBackground"): a 14px grid where fBm noise reveals clusters of 1px
   dots, and short dashes "hop" between neighbouring live cells. Reads its
   color from the `--dot-field-color` token (see tokens.css) and re-samples
   it whenever data-rtheme changes on <html>. */

const GRID = 14;
const DOT = 1;
const DASH_LEN = 7;
const MAX_CHAINS = 6;
const HOP_MS = 1000;
const MORPH_FRAC = 0.28;
const SPAWN_MIN_MS = 160;
const SPAWN_MAX_MS = 420;
const MAX_CHAIN_HOPS = 6;
const SPAWN_BURST = 2;

type Chain = {
  fromCol: number;
  fromRow: number;
  toCol: number;
  toRow: number;
  axis: "h" | "v";
  t: number;
  hopsLeft: number;
};

function createNoise(seed = 0x5f3759df) {
  const perm = new Uint8Array(512);
  const src = new Uint8Array(256);
  for (let i = 0; i < 256; i++) src[i] = i;
  let s = seed >>> 0;
  for (let i = 255; i > 0; i--) {
    s = (s * 1664525 + 1013904223) >>> 0;
    const j = s % (i + 1);
    const t = src[i];
    src[i] = src[j];
    src[j] = t;
  }
  for (let i = 0; i < 512; i++) perm[i] = src[i & 255];
  const grad = [
    [1, 1], [-1, 1], [1, -1], [-1, -1],
    [1, 0], [-1, 0], [0, 1], [0, -1],
  ];
  const dot = (g: number[], x: number, y: number) => g[0] * x + g[1] * y;
  return function noise(x: number, y: number) {
    const xi = Math.floor(x) & 255;
    const yi = Math.floor(y) & 255;
    const xf = x - Math.floor(x);
    const yf = y - Math.floor(y);
    const u = xf * xf * xf * (xf * (xf * 6 - 15) + 10);
    const v = yf * yf * yf * (yf * (yf * 6 - 15) + 10);
    const aa = perm[xi] + yi;
    const ab = perm[xi + 1] + yi;
    const g00 = grad[perm[aa] & 7];
    const g10 = grad[perm[ab] & 7];
    const g01 = grad[perm[aa + 1] & 7];
    const g11 = grad[perm[ab + 1] & 7];
    const x1 = dot(g00, xf, yf);
    const x2 = dot(g10, xf - 1, yf);
    const y1 = x1 + u * (x2 - x1);
    const x3 = dot(g01, xf, yf - 1);
    const x4 = dot(g11, xf - 1, yf - 1);
    const y2 = x3 + u * (x4 - x3);
    return y1 + v * (y2 - y1);
  };
}

function fbm(noise: (x: number, y: number) => number, x: number, y: number, oct = 4) {
  let val = 0;
  let amp = 0.55;
  let fr = 1;
  for (let i = 0; i < oct; i++) {
    val += amp * noise(x * fr, y * fr);
    amp *= 0.5;
    fr *= 2.1;
  }
  return val * 0.5 + 0.5;
}

function smoothstep(e0: number, e1: number, x: number) {
  const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

function easeOutDamped(t: number) {
  const c = Math.max(0, Math.min(1, t));
  return 1 - (1 - c) ** 4 * Math.cos(c * Math.PI * 0.5);
}

function easeInDamped(t: number) {
  const c = Math.max(0, Math.min(1, t));
  return c ** 3;
}

function parseColor(color: string): { rgb: [number, number, number]; alpha: number } {
  const m = color.match(/rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)(?:[,\s/]+([\d.]+))?\s*\)/);
  if (m) return { rgb: [+m[1], +m[2], +m[3]], alpha: m[4] ? +m[4] : 0.3 };
  return { rgb: [255, 255, 255], alpha: 0.3 };
}

function makeDotField(canvas: HTMLCanvasElement) {
  const ctx = canvas.getContext("2d", { alpha: true });
  if (!ctx) return () => {};
  const noise = createNoise();
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  let width = 0;
  let height = 0;
  let dpr = 1;
  let rgb: [number, number, number] = [255, 255, 255];
  let baseAlpha = 0.44;
  let cols = 0;
  let rows = 0;
  let visible = new Set<string>();
  let chains: Chain[] = [];
  let animId = 0;
  let lastTs = 0;
  let nextSpawnAt = 0;

  const key = (c: number, r: number) => `${c},${r}`;
  const center = (c: number, r: number) => ({ x: c * GRID + GRID * 0.5, y: r * GRID + GRID * 0.5 });

  function readTheme() {
    const raw = getComputedStyle(document.documentElement).getPropertyValue("--dot-field-color").trim();
    const p = parseColor(raw);
    rgb = p.rgb;
    baseAlpha = p.alpha;
    if (reduced) draw(0);
  }

  function rebuild() {
    visible = new Set();
    cols = Math.ceil(width / GRID) + 1;
    rows = Math.ceil(height / GRID) + 1;
    const scale = 0.0044;
    const th = 0.57;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const { x, y } = center(c, r);
        let d = fbm(noise, x * scale, y * scale);
        d += fbm(noise, x * scale * 2.2 + 4.2, y * scale * 2.2 - 1.8, 3) * 0.42;
        d /= 1.42;
        if (smoothstep(th - 0.07, th + 0.09, d) >= 0.04) visible.add(key(c, r));
      }
    }
  }

  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    const rect = canvas.getBoundingClientRect();
    width = rect.width;
    height = rect.height;
    canvas.width = Math.ceil(width * dpr);
    canvas.height = Math.ceil(height * dpr);
    ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);
    rebuild();
    chains = [];
    nextSpawnAt = performance.now() + SPAWN_MIN_MS;
  }

  const isVis = (c: number, r: number) => visible.has(key(c, r));

  function busy() {
    const b = new Set<string>();
    for (const ch of chains) {
      b.add(key(ch.fromCol, ch.fromRow));
      b.add(key(ch.toCol, ch.toRow));
    }
    return b;
  }

  function neighbor(c: number, r: number, prev: string) {
    const o = (
      [
        { col: c - 1, row: r, axis: "h" as const },
        { col: c + 1, row: r, axis: "h" as const },
        { col: c, row: r - 1, axis: "v" as const },
        { col: c, row: r + 1, axis: "v" as const },
      ]
    ).filter((n) => isVis(n.col, n.row) && key(n.col, n.row) !== prev);
    return o.length ? o[Math.floor(Math.random() * o.length)] : null;
  }

  function startHop(fc: number, fr: number, hops: number, prev?: string) {
    const b = busy();
    if (b.has(key(fc, fr))) return false;
    const n = neighbor(fc, fr, prev ?? "");
    if (!n) return false;
    if (b.has(key(n.col, n.row))) return false;
    chains.push({ fromCol: fc, fromRow: fr, toCol: n.col, toRow: n.row, axis: n.axis, t: 0, hopsLeft: hops });
    return true;
  }

  function spawn(now: number) {
    if (now < nextSpawnAt) return;
    nextSpawnAt = now + SPAWN_MIN_MS + Math.random() * (SPAWN_MAX_MS - SPAWN_MIN_MS);
    for (let bu = 0; bu < SPAWN_BURST && chains.length < MAX_CHAINS; bu++) {
      const b = busy();
      const cand: string[] = [];
      for (const k of visible) if (!b.has(k)) cand.push(k);
      if (!cand.length) break;
      let ok = false;
      for (let a = 0; a < 8; a++) {
        const [c, r] = cand[Math.floor(Math.random() * cand.length)].split(",").map(Number);
        if (startHop(c, r, 2 + Math.floor(Math.random() * (MAX_CHAIN_HOPS - 1)))) {
          ok = true;
          break;
        }
      }
      if (!ok) break;
    }
  }

  function dash(x: number, y: number, axis: "h" | "v", morph: number, alpha: number, vel = 0) {
    const dm = easeInDamped(morph);
    const w = axis === "h" ? DOT + (DASH_LEN - DOT) * dm : DOT;
    const h = axis === "v" ? DOT + (DASH_LEN - DOT) * dm : DOT;
    const a = alpha * (0.72 + 0.28 * (1 - Math.min(1, vel * 1.4)));
    ctx!.fillStyle = `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${a})`;
    ctx!.fillRect(x - w * 0.5, y - h * 0.5, w, h);
  }

  function dot(x: number, y: number, a: number) {
    ctx!.fillStyle = `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${a})`;
    ctx!.fillRect(x - DOT * 0.5, y - DOT * 0.5, DOT, DOT);
  }

  function drawChain(ch: Chain) {
    const f = center(ch.fromCol, ch.fromRow);
    const t = center(ch.toCol, ch.toRow);
    const a = baseAlpha;
    if (ch.t < MORPH_FRAC) {
      dash(f.x, f.y, ch.axis, ch.t / MORPH_FRAC, a, 0);
      return;
    }
    if (ch.t > 1 - MORPH_FRAC) {
      const m = (1 - ch.t) / MORPH_FRAC;
      dash(t.x, t.y, ch.axis, easeOutDamped(1 - m), a, 0);
      return;
    }
    const raw = (ch.t - MORPH_FRAC) / (1 - MORPH_FRAC * 2);
    const tt = easeOutDamped(raw);
    const vel = (1 - raw) ** 2.2;
    dash(f.x + (t.x - f.x) * tt, f.y + (t.y - f.y) * tt, ch.axis, 1, a, vel);
  }

  function update(dt: number, now: number) {
    const done: Chain[] = [];
    for (const ch of chains) {
      ch.t += dt / HOP_MS;
      if (ch.t >= 1) done.push(ch);
    }
    chains = chains.filter((c) => c.t < 1);
    for (const ch of done) {
      if (ch.hopsLeft - 1 > 0) startHop(ch.toCol, ch.toRow, ch.hopsLeft - 1, key(ch.fromCol, ch.fromRow));
    }
    spawn(now);
  }

  function draw(ts: number) {
    const now = ts || performance.now();
    const dt = lastTs ? Math.min(now - lastTs, 50) : 0;
    lastTs = now;
    if (!reduced) update(dt, now);
    ctx!.clearRect(0, 0, width, height);
    const hidden = new Set<string>();
    for (const ch of chains) {
      hidden.add(key(ch.fromCol, ch.fromRow));
      if (ch.t < 1 - MORPH_FRAC * 0.5) hidden.add(key(ch.toCol, ch.toRow));
    }
    for (const k of visible) {
      if (hidden.has(k)) continue;
      const [c, r] = k.split(",").map(Number);
      const { x, y } = center(c, r);
      dot(x, y, baseAlpha);
    }
    for (const ch of chains) drawChain(ch);
    if (!reduced) animId = requestAnimationFrame(draw);
  }

  readTheme();
  resize();
  draw(0);

  const mo = new MutationObserver(readTheme);
  mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-rtheme"] });

  const onResize = () => {
    resize();
    if (reduced) draw(0);
  };
  window.addEventListener("resize", onResize);

  return () => {
    cancelAnimationFrame(animId);
    mo.disconnect();
    window.removeEventListener("resize", onResize);
  };
}

export function DotFieldBackground() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    return makeDotField(canvas);
  }, []);

  return <canvas ref={canvasRef} className="rama-dotfield" aria-hidden="true" />;
}
