import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strToU8, zipSync } from "fflate";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ReferenceLibrary } from "@/domain/reference-library";
import { ANALYST_FINDINGS_SCHEMA, TemplateManifest } from "@/domain/wf03";
import { openDatabase } from "@/server/store/db";
import { createStore, StoreError, type Store } from "@/server/store/store";
import { importSaveAllResourcesExport, readSaveAllResourcesExport } from "./save-all-resources";

// The SaveAllResources → WF-02 → WF-03 boundary. The fixture is laid out
// exactly as sar-website-template's export.mjs writes it (one
// website-template/ folder; manifest.json; raw-capture/; template/; reports).
// An opt-in run against a real export: SAR_EXPORT_ZIP=/path/to/export.zip.

const header = `<header class="site-header"><nav class="main-nav"><a href="/">Home</a><a href="/pricing.html">Pricing</a></nav></header>`;
const page = (title: string, body: string) => `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>${title}</title><link rel="stylesheet" href="/css/site.css"></head>
<body>
${header}
<main>${body}</main>
<footer class="site-footer"><p>© Fixture Studio</p></footer>
</body>
</html>`;

function sarManifest(over: Record<string, unknown> = {}) {
  return {
    manifestVersion: "1.0.0",
    generator: "sar-website-template",
    jobId: "job-7f3a",
    createdAt: "2026-09-30T10:05:00.000Z",
    entryUrl: "http://127.0.0.1:4200/",
    captureOptions: { maxPages: 4 },
    capture: { engine: "Save All Resources 2.0.6 collector (automation build, chrome.debugger)", status: "completed", startedAt: "2026-09-30T10:00:00.000Z", finishedAt: "2026-09-30T10:04:00.000Z", discoveryComplete: false, limits: { reached: ["maxPages"], remainingUrls: [] } },
    pages: [
      { id: "p1", requestedUrl: "http://127.0.0.1:4200/", status: "captured" },
      { id: "p2", requestedUrl: "http://127.0.0.1:4200/pricing.html", status: "captured" },
      { id: "p3", requestedUrl: "http://127.0.0.1:4200/private/", status: "inaccessible" },
    ],
    resources: [],
    privacy: { cookiesExported: false },
    ...over,
  };
}

// TEST FIXTURE: a SaveAllResources-shaped export, built in memory.
function sarExport({ manifest = sarManifest() as unknown, raw = true, extra = {} as Record<string, string> } = {}) {
  const files: Record<string, Uint8Array> = {
    "website-template/manifest.json": strToU8(JSON.stringify(manifest, null, 2)),
    "website-template/page-inventory.json": strToU8("{}"),
    "website-template/README.md": strToU8("# Website template\n"),
    "website-template/template/package.json": strToU8(JSON.stringify({ name: "website-template", private: true, scripts: { build: "node build.mjs" } })),
    "website-template/template/pages/index.html": strToU8(page("Home (reconstructed)", "<section><h1>Hello</h1></section>")),
  };
  if (raw) {
    files["website-template/raw-capture/manifest.json"] = strToU8(JSON.stringify(manifest));
    files["website-template/raw-capture/pages/p1/page.json"] = strToU8(JSON.stringify({ url: "http://127.0.0.1:4200/" }));
    files["website-template/raw-capture/pages/p1/document.original.html"] = strToU8(page("Home", `<section class="hero"><h1>Hello</h1><img src="/img/hero.jpg"></section>`));
    files["website-template/raw-capture/pages/p2/document.original.html"] = strToU8(page("Pricing", `<section class="pricing"><h2>Plans</h2></section>`));
    files["website-template/raw-capture/resources/127.0.0.1_4200/css/site.css"] = strToU8(":root { --brand: #0a84ff; }\nbody { color: #111; }\n");
  }
  for (const [k, v] of Object.entries(extra)) files[k] = strToU8(v);
  return zipSync(files);
}

let dir: string;
let store: Store;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "scl-sar-"));
  store = createStore(openDatabase(join(dir, "scl.sqlite")), join(dir, "uploads"), { checkUrl: async () => { throw new Error("no network in tests"); } });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const storeError = (fn: () => unknown, code: string) => {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(StoreError);
    expect((e as StoreError).code).toBe(code);
    return e as StoreError;
  }
  throw new Error("expected a StoreError");
};
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

describe("SaveAllResources export adapter", () => {
  it("reads provenance from the export's own manifest, without changing the archive", () => {
    const zip = sarExport();
    const x = readSaveAllResourcesExport(zip);
    expect(x).toEqual({
      generator: "sar-website-template",
      manifestVersion: "1.0.0",
      jobId: "job-7f3a",
      entryUrl: "http://127.0.0.1:4200/",
      referenceUrl: "http://127.0.0.1:4200/",
      host: "127.0.0.1:4200",
      capturedAt: "2026-09-30T10:04:00.000Z",
      capturedOn: "2026-09-30",
      engine: "Save All Resources 2.0.6 collector (automation build, chrome.debugger)",
      captureStatus: "completed",
      discoveryComplete: false,
      pages: { total: 3, captured: 2 },
      sha256: sha(zip),
    });
  });

  it("reads the real format: capture times as epoch milliseconds", () => {
    const m = sarManifest();
    const x = readSaveAllResourcesExport(sarExport({ manifest: { ...m, capture: { ...m.capture, startedAt: Date.parse("2026-09-30T10:00:00Z"), finishedAt: Date.parse("2026-09-30T23:59:30Z") } } }));
    expect(x).toMatchObject({ capturedAt: "2026-09-30T23:59:30.000Z", capturedOn: "2026-09-30" });
  });

  it("refuses what is not a SaveAllResources export, using WF-03's archive rules", () => {
    const plain = zipSync({ "site/index.html": strToU8("<h1>x</h1>") });
    expect(() => readSaveAllResourcesExport(plain)).toThrow(/no manifest.json/);
    expect(() => readSaveAllResourcesExport(sarExport({ manifest: { ...sarManifest(), generator: "something-else" } }))).toThrow(/not written by sar-website-template or scl-web-sar-capture/);
    expect(() => readSaveAllResourcesExport(sarExport({ manifest: { ...sarManifest(), manifestVersion: "2.0.0" } }))).toThrow(/version 2.0.0 is not supported/);
    expect(() => readSaveAllResourcesExport(sarExport({ manifest: { ...sarManifest(), entryUrl: "javascript:alert(1)" } }))).toThrow(/entry URL/);
    expect(() => readSaveAllResourcesExport(sarExport({ raw: false }))).toThrow(/no captured pages/);
    expect(() => readSaveAllResourcesExport(new TextEncoder().encode("not a zip"))).toThrow(/Not a readable zip archive/);
    // Unsafe entries are skipped by readArchive exactly as for any upload.
    const x = readSaveAllResourcesExport(sarExport({ extra: { "website-template/../../evil.sh": "rm -rf /" } }));
    expect(x.jobId).toBe("job-7f3a");
  });
});

describe("SaveAllResources → WF-02 → WF-03", () => {
  it("imports the unchanged ZIP as a WF-02 capture and a study-only WF-03 source with its provenance", () => {
    const p = store.createProject({ name: "P", clientName: "C" });
    const zip = sarExport();
    const r = importSaveAllResourcesExport(store, p.id, { filename: "job-7f3a-website-template.zip", bytes: zip });
    expect(r).toMatchObject({ createdReference: true, reusedCapture: false });

    const ref = store.references.get(p.id, r.referenceId);
    expect(ref.reference.url).toBe("http://127.0.0.1:4200/");
    expect(ref.status).toBe("captured");
    const cap = ref.captures[0];
    expect(cap).toMatchObject({ kind: "archive", tool: "SaveAllResources", sourceUrl: "http://127.0.0.1:4200/", capturedOn: "2026-09-30", file: { filename: "job-7f3a-website-template.zip", sha256: sha(zip) } });
    expect(cap.notes).toMatch(/job job-7f3a, manifest v1\.0\.0.*2 of 3 pages captured, discovery incomplete/);

    const s = store.sources.get(p.id, r.sourceId).source;
    expect(s).toMatchObject({
      origin: "reference_capture",
      originUrl: "http://127.0.0.1:4200/",
      originRef: "saveallresources:job=job-7f3a;manifest=1.0.0",
      referenceId: r.referenceId,
      captureId: r.captureId,
      authorization: { basis: "study_only" },
    });
    // The source artifact is the exported ZIP, byte for byte.
    expect(s.archive.sha256).toBe(sha(zip));
    expect(Buffer.from(store.sources.readArchiveFile(p.id, s.id).bytes)).toEqual(Buffer.from(zip));
    // WF-02's export carries the tool and date, as for any capture.
    const lib = ReferenceLibrary.parse(store.references.library(p.id));
    expect(lib.references[0].evidence.captures[0]).toMatchObject({ tool: "SaveAllResources", capturedOn: "2026-09-30", sha256: sha(zip) });
  });

  it("analyses exactly like a manual upload of the same ZIP: digest, files, risks, citations", () => {
    const zip = sarExport();
    const a = store.createProject({ name: "A", clientName: "A" });
    const b = store.createProject({ name: "B", clientName: "B" });
    const imported = importSaveAllResourcesExport(store, a.id, { filename: "export.zip", bytes: zip });
    const manual = store.sources.registerUpload(b.id, { label: "Manual", originUrl: "http://127.0.0.1:4200/", originRef: "", authorization: { basis: "study_only", note: "", license: "" } }, { filename: "export.zip", bytes: zip });
    const scanA = store.sources.runScan(a.id, imported.sourceId);
    const scanB = store.sources.runScan(b.id, manual.id);
    expect(scanA.digest).toBe(scanB.digest);
    expect(scanA.analyzerVersion).toBe(scanB.analyzerVersion);
    const ra = store.sources.scanResult(a.id, imported.sourceId, scanA.id);
    const rb = store.sources.scanResult(b.id, manual.id, scanB.id);
    expect(ra.input.sha256).toBe(sha(zip));
    expect(ra.files).toEqual(rb.files);
    expect(ra.risks).toEqual(rb.risks);
    expect(ra.templateCandidates).toEqual(rb.templateCandidates);
    expect(ra.files.map((f) => f.path)).toContain("raw-capture/pages/p1/document.original.html");
    // Re-running gives the same digest.
    expect(store.sources.runScan(a.id, imported.sourceId).digest).toBe(scanA.digest);

    // Analyst findings are pinned to the scan and checked against the archive, as for any source.
    const findings = (path: string, line: number) => ({ schema: ANALYST_FINDINGS_SCHEMA, scanDigest: scanA.digest, findings: [{ basis: "fact", topic: "components", statement: "The home page has a hero section.", evidence: [{ path, line }] }] });
    expect(store.sources.importFindings(a.id, imported.sourceId, findings("raw-capture/pages/p1/document.original.html", 6))).toMatchObject({ findings: 1 });
    storeError(() => store.sources.importFindings(a.id, imported.sourceId, findings("raw-capture/pages/p9/missing.html", 1)), "invalid");
    storeError(() => store.sources.importFindings(a.id, imported.sourceId, findings("raw-capture/pages/p1/document.original.html", 999)), "invalid");
  });

  it("cannot bypass study-only: no extraction, and authority is raised only with the usual evidence", () => {
    const p = store.createProject({ name: "P", clientName: "C" });
    const r = importSaveAllResourcesExport(store, p.id, { filename: "export.zip", bytes: sarExport() });
    store.sources.runScan(p.id, r.sourceId);
    const cand = store.sources.get(p.id, r.sourceId).latest!.analysis.templateCandidates[0];
    expect(cand).toBeDefined();
    const t = store.sources.acceptCandidate(p.id, r.sourceId, cand.key);
    storeError(() => store.sources.extractTemplate(p.id, t.id), "conflict");
    storeError(() => store.sources.updateAuthorization(p.id, r.sourceId, { basis: "client_owned", note: "", license: "" }), "invalid");
    // Nothing is extracted automatically by the import either.
    expect(store.sources.get(p.id, r.sourceId).templates.every((x) => x.extraction.status === "not_extracted")).toBe(true);
  });

  it("is idempotent about duplicates, reuses an existing reference, and writes nothing for a bad file", () => {
    const p = store.createProject({ name: "P", clientName: "C" });
    const existing = store.references.add(p.id, { url: "http://127.0.0.1:4200/", label: "Fixture site", pageType: "" });
    const zip = sarExport();
    const r = importSaveAllResourcesExport(store, p.id, { filename: "export.zip", bytes: zip });
    expect(r).toMatchObject({ referenceId: existing.id, createdReference: false });
    storeError(() => importSaveAllResourcesExport(store, p.id, { filename: "export.zip", bytes: zip }), "conflict");
    expect(store.references.get(p.id, existing.id).captures).toHaveLength(1);
    expect(store.sources.list(p.id)).toHaveLength(1);

    storeError(() => importSaveAllResourcesExport(store, p.id, { filename: "export.zip", bytes: zipSync({ "x/index.html": strToU8("<p>") }) }), "invalid");
    storeError(() => importSaveAllResourcesExport(store, p.id, { filename: "export.tar", bytes: zip }), "invalid");
    expect(store.references.list(p.id)).toHaveLength(1);

    // A capture already uploaded by hand (same bytes) is completed, not duplicated.
    const q = store.createProject({ name: "Q", clientName: "Q" });
    const ref = store.references.add(q.id, { url: "http://127.0.0.1:4200/", label: "", pageType: "" });
    const cap = store.references.addCapture(q.id, ref.id, { kind: "archive", tool: "SaveAllResources", capturedOn: "2026-09-30", notes: "" }, { filename: "export.zip", mimeType: "application/zip", bytes: zip });
    expect(importSaveAllResourcesExport(store, q.id, { filename: "export.zip", bytes: zip })).toMatchObject({ captureId: cap.id, reusedCapture: true });
  });

  it("flows into the WF-03 template manifest that WF-04/WF-05 read, unchanged in shape", () => {
    const p = store.createProject({ name: "P", clientName: "C" });
    const r = importSaveAllResourcesExport(store, p.id, { filename: "export.zip", bytes: sarExport() });
    store.sources.runScan(p.id, r.sourceId);
    const m = TemplateManifest.parse(store.sources.manifest(p.id));
    expect(m.sources[0]).toMatchObject({
      origin: { kind: "reference_capture", url: "http://127.0.0.1:4200/", ref: "saveallresources:job=job-7f3a;manifest=1.0.0", referenceId: r.referenceId, captureId: r.captureId },
      authorization: { basis: "study_only" },
    });
  });

  it.skipIf(!process.env.SAR_EXPORT_ZIP)("accepts a real SaveAllResources export (SAR_EXPORT_ZIP)", () => {
    const zip = new Uint8Array(readFileSync(process.env.SAR_EXPORT_ZIP!));
    const p = store.createProject({ name: "Real", clientName: "Real" });
    const r = importSaveAllResourcesExport(store, p.id, { filename: "real-export.zip", bytes: zip });
    const scan = store.sources.runScan(p.id, r.sourceId);
    const res = store.sources.scanResult(p.id, r.sourceId, scan.id);
    expect(res.input.sha256).toBe(sha(zip));
    expect(res.files.some((f) => f.path.startsWith("raw-capture/pages/"))).toBe(true);
    const q = store.createProject({ name: "Manual", clientName: "Manual" });
    const manual = store.sources.registerUpload(q.id, { label: "Manual", originUrl: r.export.entryUrl, originRef: "", authorization: { basis: "study_only", note: "", license: "" } }, { filename: "real-export.zip", bytes: zip });
    expect(store.sources.runScan(q.id, manual.id).digest).toBe(scan.digest);
    console.log(JSON.stringify({ export: r.export, digest: scan.digest, files: res.summary, risks: res.risks.length, candidates: res.templateCandidates.length, questions: res.questions.length }, null, 2));
  });
});
