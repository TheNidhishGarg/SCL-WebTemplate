import { revalidatePath } from "next/cache";
import { MAX_CAPTURE_BYTES } from "@/domain/reference";
import { errorResponse } from "@/server/http";
import { importSaveAllResourcesExport } from "@/server/integrations/save-all-resources";
import { getDashboardStore } from "@/server/store";

// Imports a SaveAllResources export ZIP as-is: WF-02 reference capture, then a
// study-only WF-03 source. A Route Handler because Server Actions cap bodies at 1 MB.
export async function POST(request: Request, ctx: RouteContext<"/api/projects/[projectId]/references/import/save-all-resources">) {
  try {
    const { projectId } = await ctx.params;
    const store = getDashboardStore(); // access check before reading the body
    const declared = Number(request.headers.get("content-length") ?? 0);
    if (declared > MAX_CAPTURE_BYTES + 64 * 1024) {
      return Response.json({ error: `Captures are limited to ${MAX_CAPTURE_BYTES / 1024 / 1024} MB.` }, { status: 413 });
    }
    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File)) {
      return Response.json({ error: "Choose the SaveAllResources export (.zip).", issues: [{ path: "file", message: "Choose a file" }] }, { status: 422 });
    }
    const r = importSaveAllResourcesExport(store, projectId, { filename: file.name, bytes: new Uint8Array(await file.arrayBuffer()) });
    revalidatePath("/projects", "layout");
    return Response.json({ referenceId: r.referenceId, captureId: r.captureId, sourceId: r.sourceId, createdReference: r.createdReference, entryUrl: r.export.entryUrl, jobId: r.export.jobId }, { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}
