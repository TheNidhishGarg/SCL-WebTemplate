import { z } from "zod";
import { ClientBriefId, ProjectId, Slug } from "./ids";
import { DeliveryMode, includesCinematic, includesConventional } from "./project";
import { Version, VersionStatus } from "./versioning";

// WF-01 output. Everything downstream reads the approved version of this:
// WF-02 the reference URLs, WF-04 the brand inputs, WF-05 the page list,
// WF-06 the cinematic intent, WF-09 the desired actions.
//
// Two schemas on purpose. ClientBriefDraft is what can be saved at any moment:
// right types, bounded sizes, but blanks allowed, because people fill a brief
// in over several sittings. ClientBriefContent is what can be approved and
// handed on: complete and internally consistent.
//
// Deliberately absent: contact names, emails and phone numbers. The SCL
// Dashboard owns client contacts; a brief only says what to build.

const MAX_REFERENCE_URLS = 50; // WF-02 captures each one; more is a research task, not a brief.
const MAX_REQUIRED_PAGES = 40;
const MAX_LIST = 10;

export const DesiredActionKind = z.enum([
  "lead_form",
  "booking",
  "purchase",
  "call",
  "contact",
  "download",
  "newsletter",
  "other",
]);
export type DesiredActionKind = z.infer<typeof DesiredActionKind>;

export const DESIRED_ACTION_LABELS: Record<DesiredActionKind, string> = {
  lead_form: "Submit an enquiry form",
  booking: "Book an appointment",
  purchase: "Buy",
  call: "Call",
  contact: "Contact (email / chat)",
  download: "Download something",
  newsletter: "Join a mailing list",
  other: "Other",
};

export const ConstraintCategory = z.enum(["brand", "legal", "technical", "content", "timeline", "budget", "other"]);
export type ConstraintCategory = z.infer<typeof ConstraintCategory>;

export const Priority = z.enum(["primary", "secondary"]);

// ---------------------------------------------------------------- draft shape

const s = (max: number) => z.string().max(max);

export const ClientBriefDraft = z
  .object({
    deliveryMode: DeliveryMode.nullable(),
    websiteUrl: s(500),
    industry: s(120),
    summary: s(2000),
    audiences: z.array(z.object({ name: s(120), description: s(1000) })).max(MAX_LIST),
    objectives: z.array(z.object({ statement: s(500), priority: Priority })).max(MAX_LIST),
    requiredPages: z.array(z.object({ slug: s(64), title: s(120), purpose: s(500) })).max(MAX_REQUIRED_PAGES),
    desiredActions: z.array(z.object({ kind: DesiredActionKind, description: s(500) })).max(MAX_LIST),
    referenceUrls: z.array(z.object({ url: s(500), note: s(500) })).max(MAX_REFERENCE_URLS),
    cinematic: z.object({
      intent: s(2000),
      targetRuntimeSeconds: z.int().min(0).max(1800).nullable(),
      branching: z.boolean(),
    }),
    constraints: z.object({
      locales: z.array(s(35)).max(10),
      launchDate: s(10),
      items: z.array(z.object({ category: ConstraintCategory, detail: s(500) })).max(20),
    }),
  })
  .strict();
export type ClientBriefDraft = z.infer<typeof ClientBriefDraft>;

export const emptyDraft = (): ClientBriefDraft => ({
  deliveryMode: null,
  websiteUrl: "",
  industry: "",
  summary: "",
  audiences: [],
  objectives: [],
  requiredPages: [],
  desiredActions: [],
  referenceUrls: [],
  cinematic: { intent: "", targetRuntimeSeconds: null, branching: false },
  constraints: { locales: ["en-IN"], launchDate: "", items: [] },
});

// ------------------------------------------------------------ complete brief

const HttpUrl = z.url({ protocol: /^https?$/, normalize: true, error: "Enter a full http(s) URL" });
const text = (max: number, label: string) =>
  z.string().trim().min(1, `${label} is required`).max(max);

const completeFields = z.object({
  deliveryMode: z.enum(DeliveryMode.options, { error: "Choose what we are delivering" }),
  websiteUrl: HttpUrl.nullable(),
  industry: text(120, "Industry"),
  summary: text(2000, "Project summary"),
  audiences: z
    .array(z.object({ name: text(120, "Audience name"), description: text(1000, "Audience description") }))
    .min(1, "Add at least one target audience")
    .max(MAX_LIST),
  objectives: z
    .array(z.object({ statement: text(500, "Objective"), priority: Priority }))
    .min(1, "Add at least one business objective")
    .max(MAX_LIST),
  requiredPages: z
    .array(
      z.object({
        slug: Slug,
        title: text(120, "Page title"),
        purpose: text(500, "Page purpose"),
      }),
    )
    .max(MAX_REQUIRED_PAGES),
  desiredActions: z
    .array(z.object({ kind: DesiredActionKind, description: text(500, "Action description") }))
    .min(1, "Add at least one action you want visitors to take")
    .max(MAX_LIST),
  referenceUrls: z.array(z.object({ url: HttpUrl, note: z.string().trim().max(500).nullable() })).max(MAX_REFERENCE_URLS),
  cinematic: z
    .object({
      intent: text(2000, "Cinematic intent"),
      targetRuntimeSeconds: z
        .int("Target runtime is required")
        .min(10, "Target runtime must be at least 10 seconds")
        .max(1800, "Target runtime must be 30 minutes or less"),
      branching: z.boolean(),
    })
    .nullable(),
  constraints: z.object({
    // BCP 47 tags, e.g. "en-IN". The first is the default locale.
    locales: z
      .array(z.string().regex(/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/, "Use a language tag such as en-IN"))
      .min(1, "Add at least one language"),
    launchDate: z.iso.date("Use a valid date").nullable(),
    items: z.array(z.object({ category: ConstraintCategory, detail: text(500, "Constraint") })).max(20),
  }),
});

type CrossFieldInput = {
  deliveryMode: DeliveryMode | null;
  cinematic: unknown;
  requiredPages: { slug: string }[];
};

// Rules that relate fields to each other. Kept outside the schema because Zod
// skips object-level refinements once any field fails, and a half-written
// draft always has failing fields - evaluateDraft runs these itself so the
// checklist never shows "Required pages: complete" on an empty list.
function crossFieldIssues(brief: CrossFieldInput): { path: (string | number)[]; message: string }[] {
  const issues: { path: (string | number)[]; message: string }[] = [];
  const mode = brief.deliveryMode;
  if (mode !== null && includesCinematic(mode) && !brief.cinematic) {
    issues.push({ path: ["cinematic"], message: "Describe the cinematic journey: intent and target runtime." });
  }
  if (mode !== null && !includesCinematic(mode) && brief.cinematic) {
    issues.push({ path: ["cinematic"], message: "A conventional website has no cinematic journey." });
  }
  // With no deliverable chosen yet, assume a website: pages are the common case.
  if ((mode === null || includesConventional(mode)) && brief.requiredPages.length === 0) {
    issues.push({ path: ["requiredPages"], message: "Add at least one required page." });
  }
  const seen = new Set<string>();
  brief.requiredPages.forEach((page, i) => {
    if (seen.has(page.slug)) issues.push({ path: ["requiredPages", i, "slug"], message: `Duplicate page slug "${page.slug}".` });
    seen.add(page.slug);
  });
  return issues;
}

export const ClientBriefContent = completeFields.superRefine((brief, ctx) => {
  for (const issue of crossFieldIssues(brief)) ctx.addIssue({ code: "custom", ...issue });
});
export type ClientBriefContent = z.infer<typeof ClientBriefContent>;

// ------------------------------------------------------ draft -> candidate

const blank = (v: string) => v.trim() === "";

// Keeps the rows that pass `keep`, remembering each kept row's index in the
// draft so validation messages can be pointed back at the right form row.
function keepRows<T>(rows: T[], keep: (row: T) => boolean): { rows: T[]; from: number[] } {
  const from: number[] = [];
  const kept = rows.filter((row, i) => keep(row) && from.push(i) > 0);
  return { rows: kept, from };
}

export type DraftCandidate = {
  candidate: unknown;
  // For each list, candidate index -> draft index. Keyed by the issue path prefix.
  rowMaps: Record<string, number[]>;
};

// Turns what the form holds into what the strict schema judges. Rows left
// entirely blank are dropped rather than reported, so an unused "add" row never
// blocks approval; a half-filled row is kept and reported.
export function draftToCandidate(d: ClientBriefDraft): DraftCandidate {
  const wantsJourney = d.deliveryMode !== null && includesCinematic(d.deliveryMode);
  const c = d.cinematic;
  const cinematicTouched = !blank(c.intent) || c.targetRuntimeSeconds !== null;

  const audiences = keepRows(d.audiences, (a) => !(blank(a.name) && blank(a.description)));
  const objectives = keepRows(d.objectives, (o) => !blank(o.statement));
  const pages = keepRows(d.requiredPages, (p) => !(blank(p.slug) && blank(p.title) && blank(p.purpose)));
  const actions = keepRows(d.desiredActions, (a) => !blank(a.description));
  const refs = keepRows(d.referenceUrls, (r) => !blank(r.url));
  const items = keepRows(d.constraints.items, (i) => !blank(i.detail));

  return {
    candidate: {
      deliveryMode: d.deliveryMode,
      websiteUrl: blank(d.websiteUrl) ? null : d.websiteUrl.trim(),
      industry: d.industry,
      summary: d.summary,
      audiences: audiences.rows,
      objectives: objectives.rows,
      requiredPages: pages.rows.map((p) => ({ ...p, slug: p.slug.trim() })),
      desiredActions: actions.rows,
      referenceUrls: refs.rows.map((r) => ({ url: r.url.trim(), note: blank(r.note) ? null : r.note.trim() })),
      // The cinematic section is hidden for a conventional site, so whatever it
      // holds is not part of that brief. For a journey, an untouched section is
      // reported once as missing rather than as separate field errors.
      cinematic: wantsJourney && cinematicTouched ? { ...c } : null,
      constraints: {
        locales: d.constraints.locales.map((l) => l.trim()).filter((l) => l !== ""),
        launchDate: blank(d.constraints.launchDate) ? null : d.constraints.launchDate,
        items: items.rows,
      },
    },
    rowMaps: {
      audiences: audiences.from,
      objectives: objectives.from,
      requiredPages: pages.from,
      desiredActions: actions.from,
      referenceUrls: refs.from,
      "constraints.items": items.from,
    },
  };
}

function toDraftPath(path: PropertyKey[], rowMaps: Record<string, number[]>): string {
  const parts = path.map(String);
  for (const [prefix, map] of Object.entries(rowMaps)) {
    const depth = prefix.split(".").length;
    if (parts.slice(0, depth).join(".") === prefix && /^\d+$/.test(parts[depth] ?? "")) {
      parts[depth] = String(map[Number(parts[depth])] ?? parts[depth]);
      break;
    }
  }
  return parts.join(".");
}

// ---------------------------------------------------------- completeness

export const BRIEF_SECTIONS = [
  { key: "deliverable", label: "Deliverable", fields: ["deliveryMode"] },
  { key: "business", label: "Business", fields: ["websiteUrl", "industry", "summary"] },
  { key: "audiences", label: "Target audiences", fields: ["audiences"] },
  { key: "objectives", label: "Business objectives", fields: ["objectives"] },
  { key: "pages", label: "Required pages", fields: ["requiredPages"] },
  { key: "actions", label: "Desired actions", fields: ["desiredActions"] },
  { key: "references", label: "Reference websites", fields: ["referenceUrls"] },
  { key: "cinematic", label: "Cinematic journey", fields: ["cinematic"] },
  { key: "constraints", label: "Constraints", fields: ["constraints"] },
] as const;
export type BriefSectionKey = (typeof BRIEF_SECTIONS)[number]["key"];

export type BriefIssue = { path: string; message: string };

export type BriefCompleteness = {
  complete: boolean;
  percent: number;
  sections: { key: BriefSectionKey; label: string; complete: boolean; issues: BriefIssue[]; applicable: boolean }[];
  issues: BriefIssue[];
};

export function evaluateDraft(d: ClientBriefDraft): {
  completeness: BriefCompleteness;
  content: ClientBriefContent | null;
} {
  const { candidate, rowMaps } = draftToCandidate(d);
  const parsed = ClientBriefContent.safeParse(candidate);
  const raw = parsed.success ? [] : [...parsed.error.issues];
  if (!parsed.success) {
    // The refinement did not run if any field failed; run the same rules here.
    const c = candidate as CrossFieldInput;
    for (const extra of crossFieldIssues(c)) {
      const key = extra.path.join(".");
      if (!raw.some((i) => i.path.join(".") === key && i.message === extra.message)) raw.push({ ...extra, code: "custom", input: undefined });
    }
  }
  // Paths refer to the draft as the form shows it, not the filtered candidate.
  const issues: BriefIssue[] = raw.map((i) => ({ path: toDraftPath(i.path, rowMaps), message: i.message }));
  const mode = d.deliveryMode;
  const sections = BRIEF_SECTIONS.map((sec) => {
    const own = issues.filter((i) => (sec.fields as readonly string[]).includes(i.path.split(".")[0]));
    const applicable =
      sec.key === "cinematic" ? mode !== null && includesCinematic(mode)
      : sec.key === "pages" ? mode === null || includesConventional(mode)
      : true;
    return { key: sec.key, label: sec.label, complete: own.length === 0, issues: own, applicable };
  });
  const counted = sections.filter((x) => x.applicable);
  const percent = Math.round((counted.filter((x) => x.complete).length / counted.length) * 100);
  return {
    completeness: { complete: parsed.success, percent, sections, issues },
    content: parsed.success ? parsed.data : null,
  };
}

// ------------------------------------------------------------- the record

// A version is editable only while it is a draft. Approving it freezes it;
// editing an approved brief opens version n+1 as a new draft, and approving
// that supersedes the old one. The approved version is what WF-02..10 read.
export const ClientBrief = z.object({
  id: ClientBriefId,
  projectId: ProjectId,
  version: Version,
  status: VersionStatus,
  draft: ClientBriefDraft,
  // Frozen at approval, so a handoff reads exactly what was approved even if
  // draftToCandidate changes later. Null until then.
  content: ClientBriefContent.nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  approvedAt: z.iso.datetime().nullable(),
});
export type ClientBrief = z.infer<typeof ClientBrief>;
