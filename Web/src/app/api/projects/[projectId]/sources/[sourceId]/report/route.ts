import { errorResponse } from "@/server/http";
import { getDashboardStore } from "@/server/store";

export const dynamic = "force-dynamic";

// The source analysis report: the latest scan, with findings split into facts
// and assumptions, questions, and templates (scl.wf-03.analysis-report/v1).
export async function GET(request: Request, ctx: RouteContext<"/api/projects/[projectId]/sources/[sourceId]/report">) {
  try {
    const { projectId, sourceId } = await ctx.params;
    const report = getDashboardStore().sources.analysisReport(projectId, sourceId);
    const download = new URL(request.url).searchParams.has("download");
    return Response.json(report, {
      headers: { "Cache-Control": "no-store", ...(download && { "Content-Disposition": `attachment; filename="analysis-report-${sourceId}.json"` }) },
    });
  } catch (e) {
    return errorResponse(e);
  }
}
