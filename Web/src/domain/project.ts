import { z } from "zod";
import { DashboardClientId, ProjectId, Slug } from "./ids";

// What a project delivers. A conventional site must work on its own; the
// cinematic journey is an addition, never a prerequisite (WF-02..05 do not
// depend on WF-06/07).
export const DeliveryMode = z.enum(["conventional", "cinematic", "combined"]);
export type DeliveryMode = z.infer<typeof DeliveryMode>;

export const DELIVERY_MODE_LABELS: Record<DeliveryMode, string> = {
  conventional: "Conventional website",
  cinematic: "Cinematic journey",
  combined: "Website + cinematic journey",
};

export const includesCinematic = (mode: DeliveryMode): boolean => mode !== "conventional";
export const includesConventional = (mode: DeliveryMode): boolean => mode !== "cinematic";

// Identity only. Everything descriptive about the work - delivery mode, pages,
// audiences - lives in the versioned ClientBrief, so it can be approved and
// pinned by later releases.
export const Project = z.object({
  id: ProjectId,
  slug: Slug,
  name: z.string().trim().min(1).max(120),
  clientName: z.string().trim().min(1).max(160),
  // Optional: a project may start before the client exists in the SCL Dashboard.
  dashboardClientId: DashboardClientId.nullable(),
  status: z.enum(["active", "archived"]),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type Project = z.infer<typeof Project>;

export const ProjectInput = z.object({
  name: z.string().trim().min(1, "Project name is required").max(120),
  clientName: z.string().trim().min(1, "Client or business name is required").max(160),
});
export type ProjectInput = z.infer<typeof ProjectInput>;
