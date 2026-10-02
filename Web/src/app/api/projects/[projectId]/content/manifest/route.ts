import { errorResponse } from "@/server/http";
import { getDashboardStore } from "@/server/store";

export const dynamic = "force-dynamic";

// The WF-05 handoff to WF-08/09 (scl.wf-05.content-manifest/v1).
export async function GET(request: Request, ctx: RouteContext<"/api/projects/[projectId]/content/manifest">) {
  try {
    const { projectId } = await ctx.params;
    const m = getDashboardStore().content.manifest(projectId);
    const download = new URL(request.url).searchParams.has("download");
    return Response.json(m, { headers: { "Cache-Control": "no-store", ...(download && { "Content-Disposition": `attachment; filename="${m.project.slug}-content-manifest.json"` }) } });
  } catch (e) {
    return errorResponse(e);
  }
}
