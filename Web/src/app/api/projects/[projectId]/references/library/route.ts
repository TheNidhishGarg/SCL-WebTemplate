import { errorResponse } from "@/server/http";
import { getDashboardStore } from "@/server/store";

export const dynamic = "force-dynamic";

// The WF-02 output for WF-03: the project's reference library in the
// scl.wf-02.reference-library/v1 shape (src/domain/reference-library.ts).
export async function GET(request: Request, ctx: RouteContext<"/api/projects/[projectId]/references/library">) {
  try {
    const { projectId } = await ctx.params;
    const library = getDashboardStore().references.library(projectId);
    const download = new URL(request.url).searchParams.has("download");
    return Response.json(library, {
      headers: {
        "Cache-Control": "no-store",
        ...(download && { "Content-Disposition": `attachment; filename="${library.project.slug}-reference-library.json"` }),
      },
    });
  } catch (e) {
    return errorResponse(e);
  }
}
