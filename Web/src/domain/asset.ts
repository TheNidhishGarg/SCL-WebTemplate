import { z } from "zod";
import { AssetId, ProjectId } from "./ids";

// The WF-01 asset/reference register: what the client already has. Either a
// file uploaded here or a pointer to where it lives (Drive folder, brand
// portal, font foundry page). Generated media (WF-07) is a different thing and
// will get its own MediaAsset record with approval and versioning.

export const AssetKind = z.enum(["logo", "font", "brand_guidelines", "photography", "video", "other"]);
export type AssetKind = z.infer<typeof AssetKind>;

export const ASSET_KIND_LABELS: Record<AssetKind, string> = {
  logo: "Logo",
  font: "Font",
  brand_guidelines: "Brand guidelines",
  photography: "Photography",
  video: "Video",
  other: "Other",
};

export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024; // Larger video belongs on a link, then Mux in WF-07.

// Checked by extension, because browsers report fonts and some vector files
// inconsistently. The stored file is always served as an attachment with
// nosniff, so a mislabelled file cannot run in the dashboard's origin.
export const ALLOWED_UPLOAD_EXTENSIONS = {
  logo: ["svg", "png", "jpg", "jpeg", "webp", "pdf", "ai", "eps"],
  font: ["woff2", "woff", "ttf", "otf", "zip"],
  brand_guidelines: ["pdf", "zip", "png", "jpg", "jpeg"],
  photography: ["jpg", "jpeg", "png", "webp", "heic", "tif", "tiff", "zip"],
  video: ["mp4", "mov", "webm"],
  other: ["pdf", "zip", "png", "jpg", "jpeg", "webp", "svg", "txt", "docx", "pptx", "xlsx"],
} as const satisfies Record<AssetKind, readonly string[]>;

export const fileExtension = (filename: string): string => {
  const m = /\.([A-Za-z0-9]{1,8})$/.exec(filename);
  return m ? m[1].toLowerCase() : "";
};

const label = z.string().trim().min(1, "Give the asset a label").max(160);
const notes = z.string().trim().max(1000);

export const AssetUrlInput = z.object({
  kind: AssetKind,
  label,
  notes,
  url: z.url({ protocol: /^https?$/, normalize: true, error: "Enter a full http(s) URL" }),
});

export const AssetUploadMeta = z.object({ kind: AssetKind, label, notes });

export const AssetFile = z.object({
  storageKey: z.string().min(1),
  filename: z.string().min(1).max(255),
  mimeType: z.string().min(1).max(255),
  sizeBytes: z.int().min(1).max(MAX_UPLOAD_BYTES),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
});

export const Asset = z.object({
  id: AssetId,
  projectId: ProjectId,
  kind: AssetKind,
  label: z.string(),
  notes: z.string(),
  source: z.discriminatedUnion("type", [
    z.object({ type: z.literal("url"), url: z.string() }),
    z.object({ type: z.literal("upload"), file: AssetFile }),
  ]),
  createdAt: z.iso.datetime(),
});
export type Asset = z.infer<typeof Asset>;
