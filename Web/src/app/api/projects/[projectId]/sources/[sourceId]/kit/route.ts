import { attachment } from "@/server/download";
import { errorResponse } from "@/server/http";
import { getDashboardStore } from "@/server/store";

export const dynamic = "force-dynamic";

// The analysis kit for VS Code + Claude Code (see docs/wf-03.md).
export async function GET(_r: Request, ctx: RouteContext<"/api/projects/[projectId]/sources/[sourceId]/kit">) {
  try {
    const { projectId, sourceId } = await ctx.params;
    const kit = getDashboardStore().sources.analysisKit(projectId, sourceId);
    return attachment(kit.bytes, kit.filename);
  } catch (e) {
    return errorResponse(e);
  }
}
