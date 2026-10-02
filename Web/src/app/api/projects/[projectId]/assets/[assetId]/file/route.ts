import { errorResponse } from "@/server/http";
import { getDashboardStore } from "@/server/store";

export const dynamic = "force-dynamic";

// Always a download, never rendered inline, and nosniff: an uploaded SVG or
// HTML file must not execute in the dashboard's origin.
export async function GET(_request: Request, ctx: RouteContext<"/api/projects/[projectId]/assets/[assetId]/file">) {
  try {
    const { projectId, assetId } = await ctx.params;
    const { asset, bytes } = getDashboardStore().readAssetFile(projectId, assetId);
    if (asset.source.type !== "upload") throw new Error("unreachable");
    const { filename } = asset.source.file;
    return new Response(new Uint8Array(bytes), {
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Length": String(bytes.byteLength),
        "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "private, no-store",
      },
    });
  } catch (e) {
    return errorResponse(e);
  }
}
