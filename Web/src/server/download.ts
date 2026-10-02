import "server-only";

// Binary downloads from the dashboard: always attachments, never rendered.
// Takes bytes, or a stream with its size (large files are streamed).
export function attachment(data: Uint8Array | { body: ReadableStream<Uint8Array>; size: number }, filename: string): Response {
  const streamed = !(data instanceof Uint8Array);
  return new Response(streamed ? data.body : new Uint8Array(data), {
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Length": String(streamed ? data.size : data.byteLength),
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "private, no-store",
    },
  });
}
