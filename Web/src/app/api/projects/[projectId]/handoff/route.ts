import { errorResponse } from "@/server/http";
import { getDashboardStore } from "@/server/store";

export const dynamic = "force-dynamic";

// The WF-01 handoff: the approved brief and asset register, in the
// scl.wf-01.brief-handoff/v1 shape (src/domain/brief-handoff.ts).
// 409 rather than 404 when the project exists but nothing is approved yet,
// so a caller can tell "wrong id" from "not ready".
export async function GET(request: Request, ctx: RouteContext<"/api/projects/[projectId]/handoff">) {
  try {
    const { projectId } = await ctx.params;
    const handoff = getDashboardStore().getBriefHandoff(projectId);
    if (!handoff) {
      return Response.json({ error: "No approved brief yet. Approve the brief in WF-01 first." }, { status: 409 });
    }
    const download = new URL(request.url).searchParams.has("download");
    return Response.json(handoff, {
      headers: {
        "Cache-Control": "no-store",
        ...(download && {
          "Content-Disposition": `attachment; filename="${handoff.project.slug}-brief-v${handoff.brief.version}.json"`,
        }),
      },
    });
  } catch (e) {
    return errorResponse(e);
  }
}
