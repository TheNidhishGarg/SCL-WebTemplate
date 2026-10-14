import { revalidatePath } from "next/cache";
import { MAX_CAPTURE_BYTES } from "@/domain/reference";
import { errorResponse } from "@/server/http";
import { detectSarDownload, importSaveAllResourcesExport } from "@/server/integrations/save-all-resources";
import { getTemplatePipeline } from "@/server/pipeline";
import { getDashboardStore } from "@/server/store";

// Imports a SaveAllResources export ZIP as-is: WF-02 reference capture, then a
// study-only WF-03 source. A plain download from the Chrome Web Store build of
// Save All Resources (no manifest) is handed to the website-template pipeline
// instead, which templatises it and then registers it the same way.
// A Route Handler because Server Actions cap bodies at 1 MB.
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
    const bytes = new Uint8Array(await file.arrayBuffer());
    const download = /\.zip$/i.test(file.name) ? detectSarDownload(bytes, file.name) : null;
    if (download) {
      const text = (k: string) => {
        const v = form.get(k);
        return typeof v === "string" ? v.trim() : "";
      };
      const entryUrl = text("entryUrl") || download.entryUrl;
      const job = await getTemplatePipeline().startFromDownload(projectId, { file: { filename: file.name, bytes }, entryUrl, authority: text("authority"), authorizedBy: text("authorizedBy") });
      revalidatePath("/projects", "layout");
      if (job.status === "failed") return Response.json({ error: job.error?.message ?? "SaveAllResources could not start the import." }, { status: 409 });
      return Response.json({ kind: "download", templateJobId: job.id, entryUrl, host: download.host }, { status: 202 });
    }
    const r = importSaveAllResourcesExport(store, projectId, { filename: file.name, bytes });
    revalidatePath("/projects", "layout");
    return Response.json({ kind: "export", referenceId: r.referenceId, captureId: r.captureId, sourceId: r.sourceId, createdReference: r.createdReference, entryUrl: r.export.entryUrl, jobId: r.export.jobId }, { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}
