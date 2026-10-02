import type { BrandContent, ColorRole } from "./brand";

// Suggestions for a draft, from the client's own material only: their WF-01
// asset register and WF-03 sources they own. Study-only references are other
// people's brands and are never used. Suggestions fill only values that are
// still a default or missing - never a confirmed or already-inferred one -
// and arrive marked "inferred" with where they came from.

export type SuggestionInput = {
  logos: { assetId: string; label: string }[];
  ownedSources: {
    label: string;
    customProperties: { name: string; value: string; path: string; line: number }[];
    fontFamilies: { family: string; count: number }[];
    breakpoints: { px: number; feature: "min-width" | "max-width"; count: number }[];
  }[];
};

const ROLE_PATTERNS: [ColorRole, RegExp][] = [
  ["primary", /(^|-)(primary|brand)(-color)?$/],
  ["secondary", /(^|-)secondary(-color)?$/],
  ["accent", /(^|-)accent(-color)?$/],
  ["background", /(^|-)(bg|background)(-color)?$/],
  ["surface", /(^|-)surface(-color)?$/],
  ["text", /(^|-)(text|foreground|fg|body-color)(-color)?$/],
  ["border", /(^|-)border(-color)?$/],
];

const hex6 = (v: string): string | null => {
  const s = v.trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(s)) return s;
  if (/^#[0-9a-f]{3}$/.test(s)) return `#${s[1]}${s[1]}${s[2]}${s[2]}${s[3]}${s[3]}`;
  return null;
};
const GENERIC = /^(inherit|initial|sans-serif|serif|monospace|system-ui|-apple-system|blinkmacsystemfont|var\(.*)$/i;
const isOpen = (t: { value: unknown; status: string }) => t.value === null || t.status === "default";

export function applySuggestions(b: BrandContent, input: SuggestionInput): { content: BrandContent; applied: string[] } {
  const next = structuredClone(b);
  const applied: string[] = [];

  for (const src of input.ownedSources) {
    for (const [role, re] of ROLE_PATTERNS) {
      if (!isOpen(next.colors[role])) continue;
      const prop = src.customProperties.find((p) => re.test(p.name.replace(/^--/, "")) && hex6(p.value));
      if (prop) {
        next.colors[role] = { value: hex6(prop.value), status: "inferred", note: `${src.label}: ${prop.name} (${prop.path}:${prop.line})` };
        applied.push(`colors.${role}`);
      }
    }
    const family = src.fontFamilies.find((f) => !GENERIC.test(f.family) && /^[A-Za-z0-9][A-Za-z0-9 \-]*$/.test(f.family));
    if (family) {
      for (const slot of ["body", "heading"] as const) {
        if (isOpen(next.typography[slot].family)) {
          next.typography[slot].family = { value: family.family, status: "inferred", note: `${src.label}: most used font (${family.count} declarations)` };
          applied.push(`typography.${slot}.family`);
        }
      }
    }
    // Each client breakpoint goes to the nearest conventional slot
    // (640/768/1024/1280), and only if the result stays ascending.
    const mins = [...new Set(src.breakpoints.filter((x) => x.feature === "min-width" && x.px >= 320 && x.px <= 2560).map((x) => x.px))].sort((a, c) => a - c);
    const SLOTS = { sm: 640, md: 768, lg: 1024, xl: 1280 } as const;
    const bp = next.layout.breakpoints;
    const assigned = new Map<keyof typeof SLOTS, number>();
    for (const px of mins) {
      const key = (Object.keys(SLOTS) as (keyof typeof SLOTS)[]).filter((k) => !assigned.has(k)).sort((a, c) => Math.abs(SLOTS[a] - px) - Math.abs(SLOTS[c] - px))[0];
      if (key) assigned.set(key, px);
    }
    const fill = [...assigned.entries()].filter(([k]) => isOpen(bp[k]));
    const seq = (Object.keys(SLOTS) as (keyof typeof SLOTS)[]).map((k) => fill.find(([f]) => f === k)?.[1] ?? bp[k].value).filter((x): x is number => x !== null);
    if (fill.length && seq.every((x, i) => i === 0 || x > seq[i - 1])) {
      for (const [k, px] of fill) {
        bp[k] = { value: px, status: "inferred", note: `${src.label}: min-width media query` };
        applied.push(`layout.breakpoints.${k}`);
      }
    }
  }

  if (!next.assets.logos.length && input.logos.length) {
    next.assets.logos = input.logos.map((l, i) => ({
      variant: i === 0 ? "primary" : "secondary",
      ref: { kind: "asset", assetId: l.assetId },
      background: "any",
      minWidthPx: null,
      status: "inferred",
      note: `From the asset register: ${l.label}${i === 0 ? " (assumed primary; confirm)" : ""}`,
    }));
    applied.push("assets.logos");
  }
  return { content: next, applied };
}
