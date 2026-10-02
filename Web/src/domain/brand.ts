import { z } from "zod";

// WF-04 brand configuration. Every design value is a token that records not
// just its value but how sure we are of it:
//   confirmed  stated by the client or their guidelines
//   inferred   derived from evidence (their own site, their asset register)
//   default    a starting value nobody has decided on
// and a null value means missing. Approval needs every required value present;
// defaults and inferences are allowed but stay visible in the export.
//
// Values that end up in CSS are validated to plain literals (hex colours,
// numbers, a strict family-name pattern, a strict shadow grammar), so a
// configuration can never inject CSS into the pages that use it.

export const BrandId = z.uuid().brand<"BrandId">();
export type BrandId = z.infer<typeof BrandId>;

export const TokenStatus = z.enum(["confirmed", "inferred", "default"]);
export type TokenStatus = z.infer<typeof TokenStatus>;

const token = <T extends z.ZodType>(value: T) =>
  z.object({ value: value.nullable(), status: TokenStatus, note: z.string().trim().max(300) });
export type Token<T> = { value: T | null; status: TokenStatus; note: string };

const num = (min: number, max: number, unit: string, step?: number) =>
  z
    .number(`Enter a number (${unit})`)
    .min(min, `Must be at least ${min}${unit}`)
    .max(max, `Must be at most ${max}${unit}`)
    .refine((v) => step === undefined || Math.abs(v / step - Math.round(v / step)) < 1e-9, `Use steps of ${step}${unit}`);

export const Hex = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/, "Use a 6-digit hex colour, e.g. #1A2B3C")
  .transform((v) => v.toLowerCase());

const FontFamily = z
  .string()
  .trim()
  .min(1, "Enter a font family name")
  .max(80)
  .regex(/^[A-Za-z0-9][A-Za-z0-9 \-]*$/, "Letters, digits, spaces and hyphens only, e.g. Inter or Source Serif 4");

const Shadow = z
  .string()
  .trim()
  .max(200)
  .regex(
    /^(none|(?:inset\s+)?(?:-?\d+(?:\.\d+)?(?:px)?\s+){2,4}(?:#[0-9a-fA-F]{3,8}|rgba?\(\s*[\d.\s,%/]+\))(?:\s*,\s*(?:inset\s+)?(?:-?\d+(?:\.\d+)?(?:px)?\s+){2,4}(?:#[0-9a-fA-F]{3,8}|rgba?\(\s*[\d.\s,%/]+\)))*)$/,
    "Use a box-shadow like 0 1px 2px rgba(0,0,0,0.1), or none",
  );

const Easing = z
  .string()
  .trim()
  .regex(/^(linear|ease|ease-in|ease-out|ease-in-out|cubic-bezier\(\s*-?[\d.]+\s*,\s*-?[\d.]+\s*,\s*-?[\d.]+\s*,\s*-?[\d.]+\s*\))$/, "Use a CSS easing keyword or cubic-bezier(x1, y1, x2, y2)");

export const COLOR_ROLES = [
  "primary",
  "onPrimary",
  "secondary",
  "accent",
  "background",
  "surface",
  "text",
  "textMuted",
  "border",
  "success",
  "warning",
  "danger",
  "info",
] as const;
export type ColorRole = (typeof COLOR_ROLES)[number];
export const COLOR_LABELS: Record<ColorRole, string> = {
  primary: "Primary",
  onPrimary: "Text on primary",
  secondary: "Secondary",
  accent: "Accent",
  background: "Background",
  surface: "Surface",
  text: "Text",
  textMuted: "Muted text",
  border: "Border",
  success: "Success",
  warning: "Warning",
  danger: "Danger",
  info: "Info",
};

const FontSlot = z.object({
  family: token(FontFamily),
  fallback: z.enum(["sans-serif", "serif", "monospace", "system-ui"]),
  source: z.enum(["google", "self_hosted", "adobe", "system", "other"]),
});

const AssetRef = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("asset"), assetId: z.uuid("Choose an asset from the register") }),
  z.object({ kind: z.literal("url"), url: z.url({ protocol: /^https$/, error: "Use an https URL" }) }),
]);
export type AssetRef = z.infer<typeof AssetRef>;

export const LogoVariant = z.enum(["primary", "secondary", "mark", "wordmark", "monochrome", "inverse"]);

export const BrandContent = z
  .object({
    colors: z.object(Object.fromEntries(COLOR_ROLES.map((r) => [r, token(Hex)])) as Record<ColorRole, ReturnType<typeof token<typeof Hex>>>),
    typography: z.object({
      heading: FontSlot,
      body: FontSlot,
      mono: FontSlot,
      weights: z.object({ regular: token(num(100, 900, "", 100)), medium: token(num(100, 900, "", 100)), bold: token(num(100, 900, "", 100)) }),
      baseSize: token(num(12, 24, "px")),
      scaleRatio: token(num(1.05, 1.7, "")),
      lineHeight: z.object({ body: token(num(1, 2.2, "")), heading: token(num(0.8, 1.8, "")) }),
      letterSpacing: z.object({ body: token(num(-0.1, 0.3, "em")), heading: token(num(-0.1, 0.3, "em")), caps: token(num(-0.1, 0.3, "em")) }),
    }),
    layout: z.object({
      spaceUnit: token(num(2, 16, "px")),
      contentWidth: token(num(480, 2000, "px")),
      narrowWidth: token(num(320, 1200, "px")),
      gridColumns: token(num(2, 24, "", 1)),
      gridGutter: token(num(0, 96, "px")),
      breakpoints: z.object({ sm: token(num(320, 2560, "px")), md: token(num(320, 2560, "px")), lg: token(num(320, 2560, "px")), xl: token(num(320, 2560, "px")) }),
    }),
    shape: z.object({
      radius: z.object({ sm: token(num(0, 64, "px")), md: token(num(0, 64, "px")), lg: token(num(0, 64, "px")) }),
      shadow: z.object({ sm: token(Shadow), md: token(Shadow), lg: token(Shadow) }),
    }),
    motion: z.object({
      durationFast: token(num(0, 1000, "ms")),
      durationBase: token(num(0, 2000, "ms")),
      durationSlow: token(num(0, 5000, "ms")),
      easing: token(Easing),
      intensity: token(z.enum(["subtle", "standard", "expressive"])),
      // Reduced motion is always honoured; this says how.
      reducedMotion: z.enum(["shorten", "remove"]),
    }),
    assets: z.object({
      logos: z
        .array(z.object({ variant: LogoVariant, ref: AssetRef, background: z.enum(["light", "dark", "any"]), minWidthPx: z.int().min(8).max(2000).nullable(), status: TokenStatus, note: z.string().trim().max(300) }))
        .max(20),
      images: z.array(z.object({ role: z.enum(["hero", "texture", "people", "product", "place", "other"]), ref: AssetRef, status: TokenStatus, note: z.string().trim().max(300) })).max(50),
      icons: z.object({
        library: token(z.enum(["lucide", "heroicons", "phosphor", "material-symbols", "custom", "none"])),
        style: z.enum(["outline", "solid", "duotone"]),
        customRef: AssetRef.nullable(),
      }),
    }),
  })
  .strict()
  .superRefine((b, ctx) => {
    const v = <T>(t: Token<T>) => t.value;
    const bp = b.layout.breakpoints;
    const order = (["sm", "md", "lg", "xl"] as const).map((k) => [k, v(bp[k])] as const).filter(([, x]) => x !== null) as [string, number][];
    for (let i = 1; i < order.length; i++) {
      if (order[i][1] <= order[i - 1][1]) {
        ctx.addIssue({ code: "custom", path: ["layout", "breakpoints", order[i][0], "value"], message: `Must be larger than the ${order[i - 1][0]} breakpoint (${order[i - 1][1]}px)` });
      }
    }
    const nw = v(b.layout.narrowWidth);
    const cw = v(b.layout.contentWidth);
    if (nw !== null && cw !== null && nw >= cw) ctx.addIssue({ code: "custom", path: ["layout", "narrowWidth", "value"], message: `Must be narrower than the content width (${cw}px)` });
    const [f, m, s] = [v(b.motion.durationFast), v(b.motion.durationBase), v(b.motion.durationSlow)];
    if (f !== null && m !== null && f > m) ctx.addIssue({ code: "custom", path: ["motion", "durationFast", "value"], message: `Must not be longer than the base duration (${m}ms)` });
    if (m !== null && s !== null && m > s) ctx.addIssue({ code: "custom", path: ["motion", "durationBase", "value"], message: `Must not be longer than the slow duration (${s}ms)` });
    const w = b.typography.weights;
    if (v(w.regular) !== null && v(w.bold) !== null && v(w.regular)! >= v(w.bold)!) ctx.addIssue({ code: "custom", path: ["typography", "weights", "bold", "value"], message: "Must be heavier than the regular weight" });
    if (b.assets.icons.library.value === "custom" && !b.assets.icons.customRef) ctx.addIssue({ code: "custom", path: ["assets", "icons", "customRef"], message: "Choose where the custom icon set is" });
  });
export type BrandContent = z.infer<typeof BrandContent>;

// ------------------------------------------------------------------ defaults

const d = <T>(value: T): Token<T> => ({ value, status: "default", note: "" });

// Neutral, accessible starting values. All marked "default" so nobody mistakes
// them for the client's brand.
export function defaultBrand(): BrandContent {
  return {
    colors: {
      primary: d("#1d4ed8"),
      onPrimary: d("#ffffff"),
      secondary: d("#475569"),
      accent: d("#c2410c"),
      background: d("#ffffff"),
      surface: d("#f8fafc"),
      text: d("#0f172a"),
      textMuted: d("#475569"),
      border: d("#cbd5e1"),
      success: d("#15803d"),
      warning: d("#a16207"),
      danger: d("#b91c1c"),
      info: d("#0369a1"),
    },
    typography: {
      heading: { family: { value: null, status: "default", note: "" }, fallback: "sans-serif", source: "google" },
      body: { family: { value: null, status: "default", note: "" }, fallback: "sans-serif", source: "google" },
      mono: { family: { value: null, status: "default", note: "" }, fallback: "monospace", source: "system" },
      weights: { regular: d(400), medium: d(500), bold: d(700) },
      baseSize: d(16),
      scaleRatio: d(1.25),
      lineHeight: { body: d(1.6), heading: d(1.15) },
      letterSpacing: { body: d(0), heading: d(-0.01), caps: d(0.08) },
    },
    layout: {
      spaceUnit: d(4),
      contentWidth: d(1200),
      narrowWidth: d(720),
      gridColumns: d(12),
      gridGutter: d(24),
      breakpoints: { sm: d(640), md: d(768), lg: d(1024), xl: d(1280) },
    },
    shape: {
      radius: { sm: d(4), md: d(8), lg: d(16) },
      shadow: { sm: d("0 1px 2px rgba(15,23,42,0.08)"), md: d("0 4px 12px rgba(15,23,42,0.10)"), lg: d("0 12px 32px rgba(15,23,42,0.14)") },
    },
    motion: {
      durationFast: d(150),
      durationBase: d(250),
      durationSlow: d(600),
      easing: d("cubic-bezier(0.2, 0, 0, 1)"),
      intensity: d("standard"),
      reducedMotion: "shorten",
    },
    assets: { logos: [], images: [], icons: { library: d("lucide"), style: "outline", customRef: null } },
  };
}

// ------------------------------------------------------------- inspection

// Every token in the configuration with its path, for listing what is
// confirmed, inferred, default or missing.
export function listTokens(b: BrandContent): { path: string; status: TokenStatus | "missing"; value: unknown; note: string }[] {
  const out: { path: string; status: TokenStatus | "missing"; value: unknown; note: string }[] = [];
  const walk = (node: unknown, path: string[]) => {
    if (!node || typeof node !== "object" || Array.isArray(node)) return;
    const o = node as Record<string, unknown>;
    if ("value" in o && "status" in o && "note" in o) {
      out.push({ path: path.join("."), status: o.value === null ? "missing" : (o.status as TokenStatus), value: o.value, note: String(o.note) });
      return;
    }
    for (const [k, v] of Object.entries(o)) walk(v, [...path, k]);
  };
  walk({ colors: b.colors, typography: b.typography, layout: b.layout, shape: b.shape, motion: b.motion, icons: { library: b.assets.icons.library } }, []);
  return out;
}

// Values that may stay missing at approval. Everything else must be set.
const OPTIONAL = new Set(["typography.mono.family"]);
export const isRequired = (path: string) => !OPTIONAL.has(path);
