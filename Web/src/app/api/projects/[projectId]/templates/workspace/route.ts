import { attachment } from "@/server/download";
import { errorResponse } from "@/server/http";
import { getDashboardStore } from "@/server/store";

export const dynamic = "force-dynamic";

// The project's extraction workspace, for opening in VS Code.
export async function GET(_r: Request, ctx: RouteContext<"/api/projects/[projectId]/templates/workspace">) {
  try {
    const { projectId } = await ctx.params;
    const ws = getDashboardStore().sources.workspaceZip(projectId);
    return attachment(ws.bytes, ws.filename);
  } catch (e) {
    return errorResponse(e);
  }
}
