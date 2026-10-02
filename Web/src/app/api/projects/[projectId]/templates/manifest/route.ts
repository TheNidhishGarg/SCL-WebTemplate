import { errorResponse } from "@/server/http";
import { getDashboardStore } from "@/server/store";

export const dynamic = "force-dynamic";

// The WF-03 output for WF-04 and WF-05 (scl.wf-03.template-manifest/v1).
export async function GET(request: Request, ctx: RouteContext<"/api/projects/[projectId]/templates/manifest">) {
  try {
    const { projectId } = await ctx.params;
    const manifest = getDashboardStore().sources.manifest(projectId);
    const download = new URL(request.url).searchParams.has("download");
    return Response.json(manifest, {
      headers: { "Cache-Control": "no-store", ...(download && { "Content-Disposition": `attachment; filename="${manifest.project.slug}-template-manifest.json"` }) },
    });
  } catch (e) {
    return errorResponse(e);
  }
}
