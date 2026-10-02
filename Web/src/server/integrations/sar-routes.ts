import "server-only";
import { getEnv } from "@/server/env";
import { getStore } from "@/server/store";
import type { Row } from "@/server/store/errors";

// Shared by the extension's upload routes. They are called by the
// SaveAllResources extension, not by a dashboard session, so they do not use
// getDashboardStore(): each request is authorised by its capture job's own
// token instead (see sar-captures.ts). Off entirely unless the integration is
// configured.

const json = (status: number, body: unknown) => Response.json(body, { status, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });

export async function extensionRoute(
  request: Request,
  params: Promise<{ projectId: string; jobId: string }>,
  handle: (store: ReturnType<typeof getStore>["sarCaptures"], job: Row) => Promise<unknown> | unknown,
): Promise<Response> {
  try {
    const env = getEnv();
    if (!env.integrations.saveAllResources) return json(404, { error: "SaveAllResources capture is not configured." });
    const { projectId, jobId } = await params;
    const store = getStore().sarCaptures;
    const job = store.authorize(projectId, jobId, request.headers.get("authorization"), request.headers.get("origin"), env.values.SAR_EXTENSION_ID);
    return json(200, { ok: true, ...((await handle(store, job)) as object) });
  } catch (e) {
    const err = e as { name?: string; status?: number; code?: string; message: string };
    if (err.name === "CaptureAuthError") return json(err.status ?? 401, { error: err.message });
    // The extension treats 409 as "cancelled" and 400/413 as final.
    if (err.name === "StoreError") return json(err.code === "conflict" ? 409 : /limit/.test(err.message) ? 413 : 400, { error: err.message });
    console.error("[sar] upload route failed", e);
    return json(500, { error: "Something went wrong on the server." });
  }
}

export async function readJsonBody(request: Request, limit: number): Promise<unknown> {
  const text = await request.text();
  if (text.length > limit) throw Object.assign(new Error("Report too large."), { name: "StoreError", code: "invalid" });
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    throw Object.assign(new Error("Invalid JSON."), { name: "StoreError", code: "invalid" });
  }
}
