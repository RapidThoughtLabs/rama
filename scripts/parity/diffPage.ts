// Runs inside a blank Chrome page: decodes two PNGs, blanks the masked regions in both, and
// compares them with pixelmatch's perceptual metric (YIQ colour distance, threshold 0.1), so the
// numbers mean what they would with the npm package, with nothing to install.
//
// Returns the differing-pixel share of the unmasked area, how many 24×24 blocks are mostly
// different (the "no cluster larger than 24×24" check from the Home plan's §5), and a diff PNG:
// the mockup faded to grey with every differing pixel in red.

export const COMPARE_FN = `async (aB64, bB64, masks, threshold) => {
  const load = (b64) => new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = "data:image/png;base64," + b64; });
  const [a, b] = await Promise.all([load(aB64), load(bB64)]);
  const w = Math.max(a.width, b.width), h = Math.max(a.height, b.height);
  const draw = (img) => { const c = document.createElement("canvas"); c.width = w; c.height = h; const x = c.getContext("2d", { willReadFrequently: true }); x.fillStyle = "#fff"; x.fillRect(0, 0, w, h); x.drawImage(img, 0, 0); return { c, x }; };
  const A = draw(a), B = draw(b);
  for (const m of masks) for (const t of [A, B]) { t.x.fillStyle = "#808080"; t.x.fillRect(m[0], m[1], m[2], m[3]); }
  const da = A.x.getImageData(0, 0, w, h).data, db = B.x.getImageData(0, 0, w, h).data;
  const out = new ImageData(w, h);
  const maxDelta = 35215 * threshold * threshold;
  const blend = (c, al) => 255 + (c - 255) * al;
  let diff = 0, masked = 0;
  const bs = 24, bw = Math.ceil(w / bs), bh = Math.ceil(h / bs), blocks = new Uint32Array(bw * bh);
  const inMask = (x, y) => { for (const m of masks) if (x >= m[0] && x < m[0] + m[2] && y >= m[1] && y < m[1] + m[3]) return true; return false; };
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const k = (y * w + x) * 4;
    let d = 0;
    if (inMask(x, y)) { masked++; }
    else {
      const a1 = da[k + 3] / 255, a2 = db[k + 3] / 255;
      const r1 = blend(da[k], a1), g1 = blend(da[k + 1], a1), b1 = blend(da[k + 2], a1);
      const r2 = blend(db[k], a2), g2 = blend(db[k + 1], a2), b2 = blend(db[k + 2], a2);
      const y1 = r1 * 0.29889531 + g1 * 0.58662247 + b1 * 0.11448223, y2 = r2 * 0.29889531 + g2 * 0.58662247 + b2 * 0.11448223;
      const i1 = r1 * 0.59597799 - g1 * 0.2741761 - b1 * 0.32180189, i2 = r2 * 0.59597799 - g2 * 0.2741761 - b2 * 0.32180189;
      const q1 = r1 * 0.21147017 - g1 * 0.52261711 + b1 * 0.31114694, q2 = r2 * 0.21147017 - g2 * 0.52261711 + b2 * 0.31114694;
      const dy = y1 - y2, di = i1 - i2, dq = q1 - q2;
      d = 0.5053 * dy * dy + 0.299 * di * di + 0.1957 * dq * dq;
    }
    if (d > maxDelta) { diff++; blocks[Math.floor(y / bs) * bw + Math.floor(x / bs)]++; out.data[k] = 255; out.data[k + 1] = 40; out.data[k + 2] = 70; out.data[k + 3] = 255; }
    else { const g = 255 - (255 - (da[k] * 0.3 + da[k + 1] * 0.59 + da[k + 2] * 0.11)) * 0.25; out.data[k] = out.data[k + 1] = out.data[k + 2] = g; out.data[k + 3] = 255; }
  }
  let bad = 0; for (let i = 0; i < blocks.length; i++) if (blocks[i] > bs * bs * 0.5) bad++;
  const oc = document.createElement("canvas"); oc.width = w; oc.height = h; oc.getContext("2d").putImageData(out, 0, 0);
  const total = w * h - masked;
  return { width: w, height: h, sizeMismatch: a.width !== b.width || a.height !== b.height, diffPixels: diff, comparedPixels: total, diffPct: total ? (diff / total) * 100 : 0, badBlocks: bad, png: oc.toDataURL("image/png").split(",")[1] };
}`;
