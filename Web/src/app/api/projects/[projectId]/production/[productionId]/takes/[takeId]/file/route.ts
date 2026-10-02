import { errorResponse } from "@/server/http";
import { getDashboardStore } from "@/server/store";

export const dynamic = "force-dynamic";

// Takes play inline for review. The Content-Type comes from probing the bytes,
// not from the uploader; anything that probed as neither video nor PNG/JPEG
// is served as a download. Range requests let the player seek.
const INLINE = new Set(["video/mp4", "video/quicktime", "image/png", "image/jpeg"]);

export async function GET(request: Request, ctx: RouteContext<"/api/projects/[projectId]/production/[productionId]/takes/[takeId]/file">) {
  try {
    const { projectId, productionId, takeId } = await ctx.params;
    const { take, bytes } = getDashboardStore().production.readTake(projectId, productionId, takeId);
    const inline = INLINE.has(take.file.mimeType) && !new URL(request.url).searchParams.has("download");
    const headers: Record<string, string> = {
      "Content-Type": inline ? take.file.mimeType : "application/octet-stream",
      "Content-Disposition": `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(take.file.filename)}`,
      "Content-Security-Policy": "default-src 'none'; sandbox",
      "X-Content-Type-Options": "nosniff",
      "Accept-Ranges": "bytes",
      "Cache-Control": "private, max-age=300",
      ETag: `"${take.file.sha256}"`,
    };
    const size = bytes.byteLength;
    const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.get("range") ?? "");
    if (range && (range[1] || range[2])) {
      const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
      const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
      if (start >= size || start > end) return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${size}` } });
      return new Response(new Uint8Array(bytes.subarray(start, end + 1)), { status: 206, headers: { ...headers, "Content-Range": `bytes ${start}-${end}/${size}`, "Content-Length": String(end - start + 1) } });
    }
    return new Response(new Uint8Array(bytes), { headers: { ...headers, "Content-Length": String(size) } });
  } catch (e) {
    return errorResponse(e);
  }
}
