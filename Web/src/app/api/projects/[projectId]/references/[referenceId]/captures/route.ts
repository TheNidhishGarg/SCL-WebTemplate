import { revalidatePath } from "next/cache";
import { MAX_CAPTURE_BYTES } from "@/domain/reference";
import { errorResponse } from "@/server/http";
import { getDashboardStore } from "@/server/store";

// Capture uploads (SaveMyResources archives, screenshots). A Route Handler
// rather than a Server Action because those cap bodies at 1 MB.
export async function POST(request: Request, ctx: RouteContext<"/api/projects/[projectId]/references/[referenceId]/captures">) {
  try {
    const { projectId, referenceId } = await ctx.params;
    const store = getDashboardStore(); // access check before reading the body
    const declared = Number(request.headers.get("content-length") ?? 0);
    if (declared > MAX_CAPTURE_BYTES + 64 * 1024) {
      return Response.json({ error: `Captures are limited to ${MAX_CAPTURE_BYTES / 1024 / 1024} MB.` }, { status: 413 });
    }
    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File)) {
      return Response.json({ error: "Choose a file to upload.", issues: [{ path: "file", message: "Choose a file" }] }, { status: 422 });
    }
    const capture = store.references.addCapture(
      projectId,
      referenceId,
      {
        kind: form.get("kind"),
        tool: String(form.get("tool") ?? ""),
        capturedOn: String(form.get("capturedOn") ?? ""),
        notes: String(form.get("notes") ?? ""),
      },
      { filename: file.name, mimeType: file.type, bytes: new Uint8Array(await file.arrayBuffer()) },
    );
    revalidatePath("/projects", "layout");
    return Response.json({ id: capture.id }, { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}
