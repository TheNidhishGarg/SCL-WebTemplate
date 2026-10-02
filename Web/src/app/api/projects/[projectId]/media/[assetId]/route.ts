import { errorResponse } from "@/server/http";
import { getDashboardStore } from "@/server/store";

export const dynamic = "force-dynamic";

const IMAGE_TYPES: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif", avif: "image/avif", svg: "image/svg+xml" };

// Register images served inline for WF-05 pages. Only image types, and with a
// sandboxing Content-Security-Policy, so even an SVG opened directly cannot
// run script. Everything else stays a download (assets/:id/file).
export async function GET(_r: Request, ctx: RouteContext<"/api/projects/[projectId]/media/[assetId]">) {
  try {
    const { projectId, assetId } = await ctx.params;
    const { asset, bytes } = getDashboardStore().readAssetFile(projectId, assetId);
    if (asset.source.type !== "upload") throw new Error("unreachable");
    const ext = asset.source.file.filename.split(".").pop()?.toLowerCase() ?? "";
    const type = IMAGE_TYPES[ext];
    if (!type) return Response.json({ error: "Not an image." }, { status: 415 });
    return new Response(new Uint8Array(bytes), {
      headers: {
        "Content-Type": type,
        "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "private, max-age=300",
      },
    });
  } catch (e) {
    return errorResponse(e);
  }
}
