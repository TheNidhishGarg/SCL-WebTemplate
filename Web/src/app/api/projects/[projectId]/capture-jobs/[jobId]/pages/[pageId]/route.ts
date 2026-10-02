import { MAX_CAPTURE_BYTES } from "@/domain/reference";
import { extensionRoute } from "@/server/integrations/sar-routes";

// PUT one captured page (application/zip) from the SaveAllResources extension.
export async function PUT(request: Request, ctx: RouteContext<"/api/projects/[projectId]/capture-jobs/[jobId]/pages/[pageId]">) {
  return extensionRoute(request, ctx.params, async (store, job) => {
    const { pageId } = await ctx.params;
    if (!/zip/.test(request.headers.get("content-type") ?? "")) throw Object.assign(new Error("Expected application/zip."), { name: "StoreError", code: "invalid" });
    if (Number(request.headers.get("content-length") ?? 0) > MAX_CAPTURE_BYTES) {
      throw Object.assign(new Error(`The page exceeds the ${MAX_CAPTURE_BYTES / 1024 / 1024} MB limit for WF-02 captures.`), { name: "StoreError", code: "invalid" });
    }
    return store.receivePage(job, decodeURIComponent(pageId), new Uint8Array(await request.arrayBuffer()));
  });
}
