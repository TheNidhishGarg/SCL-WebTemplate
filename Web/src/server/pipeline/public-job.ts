import type { TemplateJob } from "@/server/store/template-jobs";

// What the dashboard may see of a template job: no storage keys, no process
// ids, no filesystem paths.
export function publicTemplateJob(j: TemplateJob) {
  return {
    id: j.id,
    sourceUrl: j.sourceUrl,
    authority: j.authority,
    status: j.status,
    stage: j.stage,
    stages: j.stages,
    progress: j.progress,
    options: j.options,
    sarJobId: j.sarJobId,
    cancelRequested: j.cancelRequested,
    artifact: j.artifact ? { filename: j.artifact.filename, bytes: j.artifact.bytes, sha256: j.artifact.sha256 } : null,
    referenceId: j.referenceId,
    sourceId: j.sourceId,
    scanDigest: j.scanDigest,
    brandId: j.brandId,
    pagesGenerated: j.pagesGenerated,
    error: j.error,
    createdAt: j.createdAt,
    startedAt: j.startedAt,
    completedAt: j.completedAt,
    cancelledAt: j.cancelledAt,
  };
}
export type PublicTemplateJob = ReturnType<typeof publicTemplateJob>;
