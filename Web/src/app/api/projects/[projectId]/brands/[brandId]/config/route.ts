import { versionParam } from "@/server/brand-version";
import { errorResponse } from "@/server/http";
import { getDashboardStore } from "@/server/store";

export const dynamic = "force-dynamic";

// The WF-04 handoff (scl.wf-04.brand-config/v1). Defaults to the approved
// version; ?version=latest or ?version=<n> for others.
export async function GET(request: Request, ctx: RouteContext<"/api/projects/[projectId]/brands/[brandId]/config">) {
  try {
    const { projectId, brandId } = await ctx.params;
    const ex = getDashboardStore().brands.exportJson(projectId, brandId, versionParam(request.url));
    const download = new URL(request.url).searchParams.has("download");
    return Response.json(ex, {
      headers: { "Cache-Control": "no-store", ...(download && { "Content-Disposition": `attachment; filename="${ex.brand.key}-brand-v${ex.version.number}.json"` }) },
    });
  } catch (e) {
    return errorResponse(e);
  }
}
