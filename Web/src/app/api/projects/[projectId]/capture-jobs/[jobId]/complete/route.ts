import { revalidatePath } from "next/cache";
import { extensionRoute, readJsonBody } from "@/server/integrations/sar-routes";

// POST the final report from the SaveAllResources extension. Web packages the
// uploaded pages and registers them (WF-02 capture + WF-03 source) only if the
// capture is complete; the job's token is revoked either way.
export async function POST(request: Request, ctx: RouteContext<"/api/projects/[projectId]/capture-jobs/[jobId]/complete">) {
  return extensionRoute(request, ctx.params, async (store, job) => {
    const r = store.complete(job, await readJsonBody(request, 20_000_000));
    revalidatePath("/projects", "layout");
    return r;
  });
}
