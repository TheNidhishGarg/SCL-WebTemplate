import { revalidatePath } from "next/cache";
import { errorResponse } from "@/server/http";
import { getDashboardStore } from "@/server/store";

const MAX_FINDINGS_BYTES = 2 * 1024 * 1024;

// Imports an analyst's findings.json (multipart "file", or a JSON body).
// All or nothing: see sources.importFindings.
export async function POST(request: Request, ctx: RouteContext<"/api/projects/[projectId]/sources/[sourceId]/findings">) {
  try {
    const { projectId, sourceId } = await ctx.params;
    const store = getDashboardStore();
    if (Number(request.headers.get("content-length") ?? 0) > MAX_FINDINGS_BYTES) {
      return Response.json({ error: "Findings files are limited to 2 MB." }, { status: 413 });
    }
    let text: string;
    if ((request.headers.get("content-type") ?? "").includes("multipart/form-data")) {
      const file = (await request.formData()).get("file");
      if (!(file instanceof File) || !file.name) return Response.json({ error: "Choose findings.json.", issues: [{ path: "file", message: "Choose a file" }] }, { status: 422 });
      text = await file.text();
    } else text = await request.text();
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      return Response.json({ error: "Not valid JSON.", issues: [{ path: "file", message: "Not valid JSON" }] }, { status: 422 });
    }
    const counts = store.sources.importFindings(projectId, sourceId, data);
    revalidatePath("/projects", "layout");
    return Response.json(counts, { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}
