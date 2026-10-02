import { errorResponse } from "@/server/http";
import { getTemplatePipeline } from "@/server/pipeline";
import { getDashboardStore } from "@/server/store";

export const dynamic = "force-dynamic";

// The website-template.zip SaveAllResources produced, exactly as stored.
// Always a download; it contains captured third-party files.
export async function GET(_request: Request, ctx: RouteContext<"/api/projects/[projectId]/template-jobs/[jobId]/artifact">) {
  try {
    const { projectId, jobId } = await ctx.params;
    const store = getDashboardStore(); // access check
    const job = getTemplatePipeline().get(projectId, jobId);
    if (!job.artifact) return Response.json({ error: "This generation has no stored ZIP." }, { status: 404 });
    // Streamed from storage: a 200 MB template is not read into memory.
    const { body, size } = store.streamFile(job.artifact.key);
    return new Response(body, {
      headers: {
        "Content-Type": "application/zip",
        "Content-Length": String(size),
        "Content-Disposition": `attachment; filename="${job.artifact!.filename}"`,
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "private, no-store",
        "X-Content-SHA256": job.artifact!.sha256,
      },
    });
  } catch (e) {
    return errorResponse(e);
  }
}
