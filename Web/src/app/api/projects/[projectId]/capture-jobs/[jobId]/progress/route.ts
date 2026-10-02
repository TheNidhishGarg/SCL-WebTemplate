import { extensionRoute, readJsonBody } from "@/server/integrations/sar-routes";

// POST progress from the SaveAllResources extension; answers whether to stop.
export async function POST(request: Request, ctx: RouteContext<"/api/projects/[projectId]/capture-jobs/[jobId]/progress">) {
  return extensionRoute(request, ctx.params, async (store, job) => store.progress(job, await readJsonBody(request, 200_000)));
}
