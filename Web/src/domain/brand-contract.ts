import { z } from "zod";
import { BrandContent, BrandId } from "./brand";
import { ProjectId } from "./ids";

// The WF-04 handoff to WF-05 (pages), WF-06 (journey planning), WF-07 (video)
// and WF-08 (integration): one approved brand version, its resolved CSS
// variables, what is still unconfirmed, and where its assets are.

export const BRAND_CONFIG_SCHEMA = "scl.wf-04.brand-config/v1";

export const BrandExport = z.object({
  schema: z.literal(BRAND_CONFIG_SCHEMA),
  generatedAt: z.iso.datetime(),
  project: z.object({ id: ProjectId, slug: z.string() }),
  brand: z.object({ id: BrandId, key: z.string(), name: z.string() }),
  version: z.object({ number: z.int(), status: z.enum(["draft", "approved", "superseded"]), approvedAt: z.iso.datetime().nullable() }),
  // The configuration exactly as saved, with each value's status and note.
  config: BrandContent,
  // What the CSS export contains, name for name.
  cssVariables: z.record(z.string().regex(/^--scl-[a-z0-9-]+$/), z.string()),
  reducedMotionVariables: z.record(z.string(), z.string()),
  breakpointsPx: z.object({ sm: z.number().nullable(), md: z.number().nullable(), lg: z.number().nullable(), xl: z.number().nullable() }),
  scopeSelector: z.string(),
  provenance: z.object({ confirmed: z.array(z.string()), inferred: z.array(z.string()), default: z.array(z.string()), missing: z.array(z.string()) }),
  issues: z.array(z.object({ path: z.string(), level: z.enum(["error", "warning"]), message: z.string() })),
  contrast: z.array(z.object({ fg: z.string(), bg: z.string(), ratio: z.number(), min: z.number(), passes: z.boolean() })),
  assets: z.array(
    z.object({
      use: z.string(),
      status: z.string(),
      note: z.string(),
      // A WF-01 register entry (download path) or an external https URL.
      location: z.object({ kind: z.enum(["asset", "url"]), assetId: z.string().nullable(), url: z.string() }),
    }),
  ),
});
export type BrandExport = z.infer<typeof BrandExport>;
