import { z } from "zod";

// Stable identifiers are UUIDs, the same form the SCL Dashboard already uses
// for client.id in every n8n job payload. Each entity gets its own branded type
// so a SceneId cannot be passed where a ProjectId is expected; at runtime they
// are plain strings and store as Postgres uuid columns.
//
// Only the IDs a module actually reads or writes today are declared here. Add
// the rest when the module that owns them is built.

export const ProjectId = z.uuid().brand<"ProjectId">();
export type ProjectId = z.infer<typeof ProjectId>;

export const ClientBriefId = z.uuid().brand<"ClientBriefId">();
export type ClientBriefId = z.infer<typeof ClientBriefId>;

export const AssetId = z.uuid().brand<"AssetId">();
export type AssetId = z.infer<typeof AssetId>;

// The SCL Dashboard's own client id. Not ours to mint - we only reference it.
export const DashboardClientId = z.uuid().brand<"DashboardClientId">();
export type DashboardClientId = z.infer<typeof DashboardClientId>;

// URL-safe, lowercase, hyphenated. Used for project slugs and page slugs.
export const Slug = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Use lowercase letters, digits and single hyphens");
