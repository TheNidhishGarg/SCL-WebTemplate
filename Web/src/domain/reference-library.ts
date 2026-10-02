import { z } from "zod";
import { ClientBriefId, ProjectId } from "./ids";
import {
  AttemptMethod,
  AttemptOutcome,
  CaptureKind,
  ObservationAspect,
  REFERENCE_USAGE_NOTICE,
  ReferenceOrigin,
} from "./reference";

// The contract WF-02 hands to WF-03: a self-contained snapshot of a project's
// reference library. Served at GET /api/projects/:id/references/library.
//
// Everything WF-03 needs is in here or one documented download away; nothing
// depends on how WF-02 stores it (no storage keys, no table shapes). Every
// record carries its provenance, so WF-03 can weigh a captured file above a
// person's note and a note above an inference. A breaking change ships as a
// new schema string.

export const REFERENCE_LIBRARY_SCHEMA = "scl.wf-02.reference-library/v1";

const status = z.enum(["pending", "checked", "captured", "failed", "manual"]);

export const ReferenceLibrary = z.object({
  schema: z.literal(REFERENCE_LIBRARY_SCHEMA),
  generatedAt: z.iso.datetime(),
  usage: z.literal(REFERENCE_USAGE_NOTICE),
  project: z.object({ id: ProjectId, slug: z.string(), name: z.string() }),
  // The approved WF-01 brief at the time of export, so WF-03 can map
  // targetPages to the client's pages. Null if none is approved yet.
  brief: z.object({ id: ClientBriefId, version: z.int(), requiredPageSlugs: z.array(z.string()) }).nullable(),
  summary: z.object({
    references: z.int(),
    sites: z.int(),
    byStatus: z.record(status, z.int()),
  }),
  references: z.array(
    z.object({
      id: z.uuid(),
      url: z.string(),
      host: z.string(),
      label: z.string(),
      pageType: z.string(),
      targetPages: z.array(z.string()),
      attribution: z.string(),
      origin: ReferenceOrigin,
      briefVersion: z.int().nullable(),
      status,
      // Present when status is "manual": why it could not be acquired.
      manualReason: z.string().nullable(),
      evidence: z.object({
        attempts: z.array(
          z.object({
            id: z.uuid(),
            method: AttemptMethod,
            recordedBy: z.enum(["system", "user"]),
            outcome: AttemptOutcome,
            succeeded: z.boolean(),
            httpStatus: z.int().nullable(),
            finalUrl: z.string().nullable(),
            redirectChain: z.array(z.object({ url: z.string(), status: z.int() })),
            pageTitle: z.string().nullable(),
            contentType: z.string().nullable(),
            detail: z.string(),
            at: z.iso.datetime(),
          }),
        ),
        captures: z.array(
          z.object({
            id: z.uuid(),
            kind: CaptureKind,
            tool: z.string(),
            sourceUrl: z.string(),
            capturedOn: z.iso.date(),
            notes: z.string(),
            filename: z.string(),
            mimeType: z.string(),
            sizeBytes: z.int(),
            sha256: z.string(),
            // Relative to the app; needs the same access as the dashboard.
            downloadPath: z.string().startsWith("/api/"),
          }),
        ),
      }),
      // What people saw on the reference.
      observed: z.array(
        z.object({ id: z.uuid(), aspect: ObservationAspect, text: z.string(), captureId: z.uuid().nullable(), updatedAt: z.iso.datetime() }),
      ),
      // Interpretations: from people (basis "inferred") and from URL checks.
      inferred: z.array(
        z.object({
          source: z.enum(["person", "url_check"]),
          aspect: ObservationAspect.nullable(),
          text: z.string(),
          observationId: z.uuid().nullable(),
          attemptId: z.uuid().nullable(),
          at: z.iso.datetime(),
        }),
      ),
    }),
  ),
});
export type ReferenceLibrary = z.infer<typeof ReferenceLibrary>;

