// Small self-contained color helpers for the theme loader (packages/ui/src/themes.ts). No
// external color library: SETTINGS_PLAN.md Phase S1's whole pitch is a four-colour theme file,
// so the derivation math needs to live somewhere, and it's cheap enough (HSL lighten/darken +
// hex<->rgb) not to justify a dependency.

export type RGB = [number, number, number];

export function hexToRgb(hex: string): RGB {
  const h = hex.replace("#", "").trim();
  const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  const n = parseInt(full, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function rgbToHex([r, g, b]: RGB): string {
  const c = (v: number) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, "0");
  return `#${c(r)}${c(g)}${c(b)}`;
}

/** "R, G, B" — the comma-triplet format this codebase's CSS uses inside `rgba(var(--x), a)`. */
export function rgbTriplet(hex: string): string {
  return hexToRgb(hex).join(", ");
}

function rgbToHsl([r, g, b]: RGB): [number, number, number] {
  const rn = r / 255, gn = g / 255, bn = b / 255;
  const max = Math.max(rn, gn, bn), min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  switch (max) {
    case rn: h = (gn - bn) / d + (gn < bn ? 6 : 0); break;
    case gn: h = (bn - rn) / d + 2; break;
    default: h = (rn - gn) / d + 4;
  }
  return [h / 6, s, l];
}

function hslToRgb([h, s, l]: [number, number, number]): RGB {
  if (s === 0) { const v = l * 255; return [v, v, v]; }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const hue = (t0: number) => {
    let t = t0;
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [hue(h + 1 / 3) * 255, hue(h) * 255, hue(h - 1 / 3) * 255];
}

/** Shift a hex color's HSL lightness by `delta` (-1..1), clamped. Hue/saturation untouched. */
export function adjustLightness(hex: string, delta: number): string {
  const [h, s, l] = rgbToHsl(hexToRgb(hex));
  return rgbToHex(hslToRgb([h, s, Math.min(1, Math.max(0, l + delta))]));
}

// The "lightness ramp" SETTINGS_PLAN.md Phase S1 describes: bg-deep/-surface/-elevated are all
// derived from a theme's single `ground` colour. Deltas were reverse-engineered from the three
// original hand-authored themes (kanagawa/sumi/foam) — see the plan's S0 section for the numbers;
// this picks the values that land closest to all three at once rather than reproducing any one
// exactly, which the plan explicitly says is an acceptable trade for a format this much smaller.
export const GROUND_RAMP = { deep: -0.03, surface: 0.07, elevated: 0.1 } as const;
