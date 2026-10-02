import { revalidatePath } from "next/cache";
import { MAX_SOURCE_BYTES } from "@/server/store/sources";
import { errorResponse } from "@/server/http";
import { getDashboardStore } from "@/server/store";

// Registers an uploaded source archive (a repository zip, `git archive`
// output, or authorised site files) with its authority and provenance.
export async function POST(request: Request, ctx: RouteContext<"/api/projects/[projectId]/sources">) {
  try {
    const { projectId } = await ctx.params;
    const store = getDashboardStore();
    if (Number(request.headers.get("content-length") ?? 0) > MAX_SOURCE_BYTES + 64 * 1024) {
      return Response.json({ error: `Source archives are limited to ${MAX_SOURCE_BYTES / 1024 / 1024} MB.` }, { status: 413 });
    }
    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File) || !file.name) {
      return Response.json({ error: "Choose the .zip to upload.", issues: [{ path: "file", message: "Choose a file" }] }, { status: 422 });
    }
    const field = (k: string) => String(form.get(k) ?? "");
    const source = store.sources.registerUpload(
      projectId,
      {
        label: field("label"),
        originUrl: field("originUrl"),
        originRef: field("originRef"),
        authorization: { basis: field("basis"), note: field("note"), license: field("license") },
      },
      { filename: file.name, bytes: new Uint8Array(await file.arrayBuffer()) },
    );
    revalidatePath("/projects", "layout");
    return Response.json({ id: source.id }, { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}
