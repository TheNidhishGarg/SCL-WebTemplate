import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strToU8, zipSync } from "fflate";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MAX_CAPTURE_BYTES } from "@/domain/reference";
import { TemplateManifest } from "@/domain/wf03";
import { readArchive } from "@/server/wf03/archive";
import { openDatabase } from "./db";
import type { Row } from "./errors";
import { CaptureAuthError } from "./sar-captures";
import { createStore, StoreError, type Store } from "./store";

// Web's side of a SaveAllResources capture, without a browser: the job, the
// upload token rules, page uploads, and what completion may register.
// Page packages are TEST FIXTURES laid out as the extension sends them
// (<host>/<path> resources + _capture/page.json, HTML, screenshots).
// Opt-in replay of a real capture: SAR_EXPORT_ZIP=/path/to/export.zip.

const EXT = "jfpfjjalojpaffneaemkcjbdnmbaognl";
const ORIGIN = `chrome-extension://${EXT}`;
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function pageZip(id: string, title: string) {
  const html = `<!doctype html><html lang="en"><head><title>${title}</title><link rel="stylesheet" href="/css/site.css"></head><body><header class="site-header"><nav><a href="/">Home</a><a href="/about/">About</a></nav></header><main><h1>${title}</h1></main></body></html>`;
  const path = id === "home" ? "127.0.0.14200/index.html" : `127.0.0.14200/${id}/index.html`;
  const meta = {
    url: `http://127.0.0.1:4200/${id === "home" ? "" : `${id}/`}`,
    finalUrl: `http://127.0.0.1:4200/${id === "home" ? "" : `${id}/`}`,
    title,
    screenshots: { desktop: { path: "_capture/screenshots/desktop.png", width: 1366, height: 900, truncated: false } },
    resources: [
      { url: `http://127.0.0.1:4200/${id === "home" ? "" : `${id}/`}`, path, type: "document" },
      { url: "http://127.0.0.1:4200/css/site.css", path: "127.0.0.14200/css/site.css", type: "stylesheet" },
    ],
    requests: [{ url: "http://127.0.0.1:4200/css/site.css", mimeType: "text/css", resourceType: "Stylesheet" }],
    failedRequests: [],
  };
  return zipSync({
    [path]: strToU8(html),
    "127.0.0.14200/css/site.css": strToU8(":root { --brand: #0a84ff; }\nbody { color: #111; }\n"),
    "_capture/page.json": strToU8(JSON.stringify(meta)),
    "_capture/document.original.html": strToU8(html),
    "_capture/document.rendered.html": strToU8(html),
    "_capture/screenshots/desktop.png": PNG,
  });
}
const result = (pages: { id: string; status: string }[], over: Record<string, unknown> = {}) => ({
  jobId: "x",
  url: "http://127.0.0.1:4200/",
  status: "completed",
  startedAt: Date.parse("2026-10-01T10:00:00Z"),
  finishedAt: Date.parse("2026-10-01T10:02:00Z"),
  discoveryComplete: true,
  errors: [],
  options: { maxPages: 10 },
  pages: pages.map((p) => ({ ...p, url: `http://127.0.0.1:4200/${p.id === "home" ? "" : `${p.id}/`}`, depth: 0, via: "entry" })),
  ...over,
});

let dir: string;
let store: Store;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "scl-sarjob-"));
  store = createStore(openDatabase(join(dir, "scl.sqlite")), join(dir, "uploads"), { checkUrl: async () => { throw new Error("no network in tests"); } });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const fails = (fn: () => unknown, check: (e: unknown) => void) => {
  try {
    fn();
  } catch (e) {
    check(e);
    return;
  }
  throw new Error("expected an error");
};
const denied = (fn: () => unknown, status = 401) => fails(fn, (e) => (expect(e).toBeInstanceOf(CaptureAuthError), expect((e as CaptureAuthError).status).toBe(status)));
const storeErr = (fn: () => unknown, code: string) => fails(fn, (e) => (expect(e).toBeInstanceOf(StoreError), expect((e as StoreError).code).toBe(code)));

function begin(url = "http://127.0.0.1:4200/") {
  const p = store.createProject({ name: "P", clientName: "C" });
  const { job, message } = store.sarCaptures.start(p.id, { url }, "http://localhost:3100");
  const auth = (token = message.upload.token, projectId = p.id, jobId = job.id, origin: string | null = ORIGIN) => store.sarCaptures.authorize(projectId, jobId, `Bearer ${token}`, origin, EXT);
  return { p, job, message, auth };
}

describe("capture jobs and upload permission", () => {
  it("creates a job for the URL's reference, with a one-time token stored only as a hash", () => {
    const { p, job, message } = begin();
    expect(message).toMatchObject({ v: 1, type: "startCapture", jobId: job.id, url: "http://127.0.0.1:4200/", options: { maxPages: 10, maxDurationMs: 900000, maxTotalBytes: Math.floor(MAX_CAPTURE_BYTES * 0.4) } });
    expect(message.upload.endpoint).toBe(`http://localhost:3100/api/projects/${p.id}/capture-jobs/${job.id}`);
    expect(message.upload.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(message.upload.expiresAt).toBeGreaterThan(Date.now() + 15 * 60_000);
    expect(message.upload.expiresAt).toBeLessThan(Date.now() + 30 * 60_000);
    const raw = JSON.stringify(store.sarCaptures.get(p.id, job.id));
    expect(raw).not.toContain(message.upload.token);
    expect(store.references.get(p.id, job.referenceId).reference.url).toBe("http://127.0.0.1:4200/");
    // One active capture per project; bad input refused.
    storeErr(() => store.sarCaptures.start(p.id, { url: "http://127.0.0.1:4200/other" }, "http://localhost:3100"), "conflict");
    const q = store.createProject({ name: "Q", clientName: "Q" });
    storeErr(() => store.sarCaptures.start(q.id, { url: "javascript:alert(1)" }, "http://localhost:3100"), "invalid");
    storeErr(() => store.sarCaptures.start(q.id, { url: "https://x.example", maxPages: 99 }, "http://localhost:3100"), "invalid");
  });

  it("accepts only this job's token, from the extension, until it expires or the job ends", () => {
    const a = begin();
    expect(a.auth()).toBeTruthy();
    expect(a.auth(undefined, undefined, undefined, null)).toBeTruthy(); // no Origin (non-browser client)
    denied(() => a.auth("x".repeat(43)));
    denied(() => a.auth(undefined, undefined, undefined, "https://evil.example"), 403);
    denied(() => store.sarCaptures.authorize(a.p.id, a.job.id, null, ORIGIN, EXT));
    // Another project's job, and this job's token used on another project's path.
    const q = store.createProject({ name: "Q", clientName: "Q" });
    const b = store.sarCaptures.start(q.id, { url: "https://b.example/" }, "http://localhost:3100");
    denied(() => a.auth(b.message.upload.token)); // other job's token on this job
    denied(() => a.auth(undefined, q.id, b.job.id)); // this token on the other job
    denied(() => a.auth(undefined, q.id)); // right job id, wrong project
    // Expired: refused, and the job ends without registering anything.
    const dbFile = join(dir, "scl.sqlite");
    const raw = openDatabase(dbFile);
    raw.prepare("update sar_capture_jobs set token_expires_at = ? where id = ?").run(Date.now() - 1, b.job.id);
    denied(() => store.sarCaptures.authorize(q.id, b.job.id, `Bearer ${b.message.upload.token}`, ORIGIN, EXT));
    expect(store.sarCaptures.get(q.id, b.job.id)).toMatchObject({ status: "failed", captureId: null, sourceId: null });
    expect(store.sarCaptures.get(q.id, b.job.id).error).toMatch(/expired/);
    raw.close();
  });

  it("checks every page upload: ZIP only, valid id, size budget, not after cancel", () => {
    const { p, job, auth } = begin();
    const r = auth();
    storeErr(() => store.sarCaptures.receivePage(r, "home", strToU8("<html>")), "invalid");
    storeErr(() => store.sarCaptures.receivePage(r, "../etc", pageZip("home", "Home")), "invalid");
    const big = new Uint8Array(MAX_CAPTURE_BYTES + 1); // over the 200 MB WF-02 limit
    big.set([0x50, 0x4b, 0x03, 0x04]);
    storeErr(() => store.sarCaptures.receivePage(r, "home", big), "invalid");
    expect(store.sarCaptures.receivePage(r, "home", pageZip("home", "Home"))).toMatchObject({ pageId: "home" });
    expect(store.sarCaptures.get(p.id, job.id)).toMatchObject({ status: "capturing", pagesReceived: 1 });
    expect(store.sarCaptures.progress(auth(), { progress: { discovered: 3, captured: 1, failed: 0, pending: 2, uploaded: 1 } })).toEqual({ cancelled: false });
    store.sarCaptures.cancel(p.id, job.id);
    expect(store.sarCaptures.progress(auth(), {})).toEqual({ cancelled: true });
    storeErr(() => store.sarCaptures.receivePage(auth(), "about", pageZip("about", "About")), "conflict");
    // The extension's final report after a cancel closes the job; nothing is registered.
    expect(store.sarCaptures.complete(auth(), result([{ id: "home", status: "captured" }], { status: "cancelled", cancelled: true }))).toEqual({ status: "cancelled" });
    denied(() => auth());
    expect(store.references.get(p.id, job.referenceId).captures).toHaveLength(0);
    expect(store.sources.list(p.id)).toHaveLength(0);
  });
});

describe("completion", () => {
  it("packages the uploaded pages and registers a WF-02 capture and a study-only WF-03 source", () => {
    const { p, job, message, auth } = begin();
    const home = pageZip("home", "Home");
    const about = pageZip("about", "About");
    store.sarCaptures.receivePage(auth(), "home", home);
    store.sarCaptures.receivePage(auth(), "about", about);
    const out = store.sarCaptures.complete(auth(), result([{ id: "home", status: "captured" }, { id: "about", status: "captured" }, { id: "private", status: "inaccessible" }], { discoveryComplete: false }));
    expect(out).toEqual({ status: "completed_with_warnings" });
    const j = store.sarCaptures.get(p.id, job.id);
    expect(j).toMatchObject({ status: "completed_with_warnings", pagesReceived: 0 });
    expect(j.warnings.join(" ")).toMatch(/1 discovered page\(s\) were not captured.*Discovery stopped/);
    // The token is spent.
    denied(() => auth());

    const ref = store.references.get(p.id, job.referenceId);
    expect(ref.status).toBe("captured");
    expect(ref.captures[0]).toMatchObject({ id: j.captureId, kind: "archive", tool: "SaveAllResources", capturedOn: "2026-10-01" });
    expect(ref.captures[0].notes).toMatch(/sent to SCL Web.*2 of 3 pages captured, discovery incomplete/);
    const src = store.sources.get(p.id, j.sourceId!).source;
    expect(src).toMatchObject({ origin: "reference_capture", originUrl: "http://127.0.0.1:4200/", originRef: `saveallresources:job=${message.jobId};manifest=1.0.0`, authorization: { basis: "study_only" } });

    // The stored archive keeps every page package byte for byte, and WF-03 reads it with no special path.
    const stored = new Uint8Array(store.sources.readArchiveFile(p.id, src.id).bytes);
    const files = new Map(readArchive(stored).files.map((f) => [f.path, f.bytes]));
    expect(Buffer.from(files.get("raw-capture/sar-page-zips/home.zip")!)).toEqual(Buffer.from(home));
    expect(Buffer.from(files.get("raw-capture/sar-page-zips/about.zip")!)).toEqual(Buffer.from(about));
    expect(files.has("raw-capture/pages/about/document.original.html")).toBe(true);
    expect(files.has("raw-capture/resources/127.0.0.14200/css/site.css")).toBe(true);
    const manifest = JSON.parse(new TextDecoder().decode(files.get("manifest.json")));
    expect(manifest).toMatchObject({ generator: "scl-web-sar-capture", manifestVersion: "1.0.0", jobId: job.id, capture: { startedAt: Date.parse("2026-10-01T10:00:00Z") } });
    expect(manifest.resources.find((x: Row) => x.url === "http://127.0.0.1:4200/css/site.css").pages).toEqual(["home", "about"]);

    const scan = store.sources.runScan(p.id, src.id);
    const q = store.createProject({ name: "Manual", clientName: "M" });
    const manual = store.sources.registerUpload(q.id, { label: "Same bytes", originUrl: "", originRef: "", authorization: { basis: "study_only", note: "", license: "" } }, { filename: "capture.zip", bytes: stored });
    expect(store.sources.runScan(q.id, manual.id).digest).toBe(scan.digest);
    // Study only: extraction refused, as for any capture.
    const cand = store.sources.get(p.id, src.id).latest!.analysis.templateCandidates[0];
    if (cand) storeErr(() => store.sources.extractTemplate(p.id, store.sources.acceptCandidate(p.id, src.id, cand.key).id), "conflict");
    // WF-03's manifest for WF-04/WF-05 carries it unchanged in shape.
    expect(TemplateManifest.parse(store.sources.manifest(p.id)).sources[0].origin).toMatchObject({ kind: "reference_capture", referenceId: job.referenceId });
  });

  it("registers nothing when a captured page never arrived, the browser failed, or nothing was captured", () => {
    const a = begin();
    a.auth();
    store.sarCaptures.receivePage(a.auth(), "home", pageZip("home", "Home"));
    expect(store.sarCaptures.complete(a.auth(), result([{ id: "home", status: "captured" }, { id: "about", status: "captured" }]))).toEqual({ status: "failed" });
    expect(store.sarCaptures.get(a.p.id, a.job.id).error).toMatch(/1 captured page\(s\) never reached Web \(about\)/);
    expect(store.references.get(a.p.id, a.job.referenceId).captures).toHaveLength(0);
    expect(store.sources.list(a.p.id)).toHaveLength(0);

    const b = begin("https://b.example/");
    expect(store.sarCaptures.complete(b.auth(), result([], { status: "failed", errors: ["navigation timeout"] }))).toEqual({ status: "failed" });
    expect(store.sarCaptures.get(b.p.id, b.job.id).error).toMatch(/navigation timeout/);

    const c = begin("https://c.example/");
    expect(store.sarCaptures.complete(c.auth(), result([{ id: "home", status: "inaccessible" }]))).toEqual({ status: "failed" });
    expect(store.sarCaptures.get(c.p.id, c.job.id).error).toMatch(/No page was captured/);

    const d = begin("https://d.example/");
    store.sarCaptures.receivePage(d.auth(), "home", zipSync({ "x.txt": strToU8("not a page package") }));
    expect(store.sarCaptures.complete(d.auth(), result([{ id: "home", status: "captured" }]))).toEqual({ status: "failed" });
    expect(store.sarCaptures.get(d.p.id, d.job.id).error).toMatch(/could not be read/);

    // The extension never started: the dashboard ends the job.
    const e = begin("https://e.example/");
    expect(store.sarCaptures.abandon(e.p.id, e.job.id, "EXTENSION_UNAVAILABLE: not installed")).toMatchObject({ status: "failed" });
    denied(() => e.auth());
  });

  it.skipIf(!process.env.SAR_EXPORT_ZIP)("replays a real capture's page packages (SAR_EXPORT_ZIP)", () => {
    const real = readArchive(new Uint8Array(readFileSync(process.env.SAR_EXPORT_ZIP!)));
    const manifest = JSON.parse(new TextDecoder().decode(real.files.find((f) => f.path === "manifest.json")!.bytes));
    const { p, job, auth } = begin(manifest.entryUrl);
    for (const f of real.files.filter((f) => f.path.startsWith("raw-capture/sar-page-zips/"))) {
      store.sarCaptures.receivePage(auth(), f.path.split("/").pop()!.replace(/\.zip$/, ""), f.bytes);
    }
    const pages = manifest.pages.map((pg: Row) => ({ id: pg.id, url: pg.requestedUrl, status: pg.status === "capture_not_uploaded" ? "captured" : pg.status }));
    const out = store.sarCaptures.complete(auth(), { ...result([]), status: manifest.capture.status, startedAt: manifest.capture.startedAt, finishedAt: manifest.capture.finishedAt, discoveryComplete: manifest.capture.discoveryComplete, pages });
    expect(out.status).toMatch(/^completed/);
    const j = store.sarCaptures.get(p.id, job.id);
    const scan = store.sources.runScan(p.id, j.sourceId!);
    const a = store.sources.scanResult(p.id, j.sourceId!, scan.id);
    expect(a.files.some((f) => f.path.startsWith("raw-capture/pages/"))).toBe(true);
    console.log(JSON.stringify({ status: out.status, warnings: j.warnings, files: a.summary.files, digest: scan.digest }, null, 2));
  });
});
