import { attachment } from "@/server/download";
import { errorResponse } from "@/server/http";
import { getDashboardStore } from "@/server/store";

export const dynamic = "force-dynamic";

// The exact archive that was analysed, so any result can be reproduced.
export async function GET(_r: Request, ctx: RouteContext<"/api/projects/[projectId]/sources/[sourceId]/archive">) {
  try {
    const { projectId, sourceId } = await ctx.params;
    const store = getDashboardStore();
    const { source } = store.sources.get(projectId, sourceId);
    // Streamed: an archive registered from a capture can be up to 200 MB.
    return attachment(store.streamFile(source.archive.storageKey), source.archive.filename);
  } catch (e) {
    return errorResponse(e);
  }
}
