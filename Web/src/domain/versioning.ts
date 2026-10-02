import { z } from "zod";

// Every versioned record (brief, brand configuration, content, scene manifest,
// approved media, release) moves through the same lifecycle. A version is
// immutable once it leaves draft: changing an approved record means creating
// version n+1, which is what lets a PublishedRelease point at exact versions
// and be rebuilt later.
//
// pending_approval matches the status BR-10 already emits, so records coming
// back from the n8n workflows need no translation.
export const VersionStatus = z.enum(["draft", "pending_approval", "approved", "superseded"]);
export type VersionStatus = z.infer<typeof VersionStatus>;

export const Version = z.int().min(1);

export const isEditable = (status: VersionStatus): boolean => status === "draft";
