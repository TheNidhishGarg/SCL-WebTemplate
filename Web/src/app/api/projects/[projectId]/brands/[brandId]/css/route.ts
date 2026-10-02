import { versionParam } from "@/server/brand-version";
import { errorResponse } from "@/server/http";
import { getDashboardStore } from "@/server/store";

export const dynamic = "force-dynamic";

// CSS custom properties for a brand version. ?scope=brand wraps them in
// [data-scl-brand="<key>"] so several brands can share a page; the default
// is :root.
export async function GET(request: Request, ctx: RouteContext<"/api/projects/[projectId]/brands/[brandId]/css">) {
  try {
    const { projectId, brandId } = await ctx.params;
    const url = new URL(request.url);
    const css = getDashboardStore().brands.exportCss(projectId, brandId, versionParam(request.url), url.searchParams.get("scope") === "brand");
    return new Response(css, {
      headers: {
        "Content-Type": "text/css; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        ...(url.searchParams.has("download") && { "Content-Disposition": `attachment; filename="brand-${brandId}.css"` }),
      },
    });
  } catch (e) {
    return errorResponse(e);
  }
}
