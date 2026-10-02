import { errorResponse } from "@/server/http";
import { getPreviewManager, previewContext } from "@/server/preview";
import { getDashboardStore } from "@/server/store";

export const dynamic = "force-dynamic";

// The edited template as a deliverable: raw capture, manifests and the
// generator's reports from the stored ZIP, with the current template
// (sources, composition, overrides, tokens), Web's reports and EDITING.md.
// Always a download; it contains captured third-party files.
export async function GET(_request: Request, ctx: RouteContext<"/api/projects/[projectId]/template-jobs/[jobId]/export">) {
  try {
    const { projectId, jobId } = await ctx.params;
    getDashboardStore(); // access check
    const c = previewContext(projectId, jobId);
    const m = getPreviewManager();
    m.ensureWorkspace(jobId, c.zip);
    const bytes = m.exportZip(jobId, c.zip);
    return new Response(new Uint8Array(bytes), {
      headers: {
        "Content-Type": "application/zip",
        "Content-Length": String(bytes.byteLength),
        "Content-Disposition": `attachment; filename="website-template-${jobId}-edited.zip"`,
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "private, no-store",
      },
    });
  } catch (e) {
    return errorResponse(e);
  }
}
