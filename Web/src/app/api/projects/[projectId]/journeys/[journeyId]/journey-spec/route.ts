import { versionParam } from "@/server/brand-version";
import { errorResponse } from "@/server/http";
import { getDashboardStore } from "@/server/store";

export const dynamic = "force-dynamic";

// The WF-06 export for WF-08 (scl.wf-06.journey-spec/v1). Approved version by
// default; ?version=latest or ?version=<n> for others.
export async function GET(request: Request, ctx: RouteContext<"/api/projects/[projectId]/journeys/[journeyId]/journey-spec">) {
  try {
    const { projectId, journeyId } = await ctx.params;
    const doc = getDashboardStore().journeys.journeySpec(projectId, journeyId, versionParam(request.url));
    const download = new URL(request.url).searchParams.has("download");
    return Response.json(doc, {
      headers: { "Cache-Control": "no-store", ...(download && { "Content-Disposition": `attachment; filename="${doc.journey.key}-v${doc.version.number}-journey-spec.json"` }) },
    });
  } catch (e) {
    return errorResponse(e);
  }
}
