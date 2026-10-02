import { z } from "zod";

// WF-07: producing the media an approved WF-06 journey needs, before
// publication. One production per approved journey version; one shot per
// asset slot in that version's scene manifest. Every result is a take - a
// stored, checked file - and a shot is done when a person approves a take or
// explicitly marks the shot blocked. Nothing here plays to visitors and
// nothing is generated per visitor.

export const ProviderId = z.enum(["runway", "veo"]);
export type ProviderId = z.infer<typeof ProviderId>;
export const PROVIDER_LABELS: Record<ProviderId | "manual", string> = { runway: "Runway", veo: "Veo (Gemini API)", manual: "Manual upload (Flow or any tool)" };

export const JobStatus = z.enum(["queued", "generating", "completed", "failed", "canceled"]);
export type JobStatus = z.infer<typeof JobStatus>;
export const ACTIVE_JOB: JobStatus[] = ["queued", "generating"];
export const MAX_ATTEMPTS = 3;

// "superseded": was approved, then another take was approved for the shot.
export const ReviewStatus = z.enum(["review_required", "approved", "superseded", "rejected"]);
export type ReviewStatus = z.infer<typeof ReviewStatus>;

// The shot's state, derived from its jobs, takes and blocking - never stored.
export type ShotStatus = "pending" | "queued" | "generating" | "failed" | "review_required" | "approved" | "rejected" | "blocked";
export const SHOT_LABELS: Record<ShotStatus, string> = {
  pending: "Not started",
  queued: "Queued",
  generating: "Generating",
  failed: "Failed",
  review_required: "Review required",
  approved: "Approved",
  rejected: "All takes rejected",
  blocked: "Blocked",
};

export function shotStatus(s: {
  blockedReason: string | null;
  approvedTakeId: string | null;
  jobs: { status: JobStatus; updatedAt: string }[];
  takes: { review: ReviewStatus }[];
}): ShotStatus {
  if (s.approvedTakeId) return "approved";
  if (s.blockedReason) return "blocked";
  if (s.jobs.some((j) => j.status === "generating")) return "generating";
  if (s.jobs.some((j) => j.status === "queued")) return "queued";
  if (s.takes.some((t) => t.review === "review_required")) return "review_required";
  const last = [...s.jobs].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
  if (last?.status === "failed") return "failed";
  if (s.takes.length && s.takes.every((t) => t.review === "rejected" || t.review === "superseded")) return "rejected";
  return "pending";
}

export const Check = z.object({ key: z.string(), passed: z.boolean(), message: z.string() });
export type Check = z.infer<typeof Check>;

// What a reviewer confirms by watching, because no server check can.
export const REVIEW_CONFIRMATIONS = {
  plays: "I played the whole take and it plays correctly",
  noText: "There is no text, caption, logo or interface element in the frame",
  loop: "The loop is seamless",
} as const;

// ------------------------------------------------------------ WF-08 export

export const ASSET_MANIFEST_SCHEMA = "scl.wf-07.asset-manifest/v1";

export const AssetManifest = z.object({
  schema: z.literal(ASSET_MANIFEST_SCHEMA),
  generatedAt: z.iso.datetime(),
  project: z.object({ id: z.string(), slug: z.string() }),
  journey: z.object({ id: z.string(), key: z.string(), version: z.int() }),
  productionId: z.string(),
  // True when every required slot has an approved asset (none blocked or missing).
  complete: z.boolean(),
  preparation: z.literal("All media is produced, checked and approved before publication. Nothing is generated per visitor."),
  scenes: z.array(
    z.object({
      sceneId: z.string(),
      title: z.string(),
      slots: z.array(
        z.object({
          slotId: z.string(),
          kind: z.enum(["video", "loop", "still", "audio"]),
          label: z.string(),
          required: z.boolean(),
          status: z.enum(["approved", "blocked", "missing"]),
          blockedReason: z.string().nullable(),
          asset: z
            .object({
              takeId: z.string(),
              url: z.string(),
              mimeType: z.string(),
              sizeBytes: z.int(),
              sha256: z.string(),
              durationSeconds: z.number().nullable(),
              width: z.int().nullable(),
              height: z.int().nullable(),
              source: z.enum(["provider", "manual_upload"]),
              provider: z.string(),
              model: z.string().nullable(),
              providerJobId: z.string().nullable(),
              promptVersion: z.int().nullable(),
              approvedAt: z.iso.datetime(),
            })
            .nullable(),
        }),
      ),
    }),
  ),
  counts: z.object({ slots: z.int(), approved: z.int(), blocked: z.int(), missing: z.int() }),
});
export type AssetManifest = z.infer<typeof AssetManifest>;
