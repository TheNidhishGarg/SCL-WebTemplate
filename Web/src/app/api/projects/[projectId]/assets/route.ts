import { revalidatePath } from "next/cache";
import { MAX_UPLOAD_BYTES } from "@/domain/asset";
import { errorResponse } from "@/server/http";
import { getDashboardStore } from "@/server/store";

// File uploads come here rather than through a Server Action, whose request
// body is capped at 1 MB by default. Link-only references use a Server Action.
export async function POST(request: Request, ctx: RouteContext<"/api/projects/[projectId]/assets">) {
  try {
    const { projectId } = await ctx.params;

    // Refuse oversized bodies before buffering them, when the client says how big.
    const declared = Number(request.headers.get("content-length") ?? 0);
    if (declared > MAX_UPLOAD_BYTES + 64 * 1024) {
      return Response.json({ error: `Files are limited to ${MAX_UPLOAD_BYTES / 1024 / 1024} MB; add a link instead.` }, { status: 413 });
    }

    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File)) {
      return Response.json({ error: "Choose a file to upload.", issues: [{ path: "file", message: "Choose a file" }] }, { status: 422 });
    }
    const asset = getDashboardStore().addAssetUpload(
      projectId,
      { kind: form.get("kind"), label: String(form.get("label") ?? ""), notes: String(form.get("notes") ?? "") },
      { filename: file.name, mimeType: file.type, bytes: new Uint8Array(await file.arrayBuffer()) },
    );
    revalidatePath("/projects", "layout");
    return Response.json({ id: asset.id }, { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}
