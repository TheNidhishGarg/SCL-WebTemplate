import { revalidatePath } from "next/cache";
import { errorResponse } from "@/server/http";
import { getDashboardStore } from "@/server/store";
import { MAX_TAKE_BYTES } from "@/server/store/production";

// Manual upload of a take made elsewhere (Flow, a provider's own app, a shoot).
// A route rather than a Server Action: video exceeds the 1 MB action body cap.
export async function POST(request: Request, ctx: RouteContext<"/api/projects/[projectId]/production/[productionId]/shots/[slotId]/upload">) {
  try {
    const { projectId, productionId, slotId } = await ctx.params;
    const declared = Number(request.headers.get("content-length") ?? 0);
    if (declared > MAX_TAKE_BYTES + 64 * 1024) return Response.json({ error: "Files are limited to 500 MB." }, { status: 413 });
    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File) || file.size === 0) {
      return Response.json({ error: "Choose a file to upload.", issues: [{ path: "file", message: "Choose a file" }] }, { status: 422 });
    }
    const take = getDashboardStore().production.uploadManual(projectId, productionId, slotId, { filename: file.name, bytes: new Uint8Array(await file.arrayBuffer()), tool: form.get("tool") });
    revalidatePath("/projects", "layout");
    return Response.json({ id: take.id, passed: take.passed, checks: take.checks }, { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}
