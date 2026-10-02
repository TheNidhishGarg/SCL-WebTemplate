import { errorResponse } from "@/server/http";
import { getDashboardStore } from "@/server/store";

export const dynamic = "force-dynamic";

// Always an attachment with nosniff: a captured page's HTML or SVG must never
// run in the dashboard's origin.
export async function GET(_request: Request, ctx: RouteContext<"/api/projects/[projectId]/references/[referenceId]/captures/[captureId]/file">) {
  try {
    const { projectId, referenceId, captureId } = await ctx.params;
    const store = getDashboardStore();
    const capture = store.references.get(projectId, referenceId).captures.find((c) => c.id === captureId);
    if (!capture) return Response.json({ error: "Capture not found." }, { status: 404 });
    // Streamed: captures can be up to the 200 MB WF-02 limit.
    const { body, size } = store.streamFile(capture.file.storageKey);
    return new Response(body, {
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Length": String(size),
        "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(capture.file.filename)}`,
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "private, no-store",
      },
    });
  } catch (e) {
    return errorResponse(e);
  }
}
