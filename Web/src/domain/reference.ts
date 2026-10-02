import { z } from "zod";
import { ProjectId, Slug } from "./ids";

// WF-02: the reference library. One ReferenceSource per page studied; around
// it, three kinds of record that are never mixed:
//
//   evidence      what was actually acquired - system URL checks and files
//                 captured from the page (SaveMyResources archive, screenshots).
//                 Attempts are an append-only log: a failure stays visible.
//   observed      what a person saw on the reference (a user note).
//   inferred      an interpretation, by a person or by a check ("this looks
//                 like a sign-in page"), labelled as such.
//
// References are research inputs. Nothing here grants permission to reuse a
// site's code, copy or imagery; the library export says so explicitly.

export const ReferenceId = z.uuid().brand<"ReferenceId">();
export type ReferenceId = z.infer<typeof ReferenceId>;
export const CaptureId = z.uuid().brand<"CaptureId">();
export type CaptureId = z.infer<typeof CaptureId>;
export const ObservationId = z.uuid().brand<"ObservationId">();
export type ObservationId = z.infer<typeof ObservationId>;
export const AttemptId = z.uuid().brand<"AttemptId">();

export const REFERENCE_USAGE_NOTICE =
  "Research input only. Captured material remains the property of its owners; it may inform structure and direction but must not be copied into client work without permission.";

// ------------------------------------------------------------- organisation

export const ObservationAspect = z.enum(["section", "interaction", "layout", "visual_style", "content_pattern", "other"]);
export type ObservationAspect = z.infer<typeof ObservationAspect>;
export const ASPECT_LABELS: Record<ObservationAspect, string> = {
  section: "Section",
  interaction: "Interaction",
  layout: "Layout",
  visual_style: "Visual style",
  content_pattern: "Content pattern",
  other: "Other",
};

export const ObservationBasis = z.enum(["observed", "inferred"]);
export type ObservationBasis = z.infer<typeof ObservationBasis>;

// ---------------------------------------------------------------- evidence

export const AttemptMethod = z.enum(["url_check", "manual_capture"]);
export type AttemptMethod = z.infer<typeof AttemptMethod>;

// What an acquisition attempt found. Only `reachable` and `captured` are
// successes; everything else is a failure that stays on the record.
export const AttemptOutcome = z.enum([
  "reachable",
  "captured",
  "redirect_loop",
  "access_restricted",
  "not_found",
  "rate_limited",
  "server_error",
  "http_error",
  "unreachable",
  "blocked_by_policy",
  "capture_failed",
]);
export type AttemptOutcome = z.infer<typeof AttemptOutcome>;

export const OUTCOME_LABELS: Record<AttemptOutcome, string> = {
  reachable: "Reachable",
  captured: "Captured",
  redirect_loop: "Too many redirects",
  access_restricted: "Access restricted (sign-in or permission required)",
  not_found: "Page not found",
  rate_limited: "Rate limited by the site",
  server_error: "Site returned a server error",
  http_error: "Site refused the request",
  unreachable: "Could not connect",
  blocked_by_policy: "Not checked: address not allowed",
  capture_failed: "Capture failed",
};

export const isSuccessfulOutcome = (o: AttemptOutcome) => o === "reachable" || o === "captured";

// Outcomes a person can report after trying to capture a page themselves.
export const USER_REPORTABLE_OUTCOMES = ["capture_failed", "access_restricted", "not_found", "unreachable"] as const;

export const Attempt = z.object({
  id: AttemptId,
  method: AttemptMethod,
  recordedBy: z.enum(["system", "user"]),
  outcome: AttemptOutcome,
  httpStatus: z.int().nullable(),
  finalUrl: z.string().nullable(),
  redirectChain: z.array(z.object({ url: z.string(), status: z.int() })),
  pageTitle: z.string().nullable(),
  contentType: z.string().nullable(),
  detail: z.string(),
  // Interpretations made by the check itself, kept apart from the facts.
  inferences: z.array(z.string()),
  createdAt: z.iso.datetime(),
});
export type Attempt = z.infer<typeof Attempt>;

export const CaptureKind = z.enum(["archive", "screenshot", "other"]);
export type CaptureKind = z.infer<typeof CaptureKind>;
export const CAPTURE_KIND_LABELS: Record<CaptureKind, string> = {
  archive: "Resource archive",
  screenshot: "Screenshot",
  other: "Other file",
};

// The one product limit for a WF-02 capture and for a generated website-template
// artifact (SaveAllResources ZIPs run large). Binary megabytes, inclusive:
// a file of exactly MAX_CAPTURE_BYTES is accepted, one byte more is not.
// Every upload check, request-size check, message and the website-template
// pipeline derive from this value.
export const MAX_CAPTURE_BYTES = 200 * 1024 * 1024;
export const MAX_CAPTURE_LABEL = `${MAX_CAPTURE_BYTES / 1024 / 1024} MB`;

export const ALLOWED_CAPTURE_EXTENSIONS = {
  archive: ["zip"],
  screenshot: ["png", "jpg", "jpeg", "webp", "pdf"],
  other: ["png", "jpg", "jpeg", "webp", "pdf", "zip", "html", "mhtml", "txt", "mp4", "webm", "mov"],
} as const satisfies Record<CaptureKind, readonly string[]>;

export const Capture = z.object({
  id: CaptureId,
  kind: CaptureKind,
  tool: z.string(),
  sourceUrl: z.string(),
  capturedOn: z.iso.date(),
  notes: z.string(),
  file: z.object({
    storageKey: z.string(),
    filename: z.string(),
    mimeType: z.string(),
    sizeBytes: z.int().min(1),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
  }),
  createdAt: z.iso.datetime(),
});
export type Capture = z.infer<typeof Capture>;

export const Observation = z.object({
  id: ObservationId,
  aspect: ObservationAspect,
  basis: ObservationBasis,
  text: z.string(),
  // The capture this observation was read from, when there is one.
  captureId: CaptureId.nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type Observation = z.infer<typeof Observation>;

// --------------------------------------------------------------- reference

export const ReferenceOrigin = z.enum(["brief", "user"]);

export const ReferenceSource = z.object({
  id: ReferenceId,
  projectId: ProjectId,
  url: z.string(),
  host: z.string(),
  label: z.string(),
  pageType: z.string(),
  // Which of the client's required pages (WF-01 slugs) this reference informs.
  targetPages: z.array(z.string()),
  attribution: z.string(),
  origin: ReferenceOrigin,
  briefVersion: z.int().nullable(),
  // Set when a person decides the page cannot be acquired and records
  // observations by hand instead.
  manualReason: z.string().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type ReferenceSource = z.infer<typeof ReferenceSource>;

export type ReferenceStatus = "pending" | "checked" | "captured" | "failed" | "manual";
export const STATUS_LABELS: Record<ReferenceStatus, string> = {
  pending: "Not yet acquired",
  checked: "Reachable, not captured",
  captured: "Captured",
  failed: "Acquisition failed",
  manual: "Manual observations only",
};

// The attempt a reference's status rests on: the newest one that still
// stands. With no capture left, a "captured" attempt describes a deleted file,
// so it no longer counts. The UI shows this attempt when explaining a status,
// so the explanation can never contradict the badge.
export function decidingAttempt(attempts: Attempt[], captures: Capture[]): Attempt | null {
  const standing = captures.length > 0 ? attempts : attempts.filter((a) => a.outcome !== "captured");
  return [...standing].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] ?? null;
}

// Derived, never stored: it cannot drift from the attempts and captures.
export function referenceStatus(ref: Pick<ReferenceSource, "manualReason">, attempts: Attempt[], captures: Capture[]): ReferenceStatus {
  if (captures.length > 0) return "captured";
  if (ref.manualReason) return "manual";
  const latest = decidingAttempt(attempts, captures);
  if (!latest) return "pending";
  return isSuccessfulOutcome(latest.outcome) ? "checked" : "failed";
}

// ------------------------------------------------------------------ inputs

const trimmed = (max: number) => z.string().trim().max(max);

// Normalises so the same page is not added twice under two spellings:
// lowercase host, no fragment, no default port, tracking parameters removed.
const TRACKING_PARAMS = /^(utm_[a-z]+|fbclid|gclid|igshid|mc_cid|mc_eid|ref_src)$/i;
export function normaliseReferenceUrl(input: string): string | null {
  let u: URL;
  try {
    u = new URL(input.trim());
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  if (u.username || u.password) return null; // never store credentials in a URL
  u.hash = "";
  for (const key of [...u.searchParams.keys()]) if (TRACKING_PARAMS.test(key)) u.searchParams.delete(key);
  return u.toString();
}

const ReferenceUrl = z
  .string()
  .trim()
  .min(1, "Enter the page's URL")
  .transform((v, ctx) => {
    const n = normaliseReferenceUrl(v);
    if (!n) {
      ctx.addIssue({ code: "custom", message: "Enter a full http(s) URL without a username or password" });
      return z.NEVER;
    }
    return n;
  });

export const ReferenceInput = z.object({
  url: ReferenceUrl,
  label: trimmed(160),
  pageType: trimmed(120),
});

export const ReferenceUpdate = z.object({
  label: trimmed(160),
  pageType: trimmed(120),
  targetPages: z.array(Slug).max(40),
  attribution: trimmed(300),
});

export const ObservationInput = z.object({
  aspect: ObservationAspect,
  basis: ObservationBasis,
  text: z.string().trim().min(1, "Write the observation").max(2000),
  captureId: CaptureId.nullable(),
});

export const UserAttemptInput = z.object({
  outcome: z.enum(USER_REPORTABLE_OUTCOMES),
  detail: z.string().trim().min(1, "Say what happened, so the next person knows").max(1000),
});

export const CaptureMeta = z.object({
  kind: CaptureKind,
  tool: z.string().trim().min(1, "Name the tool used").max(80),
  capturedOn: z.iso.date("Enter the date of the capture"),
  notes: trimmed(1000),
});

export const ManualReasonInput = z.object({
  reason: z.string().trim().min(1, "Explain why this reference cannot be acquired").max(1000),
});
