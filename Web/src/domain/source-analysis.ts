import { z } from "zod";

// WF-03 source analysis: what the scanner found in one source archive.
//
// Two rules shape this schema:
//   - Observed vs inferred. A file list, a CSS breakpoint or an <img> without
//     alt is observed: it is in the source, at a path and line. "This site is
//     built with Next.js" or "these sections form a reusable template" is
//     inferred, and says so (basis + rationale) with the evidence it rests on.
//   - Reproducible. The result holds no timestamps and is sorted throughout;
//     the same archive and analyzer version always produce the same digest.
//     When and by whom a scan ran is stored next to the result, not in it.

// Bump whenever the same input could produce a different report.
export const ANALYZER_VERSION = "1.1.0";
export const SOURCE_ANALYSIS_SCHEMA = "scl.wf-03.source-analysis/v1";

export const Basis = z.enum(["observed", "inferred"]);
export type Basis = z.infer<typeof Basis>;

export const Evidence = z.object({
  path: z.string(),
  line: z.int().nullable(),
  excerpt: z.string().nullable(),
});
export type Evidence = z.infer<typeof Evidence>;

export const FileKind = z.enum(["html", "css", "script", "json", "image", "font", "video", "audio", "document", "other"]);
export type FileKind = z.infer<typeof FileKind>;

export const RiskKind = z.enum(["security", "accessibility", "missing_asset", "licensing", "dependency"]);
export type RiskKind = z.infer<typeof RiskKind>;
export const Severity = z.enum(["high", "medium", "low", "info"]);

export const Risk = z.object({
  key: z.string(),
  kind: RiskKind,
  severity: Severity,
  basis: Basis,
  title: z.string(),
  detail: z.string(),
  occurrences: z.int(),
  evidence: z.array(Evidence), // at most 10; occurrences counts all
});
export type Risk = z.infer<typeof Risk>;

export const TemplateKind = z.enum(["page_template", "layout", "navigation", "section", "component", "interaction"]);
export type TemplateKind = z.infer<typeof TemplateKind>;

export const TemplateCandidate = z.object({
  key: z.string(),
  kind: TemplateKind,
  name: z.string(),
  basis: Basis,
  rationale: z.string(),
  // The files this candidate is made of, which extraction would copy.
  files: z.array(z.string()),
  pages: z.array(z.string()),
  evidence: z.array(Evidence),
});
export type TemplateCandidate = z.infer<typeof TemplateCandidate>;

export const Question = z.object({
  key: z.string(),
  topic: z.string(),
  text: z.string(),
  evidence: z.array(Evidence),
});
export type Question = z.infer<typeof Question>;

export const SourceAnalysis = z.object({
  schema: z.literal(SOURCE_ANALYSIS_SCHEMA),
  analyzerVersion: z.string(),
  input: z.object({ sha256: z.string(), sizeBytes: z.int() }),
  // A single top-level folder shared by every file is stripped from paths;
  // this is it, so paths can be mapped back to the archive exactly.
  rootPrefix: z.string(),
  skipped: z.array(z.object({ path: z.string(), reason: z.string() })),
  summary: z.object({ files: z.int(), totalBytes: z.int(), byKind: z.record(FileKind, z.int()) }),
  files: z.array(z.object({ path: z.string(), kind: FileKind, sizeBytes: z.int(), sha256: z.string() })),
  frameworks: z.array(z.object({ name: z.string(), version: z.string().nullable(), basis: Basis, rationale: z.string(), evidence: z.array(Evidence) })),
  routes: z.array(z.object({ route: z.string(), file: z.string(), origin: z.enum(["next_app", "next_pages", "html"]), dynamic: z.boolean() })),
  linkedButMissing: z.array(z.object({ href: z.string(), evidence: z.array(Evidence) })),
  components: z.array(
    z.object({
      name: z.string(),
      file: z.string(),
      kind: z.enum(["react", "vue", "svelte", "astro"]),
      usedBy: z.array(z.string()),
    }),
  ),
  templateCandidates: z.array(TemplateCandidate),
  styles: z.object({
    stylesheets: z.array(z.string()),
    customProperties: z.array(z.object({ name: z.string(), value: z.string(), path: z.string(), line: z.int() })),
    breakpoints: z.array(z.object({ px: z.number(), feature: z.enum(["min-width", "max-width"]), count: z.int(), evidence: z.array(Evidence) })),
    colors: z.array(z.object({ value: z.string(), count: z.int() })),
    fontFamilies: z.array(z.object({ family: z.string(), count: z.int() })),
    fontFaces: z.array(z.object({ family: z.string(), weight: z.string().nullable(), style: z.string().nullable(), src: z.array(z.string()), path: z.string(), line: z.int() })),
    keyframes: z.array(z.object({ name: z.string(), path: z.string(), line: z.int() })),
    transitionCount: z.int(),
    reducedMotionQueries: z.int(),
  }),
  assets: z.array(
    z.object({ path: z.string(), kind: FileKind, sizeBytes: z.int(), sha256: z.string(), referencedBy: z.array(z.string()) }),
  ),
  missingAssets: z.array(z.object({ ref: z.string(), evidence: z.array(Evidence) })),
  externalResources: z.array(
    z.object({
      url: z.string(),
      kind: z.enum(["script", "stylesheet", "font", "image", "media", "other"]),
      integrity: z.boolean(),
      evidence: z.array(Evidence),
    }),
  ),
  dependencies: z.array(z.object({ name: z.string(), version: z.string(), scope: z.enum(["dependencies", "devDependencies", "peerDependencies", "cdn"]), path: z.string() })),
  lockfiles: z.array(z.string()),
  licenses: z.array(z.object({ path: z.string(), identified: z.string().nullable(), basis: Basis })),
  licenseBanners: z.array(z.object({ path: z.string(), line: z.int(), text: z.string() })),
  responsive: z.object({
    pagesWithViewportMeta: z.array(z.string()),
    pagesWithoutViewportMeta: z.array(z.string()),
    mediaQueries: z.int(),
    containerQueries: z.int(),
    srcsetImages: z.int(),
    pictureElements: z.int(),
  }),
  interactions: z.array(z.object({ name: z.string(), basis: Basis, rationale: z.string(), evidence: z.array(Evidence) })),
  risks: z.array(Risk),
  questions: z.array(Question),
});
export type SourceAnalysis = z.infer<typeof SourceAnalysis>;
