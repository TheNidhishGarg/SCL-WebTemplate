import { z } from "zod";
import { ClientBriefId, ProjectId } from "./ids";
import { Basis, Evidence, FileKind, RiskKind, Severity, TemplateKind } from "./source-analysis";
import { Slug } from "./ids";

// WF-03 records around the scanner's report: where a source came from and on
// what authority it may be used, the templates people accept from it, what
// analysts (in VS Code with Claude Code) add, and the questions still open.
//
// Extraction is gated by authority, not by technical possibility: a source
// marked study_only - every WF-02 capture of someone else's site, by default
// - can be analysed but nothing is ever copied out of it.

export const SourceId = z.uuid().brand<"SourceId">();
export type SourceId = z.infer<typeof SourceId>;
export const TemplateId = z.uuid().brand<"TemplateId">();
export type TemplateId = z.infer<typeof TemplateId>;

export const AuthorizationBasis = z.enum(["client_owned", "licensed", "written_permission", "study_only"]);
export type AuthorizationBasis = z.infer<typeof AuthorizationBasis>;
export const AUTHORIZATION_LABELS: Record<AuthorizationBasis, string> = {
  client_owned: "Owned or commissioned by the client",
  licensed: "Licensed for reuse (open-source or purchased)",
  written_permission: "Owner gave written permission",
  study_only: "Study only: analyse, never extract",
};
export const extractionAllowed = (basis: AuthorizationBasis) => basis !== "study_only";

export const SourceOrigin = z.enum(["upload", "reference_capture"]);

export const Authorization = z
  .object({
    basis: AuthorizationBasis,
    // Who granted it, or where the licence is; required for anything but study_only.
    note: z.string().trim().max(1000),
    license: z.string().trim().max(120),
  })
  .superRefine((a, ctx) => {
    if (a.basis !== "study_only" && !a.note) {
      ctx.addIssue({ code: "custom", path: ["note"], message: "Record who authorised this, or where the licence is" });
    }
    if (a.basis === "licensed" && !a.license) {
      ctx.addIssue({ code: "custom", path: ["license"], message: "Name the licence" });
    }
  });
export type Authorization = z.infer<typeof Authorization>;

export const SourceRegistration = z.object({
  label: z.string().trim().min(1, "Name this source").max(160),
  // Where it came from: a repository URL, a site, a person.
  originUrl: z.string().trim().max(500),
  // Commit, tag or version, so the exact input can be found again.
  originRef: z.string().trim().max(200),
  authorization: Authorization,
});

export const Source = z.object({
  id: SourceId,
  projectId: ProjectId,
  label: z.string(),
  origin: SourceOrigin,
  originUrl: z.string(),
  originRef: z.string(),
  referenceId: z.string().nullable(),
  captureId: z.string().nullable(),
  authorization: z.object({ basis: AuthorizationBasis, note: z.string(), license: z.string() }),
  archive: z.object({ storageKey: z.string(), filename: z.string(), sizeBytes: z.int(), sha256: z.string() }),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type Source = z.infer<typeof Source>;

export const ScanRecord = z.object({
  id: z.uuid(),
  sourceId: SourceId,
  analyzerVersion: z.string(),
  digest: z.string(),
  createdAt: z.iso.datetime(),
});
export type ScanRecord = z.infer<typeof ScanRecord>;

export const ExtractionStatus = z.enum(["not_extracted", "extracted"]);
export const BuildStatus = z.enum(["not_applicable", "not_verified", "passed", "failed"]);
export type BuildStatus = z.infer<typeof BuildStatus>;
export const BUILD_LABELS: Record<BuildStatus, string> = {
  not_applicable: "No build step",
  not_verified: "Build not verified",
  passed: "Build passed",
  failed: "Build failed",
};

export const Template = z.object({
  id: TemplateId,
  projectId: ProjectId,
  sourceId: SourceId,
  scanId: z.uuid(),
  candidateKey: z.string().nullable(),
  kind: TemplateKind,
  name: z.string(),
  slug: z.string(),
  description: z.string(),
  basis: Basis,
  rationale: z.string(),
  origin: z.enum(["scanner", "person", "analysis_kit"]),
  files: z.array(z.string()),
  pages: z.array(z.string()),
  evidence: z.array(Evidence),
  extraction: z.object({ status: ExtractionStatus, workspacePath: z.string().nullable(), extractedAt: z.iso.datetime().nullable() }),
  build: z.object({ status: BuildStatus, note: z.string(), recordedAt: z.iso.datetime().nullable() }),
  createdAt: z.iso.datetime(),
});
export type Template = z.infer<typeof Template>;

// Files whose extraction can be built (compiled/bundled); others need no build.
export const needsBuild = (files: string[]) => files.some((f) => /\.(tsx?|jsx?|mjs|vue|svelte|astro|scss|sass|less)$/.test(f));

export const FindingTopic = z.enum([
  "framework",
  "routes",
  "components",
  "styles",
  "assets",
  "responsive",
  "interaction",
  "dependencies",
  "security",
  "accessibility",
  "licensing",
  "other",
]);

export const Finding = z.object({
  id: z.uuid(),
  sourceId: SourceId,
  basis: z.enum(["fact", "assumption"]),
  topic: FindingTopic,
  statement: z.string(),
  evidence: z.array(z.object({ path: z.string(), line: z.int().nullable() })),
  origin: z.enum(["person", "analysis_kit"]),
  createdAt: z.iso.datetime(),
});
export type Finding = z.infer<typeof Finding>;

export const QuestionRecord = z.object({
  id: z.uuid(),
  sourceId: SourceId,
  key: z.string().nullable(),
  topic: z.string(),
  text: z.string(),
  origin: z.enum(["analyzer", "person", "analysis_kit"]),
  status: z.enum(["open", "resolved"]),
  answer: z.string(),
  createdAt: z.iso.datetime(),
  resolvedAt: z.iso.datetime().nullable(),
});
export type QuestionRecord = z.infer<typeof QuestionRecord>;

// ------------------------------------------------- analyst findings (input)

// What an analyst - typically Claude Code in VS Code, working from the
// analysis kit - hands back. It is pinned to the scan it was made from, and
// every path it cites is checked against that source before it is accepted.
export const ANALYST_FINDINGS_SCHEMA = "scl.wf-03.analyst-findings/v1";

const KitEvidence = z.object({ path: z.string().min(1), line: z.int().min(1).nullable().default(null) });

export const AnalystFindings = z.object({
  schema: z.literal(ANALYST_FINDINGS_SCHEMA),
  scanDigest: z.string().regex(/^[0-9a-f]{64}$/, "Copy scanDigest from analysis.json"),
  findings: z
    .array(
      z
        .object({
          basis: z.enum(["fact", "assumption"]),
          topic: FindingTopic,
          statement: z.string().trim().min(1).max(2000),
          evidence: z.array(KitEvidence).max(20).default([]),
        })
        .refine((f) => f.basis !== "fact" || f.evidence.length > 0, { message: "A fact must cite at least one file", path: ["evidence"] }),
    )
    .max(500)
    .default([]),
  questions: z.array(z.object({ topic: FindingTopic, text: z.string().trim().min(1).max(1000) })).max(100).default([]),
  templates: z
    .array(
      z.object({
        kind: TemplateKind,
        name: z.string().trim().min(1).max(120),
        description: z.string().trim().max(1000).default(""),
        basis: Basis,
        rationale: z.string().trim().min(1).max(1000),
        files: z.array(z.string().min(1)).min(1).max(100),
      }),
    )
    .max(100)
    .default([]),
});
export type AnalystFindings = z.infer<typeof AnalystFindings>;

// ------------------------------------------------ template manifest (output)

export const TEMPLATE_MANIFEST_SCHEMA = "scl.wf-03.template-manifest/v1";
export const SOURCE_TOKEN_NOTICE =
  "Values as written in the source. They describe the reference, not the client's brand: WF-04 decides brand tokens.";
export const EXTRACTION_NOTICE =
  "Extracted code keeps its source's terms. Only sources authorised for reuse are extracted; study-only sources are analysis inputs.";

export const TemplateManifest = z.object({
  schema: z.literal(TEMPLATE_MANIFEST_SCHEMA),
  generatedAt: z.iso.datetime(),
  notices: z.object({ sourceTokens: z.literal(SOURCE_TOKEN_NOTICE), extraction: z.literal(EXTRACTION_NOTICE) }),
  project: z.object({ id: ProjectId, slug: z.string(), name: z.string() }),
  brief: z.object({ id: ClientBriefId, version: z.int() }).nullable(),
  sources: z.array(
    z.object({
      id: SourceId,
      label: z.string(),
      origin: z.object({ kind: SourceOrigin, url: z.string(), ref: z.string(), referenceId: z.string().nullable(), captureId: z.string().nullable() }),
      archive: z.object({ filename: z.string(), sizeBytes: z.int(), sha256: z.string(), downloadPath: z.string() }),
      authorization: z.object({ basis: AuthorizationBasis, note: z.string(), license: z.string(), extractionAllowed: z.boolean() }),
      // The scan this manifest's data comes from; null if never scanned.
      analysis: z
        .object({ scanId: z.uuid(), analyzerVersion: z.string(), digest: z.string(), scannedAt: z.iso.datetime(), reportPath: z.string() })
        .nullable(),
    }),
  ),
  templates: z.array(
    z.object({
      id: TemplateId,
      slug: Slug,
      kind: TemplateKind,
      name: z.string(),
      description: z.string(),
      basis: Basis,
      rationale: z.string(),
      origin: z.enum(["scanner", "person", "analysis_kit"]),
      sourceId: SourceId,
      scanId: z.uuid(),
      files: z.array(z.object({ path: z.string(), sha256: z.string().nullable() })),
      pages: z.array(z.string()),
      evidence: z.array(Evidence),
      extraction: z.object({ status: ExtractionStatus, workspacePath: z.string().nullable(), extractedAt: z.iso.datetime().nullable() }),
      build: z.object({ status: BuildStatus, note: z.string() }),
    }),
  ),
  sourceTokens: z.array(
    z.object({
      sourceId: SourceId,
      customProperties: z.array(z.object({ name: z.string(), value: z.string(), path: z.string(), line: z.int() })),
      colors: z.array(z.object({ value: z.string(), count: z.int() })),
      fontFamilies: z.array(z.object({ family: z.string(), count: z.int() })),
      fontFaces: z.array(z.object({ family: z.string(), weight: z.string().nullable(), style: z.string().nullable(), path: z.string() })),
      breakpoints: z.array(z.object({ px: z.number(), feature: z.enum(["min-width", "max-width"]), count: z.int() })),
    }),
  ),
  assets: z.array(z.object({ sourceId: SourceId, path: z.string(), kind: FileKind, sizeBytes: z.int(), sha256: z.string(), referenced: z.boolean() })),
  risks: z.array(z.object({ sourceId: SourceId, key: z.string(), kind: RiskKind, severity: Severity, title: z.string(), occurrences: z.int() })),
  openQuestions: z.array(z.object({ sourceId: SourceId, topic: z.string(), text: z.string(), origin: z.string() })),
});
export type TemplateManifest = z.infer<typeof TemplateManifest>;
