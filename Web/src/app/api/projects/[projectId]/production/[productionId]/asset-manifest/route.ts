import { errorResponse } from "@/server/http";
import { getDashboardStore } from "@/server/store";

export const dynamic = "force-dynamic";

// The WF-07 export for WF-08 (scl.wf-07.asset-manifest/v1).
export async function GET(request: Request, ctx: RouteContext<"/api/projects/[projectId]/production/[productionId]/asset-manifest">) {
  try {
    const { projectId, productionId } = await ctx.params;
    const doc = getDashboardStore().production.assetManifest(projectId, productionId);
    const download = new URL(request.url).searchParams.has("download");
    return Response.json(doc, {
      headers: { "Cache-Control": "no-store", ...(download && { "Content-Disposition": `attachment; filename="${doc.journey.key}-v${doc.journey.version}-asset-manifest.json"` }) },
    });
  } catch (e) {
    return errorResponse(e);
  }
}
