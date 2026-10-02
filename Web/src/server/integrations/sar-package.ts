import { createHash } from "node:crypto";
import { zipSync } from "fflate";
import { ArchiveError, readArchive, safePath } from "@/server/wf03/archive";
import { WEB_GENERATOR } from "./save-all-resources";

// Packages a capture that the SaveAllResources extension sent straight to Web
// (one ZIP per page) into the export layout the WF-02/WF-03 importer reads:
//
//   website-template/manifest.json                       manifest v1 (generator scl-web-sar-capture)
//   website-template/raw-capture/sar-page-zips/<id>.zip  each uploaded page ZIP, byte for byte
//   website-template/raw-capture/pages/<id>/…            page.json, original/rendered HTML, screenshots
//   website-template/raw-capture/resources/…             resource bodies, de-duplicated by SHA-256
//
// Written for Web from the documented format of SaveAllResources exports; no
// SaveAllResources code is used. Page ZIPs are read with WF-03's readArchive,
// so the same path-safety and size rules apply as for any archive. Nothing is
// templatised here: templates are WF-03's job, under its authority rules.

export const MANIFEST_VERSION = "1.0.0";

// The /complete payload from the extension (the parts this packager uses).
export type CaptureResult = {
  status?: string;
  startedAt?: number | null;
  finishedAt?: number | null;
  limits?: unknown;
  discovery?: unknown;
  discoveryComplete?: boolean | null;
  skippedUrls?: unknown;
  errors?: unknown;
  options?: unknown;
  pages?: CapturedPage[];
};
export type CapturedPage = {
  id: string;
  url?: string;
  status?: string;
  finalUrl?: string | null;
  reason?: string | null;
  httpStatus?: number | null;
  depth?: number;
  via?: string;
  aliasOf?: string | null;
  redirects?: unknown[];
  title?: string | null;
  attempts?: number;
  warnings?: unknown[];
  uploadError?: string | null;
};

type PageMeta = {
  finalUrl?: string;
  title?: string;
  screenshots?: Record<string, { path: string; width?: number; height?: number; truncated?: boolean }>;
  resources?: { url: string; path: string; type?: string }[];
  requests?: { url: string; mimeType?: string; resourceType?: string }[];
  failedRequests?: unknown;
};

const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const STORED = /\.(png|jpe?g|gif|webp|avif|woff2?|zip|mp4|webm|mp3|gz)$/i; // already compressed

export type PackageOutcome = {
  zip: Uint8Array;
  pages: { listed: number; packaged: string[]; missing: string[]; corrupt: { id: string; reason: string }[]; notCaptured: number };
};

export function packageSarCapture(input: { jobId: string; entryUrl: string; createdAt: string; result: CaptureResult; uploads: Map<string, Uint8Array> }): PackageOutcome {
  const root = "website-template/";
  const out: Record<string, [Uint8Array, { level: 0 | 6 }]> = {};
  const put = (path: string, bytes: Uint8Array) => (out[`${root}${path}`] = [bytes, { level: STORED.test(path) ? 0 : 6 }]);
  const enc = new TextEncoder();

  const pagesIn = Array.isArray(input.result.pages) ? input.result.pages : [];
  const resources = new Map<string, Record<string, unknown>>(); // url -> entry
  const bodies = new Map<string, string>(); // sha -> stored path
  const owners = new Map<string, string>(); // stored path -> sha
  const packaged: string[] = [];
  const missing: string[] = [];
  const corrupt: { id: string; reason: string }[] = [];
  const pages: Record<string, unknown>[] = [];

  for (const p of pagesIn) {
    const record: Record<string, unknown> = {
      id: p.id,
      requestedUrl: p.url ?? null,
      finalUrl: p.finalUrl ?? null,
      status: p.status ?? null,
      reason: p.reason ?? null,
      httpStatus: p.httpStatus ?? null,
      depth: p.depth ?? null,
      discoveredVia: p.via ?? null,
      aliasOf: p.aliasOf ?? null,
      redirects: p.redirects ?? [],
      title: p.title ?? null,
      attempts: p.attempts ?? null,
      captureWarnings: p.warnings ?? [],
      uploaded: input.uploads.has(p.id),
    };
    pages.push(record);
    if (p.status !== "captured") continue;
    const zipBytes = input.uploads.get(p.id);
    if (!zipBytes) {
      record.status = "capture_not_uploaded";
      record.reason = p.uploadError || "captured in the browser, but the page package never reached Web";
      missing.push(p.id);
      continue;
    }
    // The original page package, unchanged.
    put(`raw-capture/sar-page-zips/${p.id}.zip`, zipBytes);
    record.sarZip = `raw-capture/sar-page-zips/${p.id}.zip`;
    record.sarZipSha256 = sha(zipBytes);

    let entries: Map<string, Uint8Array>;
    try {
      const a = readArchive(zipBytes);
      // readArchive strips one shared top-level folder; restore the original names.
      entries = new Map(a.files.map((f) => [`${a.rootPrefix}${f.path}`, f.bytes]));
    } catch (e) {
      const reason = e instanceof ArchiveError ? e.message : String(e);
      record.status = "corrupt_capture";
      record.reason = reason;
      corrupt.push({ id: p.id, reason });
      continue;
    }
    const metaBytes = entries.get("_capture/page.json");
    let meta: PageMeta;
    try {
      meta = JSON.parse(new TextDecoder().decode(metaBytes)) as PageMeta;
      if (!metaBytes || typeof meta !== "object" || meta === null) throw new Error("missing");
    } catch {
      record.status = "corrupt_capture";
      record.reason = "page.json is missing or unreadable in the page package";
      corrupt.push({ id: p.id, reason: String(record.reason) });
      continue;
    }
    const dir = `raw-capture/pages/${p.id}/`;
    put(`${dir}page.json`, metaBytes!);
    for (const name of ["document.original.html", "document.rendered.html"]) {
      const b = entries.get(`_capture/${name}`);
      if (b) put(`${dir}${name}`, b);
    }
    record.rawPath = dir;
    record.hasOriginalHtml = entries.has("_capture/document.original.html");
    record.hasRenderedHtml = entries.has("_capture/document.rendered.html");
    const shots: Record<string, unknown> = {};
    for (const [kind, s] of Object.entries(meta.screenshots ?? {})) {
      const b = s && typeof s.path === "string" ? entries.get(s.path) : undefined;
      if (!b || !/^[a-z0-9-]{1,40}$/.test(kind)) continue;
      put(`${dir}screenshots/${kind}.png`, b);
      shots[kind] = { path: `${dir}screenshots/${kind}.png`, width: s.width ?? null, height: s.height ?? null, truncated: s.truncated ?? null };
    }
    record.screenshots = shots;
    if (meta.finalUrl) record.finalUrl = meta.finalUrl;
    if (meta.title) record.title = meta.title;
    record.failedRequests = meta.failedRequests ?? [];

    const requestByUrl = new Map((meta.requests ?? []).map((r) => [r.url, r]));
    for (const r of meta.resources ?? []) {
      if (!r || typeof r.url !== "string" || typeof r.path !== "string") continue;
      const body = entries.get(r.path);
      const existing = resources.get(r.url);
      if (!body || body.byteLength === 0) {
        if (!existing) resources.set(r.url, { url: r.url, localPath: null, contentType: null, size: 0, sha256: null, pages: [p.id], status: "no-content" });
        continue;
      }
      const hash = sha(body);
      if (existing && existing.sha256 === hash) {
        if (!(existing.pages as string[]).includes(p.id)) (existing.pages as string[]).push(p.id);
        continue;
      }
      let stored = bodies.get(hash);
      if (!stored) {
        // The extension's folder-preserving path, made safe; a different body at the same path gets a suffix.
        let path = safePath(r.path) ?? `unnamed/${hash.slice(0, 16)}`;
        if (owners.has(path) && owners.get(path) !== hash) path = path.replace(/(\.[^./]+)?$/, `.c${hash.slice(0, 8)}$1`);
        owners.set(path, hash);
        bodies.set(hash, path);
        put(`raw-capture/resources/${path}`, body);
        stored = path;
      }
      const entry = {
        url: r.url,
        localPath: `raw-capture/resources/${stored}`,
        contentType: requestByUrl.get(r.url)?.mimeType ?? null,
        resourceType: requestByUrl.get(r.url)?.resourceType ?? r.type ?? null,
        size: body.byteLength,
        sha256: hash,
        pages: [p.id],
        status: "captured",
      };
      if (existing) ((existing.variants ??= []) as unknown[]).push(entry);
      else resources.set(r.url, entry);
    }
    packaged.push(p.id);
  }

  const r = input.result;
  const manifest = {
    manifestVersion: MANIFEST_VERSION,
    generator: WEB_GENERATOR,
    jobId: input.jobId,
    createdAt: input.createdAt,
    entryUrl: input.entryUrl,
    captureOptions: r.options ?? null,
    capture: {
      engine: "Save All Resources (automation build), sent to SCL Web",
      status: r.status ?? null,
      startedAt: r.startedAt ?? null,
      finishedAt: r.finishedAt ?? null,
      limits: r.limits ?? null,
      discovery: r.discovery ?? null,
      discoveryComplete: r.discoveryComplete ?? null,
      skippedUrls: r.skippedUrls ?? [],
      errors: r.errors ?? [],
    },
    pages,
    resources: [...resources.values()].sort((a, b) => String(a.url).localeCompare(String(b.url))),
    privacy: { cookiesExported: false, requestHeadersExported: false },
    processing: { packagedBy: "scl-web", templatising: "not run: WF-03 decides templates under its authority rules" },
  };
  put("manifest.json", enc.encode(JSON.stringify(manifest, null, 2) + "\n"));
  return {
    zip: zipSync(out),
    pages: { listed: pagesIn.length, packaged, missing, corrupt, notCaptured: pagesIn.filter((p) => p.status !== "captured").length },
  };
}
