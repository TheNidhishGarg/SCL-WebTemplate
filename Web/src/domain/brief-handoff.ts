import { z } from "zod";
import { AssetFile, AssetKind } from "./asset";
import { ClientBriefContent } from "./client-brief";
import { AssetId, ClientBriefId, DashboardClientId, ProjectId, Slug } from "./ids";

// The contract WF-01 hands to WF-02..WF-10: one approved brief version plus
// the asset register as it stood when the handoff was produced. Served at
// GET /api/projects/:id/handoff and by getBriefHandoff() in-process.
//
// Consumers should parse it with BriefHandoff and record brief.id + version,
// so their own outputs say exactly which brief they were built from. A
// breaking change to this shape gets a new schema string, not an edit.

export const BRIEF_HANDOFF_SCHEMA = "scl.wf-01.brief-handoff/v1";

export const BriefHandoff = z.object({
  schema: z.literal(BRIEF_HANDOFF_SCHEMA),
  generatedAt: z.iso.datetime(),
  project: z.object({
    id: ProjectId,
    slug: Slug,
    name: z.string(),
    clientName: z.string(),
    dashboardClientId: DashboardClientId.nullable(),
  }),
  brief: z.object({
    id: ClientBriefId,
    version: z.int().min(1),
    approvedAt: z.iso.datetime(),
    content: ClientBriefContent,
  }),
  assets: z.array(
    z.object({
      id: AssetId,
      kind: AssetKind,
      label: z.string(),
      notes: z.string(),
      source: z.discriminatedUnion("type", [
        z.object({ type: z.literal("url"), url: z.string() }),
        z.object({
          type: z.literal("upload"),
          file: AssetFile.omit({ storageKey: true }).extend({
            // Relative to the app; fetching it needs the same access as the dashboard.
            downloadPath: z.string().startsWith("/api/"),
          }),
        }),
      ]),
    }),
  ),
});
export type BriefHandoff = z.infer<typeof BriefHandoff>;
