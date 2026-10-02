import { BrandContent, COLOR_LABELS, COLOR_ROLES, isRequired, listTokens, type ColorRole } from "./brand";

// The one place brand tokens become CSS custom properties. The live preview,
// the CSS export and the JSON export all call brandVariables(), so what is
// previewed is exactly what is exported. Missing values produce no variable;
// they are listed instead, never silently replaced.

export const STEPS = { xs: -2, sm: -1, base: 0, lg: 1, xl: 2, "2xl": 3, "3xl": 4, "4xl": 5 } as const;
export const SPACE = [0, 1, 2, 3, 4, 6, 8, 12, 16, 24, 32] as const;

const kebab = (s: string) => s.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
const round = (n: number, d = 4) => Math.round(n * 10 ** d) / 10 ** d;

export function brandVariables(b: BrandContent): Record<string, string> {
  const vars: Record<string, string> = {};
  const set = (name: string, v: string | null) => {
    if (v !== null) vars[`--scl-${name}`] = v;
  };
  for (const role of COLOR_ROLES) set(`color-${kebab(role)}`, b.colors[role].value);

  const t = b.typography;
  for (const slot of ["heading", "body", "mono"] as const) {
    const f = t[slot];
    set(`font-${slot}`, f.family.value ? `"${f.family.value}", ${f.fallback}` : null);
  }
  set("font-weight-regular", t.weights.regular.value?.toString() ?? null);
  set("font-weight-medium", t.weights.medium.value?.toString() ?? null);
  set("font-weight-bold", t.weights.bold.value?.toString() ?? null);
  if (t.baseSize.value !== null && t.scaleRatio.value !== null) {
    for (const [step, n] of Object.entries(STEPS)) set(`font-size-${step}`, `${round((t.baseSize.value * t.scaleRatio.value ** n) / 16)}rem`);
  }
  set("line-height-body", t.lineHeight.body.value?.toString() ?? null);
  set("line-height-heading", t.lineHeight.heading.value?.toString() ?? null);
  for (const k of ["body", "heading", "caps"] as const) set(`letter-spacing-${k}`, t.letterSpacing[k].value === null ? null : `${t.letterSpacing[k].value}em`);

  const l = b.layout;
  if (l.spaceUnit.value !== null) SPACE.forEach((m, i) => set(`space-${i}`, `${round(l.spaceUnit.value! * m, 2)}px`));
  set("content-width", l.contentWidth.value === null ? null : `${l.contentWidth.value}px`);
  set("content-width-narrow", l.narrowWidth.value === null ? null : `${l.narrowWidth.value}px`);
  set("grid-columns", l.gridColumns.value?.toString() ?? null);
  set("grid-gutter", l.gridGutter.value === null ? null : `${l.gridGutter.value}px`);
  // Custom properties cannot be used inside @media; these are for scripts and
  // container logic. The JSON export carries the numbers for build tooling.
  for (const k of ["sm", "md", "lg", "xl"] as const) set(`breakpoint-${k}`, l.breakpoints[k].value === null ? null : `${l.breakpoints[k].value}px`);

  for (const k of ["sm", "md", "lg"] as const) set(`radius-${k}`, b.shape.radius[k].value === null ? null : `${b.shape.radius[k].value}px`);
  vars["--scl-radius-pill"] = "9999px";
  for (const k of ["sm", "md", "lg"] as const) set(`shadow-${k}`, b.shape.shadow[k].value);

  const m = b.motion;
  set("duration-fast", m.durationFast.value === null ? null : `${m.durationFast.value}ms`);
  set("duration-base", m.durationBase.value === null ? null : `${m.durationBase.value}ms`);
  set("duration-slow", m.durationSlow.value === null ? null : `${m.durationSlow.value}ms`);
  set("easing-standard", m.easing.value);
  return vars;
}

// Overrides applied under prefers-reduced-motion: reduce.
export function reducedMotionVariables(b: BrandContent): Record<string, string> {
  const v = b.motion.reducedMotion === "remove" ? "0ms" : "1ms";
  return { "--scl-duration-fast": v, "--scl-duration-base": v, "--scl-duration-slow": v, "--scl-motion-enabled": b.motion.reducedMotion === "remove" ? "0" : "1" };
}

export function missingTokens(b: BrandContent): string[] {
  return listTokens(b)
    .filter((t) => t.status === "missing")
    .map((t) => t.path);
}

export function brandCss(b: BrandContent, opts: { selector: string; header: string }): string {
  const block = (vars: Record<string, string>, indent: string) =>
    Object.entries(vars)
      .map(([k, v]) => `${indent}${k}: ${v};`)
      .join("\n");
  const missing = missingTokens(b);
  return [
    `/* ${opts.header} */`,
    ...(missing.length ? [`/* Missing (no variable emitted): ${missing.join(", ")} */`] : []),
    `${opts.selector} {`,
    block({ ...brandVariables(b), "--scl-motion-enabled": "1" }, "  "),
    "}",
    "@media (prefers-reduced-motion: reduce) {",
    `  ${opts.selector} {`,
    block(reducedMotionVariables(b), "    "),
    "  }",
    "}",
    "",
  ].join("\n");
}

// ------------------------------------------------------------------ contrast

const channel = (c: number) => {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};
export function luminance(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  return 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255);
}
export function contrastRatio(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return Math.round(((x + 0.05) / (y + 0.05)) * 100) / 100;
}

export type BrandIssue = { path: string; level: "error" | "warning"; message: string };

// WCAG 2.2 AA: 4.5:1 for body text, 3:1 for UI boundaries and large text.
// Errors block approval; warnings are listed in the export.
const PAIRS: { fg: ColorRole; bg: ColorRole; min: number; level: "error" | "warning"; use: string }[] = [
  { fg: "text", bg: "background", min: 4.5, level: "error", use: "body text" },
  { fg: "text", bg: "surface", min: 4.5, level: "error", use: "text on surfaces" },
  { fg: "onPrimary", bg: "primary", min: 4.5, level: "error", use: "button and link text on primary" },
  { fg: "textMuted", bg: "background", min: 4.5, level: "error", use: "secondary text" },
  { fg: "primary", bg: "background", min: 3, level: "error", use: "primary buttons and links against the page" },
  { fg: "danger", bg: "background", min: 4.5, level: "error", use: "error messages" },
  { fg: "accent", bg: "background", min: 3, level: "warning", use: "accent elements" },
  { fg: "border", bg: "background", min: 3, level: "warning", use: "form field borders (WCAG 1.4.11)" },
  { fg: "success", bg: "background", min: 4.5, level: "warning", use: "success messages" },
  { fg: "warning", bg: "background", min: 4.5, level: "warning", use: "warning messages" },
  { fg: "info", bg: "background", min: 4.5, level: "warning", use: "info messages" },
];

export function contrastChecks(b: BrandContent) {
  return PAIRS.flatMap((p) => {
    const fg = b.colors[p.fg].value;
    const bg = b.colors[p.bg].value;
    if (!fg || !bg) return [];
    const ratio = contrastRatio(fg, bg);
    return [{ ...p, ratio, passes: ratio >= p.min }];
  });
}

export function brandIssues(b: BrandContent): BrandIssue[] {
  const issues: BrandIssue[] = [];
  for (const c of contrastChecks(b)) {
    if (c.passes) continue;
    const darker = luminance(b.colors[c.fg].value!) < luminance(b.colors[c.bg].value!);
    issues.push({
      path: `colors.${c.fg}.value`,
      level: c.level,
      message: `${COLOR_LABELS[c.fg]} on ${COLOR_LABELS[c.bg].toLowerCase()} is ${c.ratio}:1; ${c.use} need ${c.min}:1. ${darker ? "Darken" : "Lighten"} ${COLOR_LABELS[c.fg].toLowerCase()} or ${darker ? "lighten" : "darken"} ${COLOR_LABELS[c.bg].toLowerCase()}.`,
    });
  }
  const base = b.typography.baseSize.value;
  if (base !== null && base < 16) issues.push({ path: "typography.baseSize.value", level: "warning", message: `Body text at ${base}px is small for reading; 16px or more is recommended.` });
  const lh = b.typography.lineHeight.body.value;
  if (lh !== null && lh < 1.5) issues.push({ path: "typography.lineHeight.body.value", level: "warning", message: `Body line height ${lh} is tight; WCAG 1.4.12 assumes text works at 1.5.` });
  for (const path of missingTokens(b)) {
    if (isRequired(path)) issues.push({ path: `${path}.value`, level: "error", message: `Missing: ${path} needs a value before approval.` });
  }
  if (!b.assets.logos.some((l) => l.variant === "primary")) issues.push({ path: "assets.logos", level: "error", message: "Add the primary logo before approval." });
  if (b.motion.intensity.value === "expressive" && b.motion.durationSlow.value !== null && b.motion.durationSlow.value > 1000) {
    issues.push({ path: "motion.durationSlow.value", level: "warning", message: "Long, expressive motion: make sure nothing important depends on it, and test with reduced motion on." });
  }
  return issues;
}

export const blocking = (issues: BrandIssue[]) => issues.filter((i) => i.level === "error");
export type { BrandContent };
