import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strToU8, unzipSync } from "fflate";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ANALYST_FINDINGS_SCHEMA, TemplateManifest } from "@/domain/wf03";
import { nextRepo, staticSite } from "@/server/wf03/test-fixtures";
import { openDatabase } from "./db";
import { createStore, StoreError, type Store } from "./store";

let dir: string;
let store: Store;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "scl-wf03-"));
  store = createStore(openDatabase(join(dir, "scl.sqlite")), join(dir, "uploads"), {
    checkUrl: async () => {
      throw new Error("no network in tests");
    },
  });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const expectStoreError = (fn: () => unknown, code: string) => {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(StoreError);
    expect((e as StoreError).code).toBe(code);
    return e as StoreError;
  }
  throw new Error("expected a StoreError");
};

const studyOnly = { label: "Studio capture", originUrl: "https://studio.example", originRef: "", authorization: { basis: "study_only", note: "", license: "" } };
const owned = { label: "Client repo", originUrl: "https://github.com/client/site", originRef: "a1b2c3d", authorization: { basis: "client_owned", note: "Client's own repository; access granted by their CTO on 2026-09-30.", license: "" } };

function setup(bytes = staticSite(), meta: object = studyOnly) {
  const p = store.createProject({ name: "P", clientName: "C" });
  const s = store.sources.registerUpload(p.id, meta, { filename: "site.zip", bytes });
  return { p, s };
}

describe("registering sources", () => {
  it("requires a stated authority, and evidence of it for anything beyond study", () => {
    const p = store.createProject({ name: "P", clientName: "C" });
    const file = { filename: "a.zip", bytes: staticSite() };
    expectStoreError(() => store.sources.registerUpload(p.id, { ...owned, authorization: { basis: "client_owned", note: "", license: "" } }, file), "invalid");
    expectStoreError(() => store.sources.registerUpload(p.id, { ...owned, authorization: { basis: "licensed", note: "Bought from ThemeForest", license: "" } }, file), "invalid");
    expectStoreError(() => store.sources.registerUpload(p.id, { ...owned, authorization: { basis: "anything", note: "x", license: "" } }, file), "invalid");
  });

  it("refuses non-zip files and duplicate archives, and writes nothing for them", () => {
    const p = store.createProject({ name: "P", clientName: "C" });
    expectStoreError(() => store.sources.registerUpload(p.id, studyOnly, { filename: "a.zip", bytes: strToU8("not a zip") }), "invalid");
    expectStoreError(() => store.sources.registerUpload(p.id, studyOnly, { filename: "a.tar", bytes: staticSite() }), "invalid");
    store.sources.registerUpload(p.id, studyOnly, { filename: "a.zip", bytes: staticSite() });
    expectStoreError(() => store.sources.registerUpload(p.id, studyOnly, { filename: "b.zip", bytes: staticSite() }), "conflict");
    expect(store.sources.list(p.id)).toHaveLength(1);
  });

  it("turns a WF-02 archive capture into a study-only source with its provenance, but never a screenshot", () => {
    const p = store.createProject({ name: "P", clientName: "C" });
    const r = store.references.add(p.id, { url: "https://studio.example/", label: "Studio", pageType: "" });
    const today = new Date().toISOString().slice(0, 10);
    const zip = store.references.addCapture(p.id, r.id, { kind: "archive", tool: "SaveMyResources", capturedOn: today, notes: "" }, { filename: "studio.zip", mimeType: "application/zip", bytes: staticSite() });
    const shot = store.references.addCapture(p.id, r.id, { kind: "screenshot", tool: "Browser", capturedOn: today, notes: "" }, { filename: "s.png", mimeType: "image/png", bytes: new Uint8Array([1]) });

    const s = store.sources.registerFromCapture(p.id, r.id, zip.id, { ...studyOnly, originUrl: "" });
    expect(s).toMatchObject({ origin: "reference_capture", originUrl: "https://studio.example/", referenceId: r.id, captureId: zip.id });
    expect(s.archive.sha256).toBe(zip.file.sha256);
    expectStoreError(() => store.sources.registerFromCapture(p.id, r.id, shot.id, studyOnly), "invalid");
    expectStoreError(() => store.sources.registerFromCapture(p.id, r.id, zip.id, studyOnly), "conflict");

    // Deleting the capture later does not change the source.
    store.references.removeCapture(p.id, r.id, zip.id);
    expect(store.sources.readArchiveFile(p.id, s.id).bytes.byteLength).toBe(s.archive.sizeBytes);
  });
});

describe("analysis", () => {
  it("is reproducible: re-running gives the same digest, recorded each time", () => {
    const { p, s } = setup();
    const a = store.sources.runScan(p.id, s.id);
    const b = store.sources.runScan(p.id, s.id);
    expect(b.digest).toBe(a.digest);
    expect(store.sources.get(p.id, s.id).scans).toHaveLength(2);
  });

  it("raises the scanner's questions once, and keeps answers across re-runs", () => {
    const { p, s } = setup();
    store.sources.runScan(p.id, s.id);
    const qs = store.sources.get(p.id, s.id).questions;
    expect(qs.map((q) => q.key)).toContain("framework-unknown");
    const q = qs.find((x) => x.key === "framework-unknown")!;
    store.sources.resolveQuestion(p.id, s.id, q.id, "Hand-written HTML, per the client.");
    store.sources.runScan(p.id, s.id);
    const after = store.sources.get(p.id, s.id).questions;
    expect(after).toHaveLength(qs.length);
    expect(after.find((x) => x.key === "framework-unknown")).toMatchObject({ status: "resolved", answer: "Hand-written HTML, per the client." });
  });
});

describe("templates and extraction", () => {
  it("never extracts from a study-only source", () => {
    const { p, s } = setup();
    store.sources.runScan(p.id, s.id);
    const cand = store.sources.get(p.id, s.id).latest!.analysis.templateCandidates.find((c) => c.kind === "navigation")!;
    const t = store.sources.acceptCandidate(p.id, s.id, cand.key);
    expectStoreError(() => store.sources.extractTemplate(p.id, t.id), "conflict");
    expect(existsSync(join(dir, "workspaces", p.id))).toBe(false);
  });

  it("extracts an authorised template verbatim, with provenance that matches the source", () => {
    const { p, s } = setup(staticSite(), owned);
    store.sources.runScan(p.id, s.id);
    const cand = store.sources.get(p.id, s.id).latest!.analysis.templateCandidates.find((c) => c.kind === "navigation")!;
    const t = store.sources.acceptCandidate(p.id, s.id, cand.key);
    expectStoreError(() => store.sources.acceptCandidate(p.id, s.id, cand.key), "conflict");
    expect(t.build.status).toBe("not_applicable");

    const e = store.sources.extractTemplate(p.id, t.id);
    expect(e.extraction).toMatchObject({ status: "extracted", workspacePath: `${t.slug}/` });
    const base = join(dir, "workspaces", p.id, t.slug);
    const prov = JSON.parse(readFileSync(join(base, "PROVENANCE.json"), "utf8"));
    expect(prov.source).toMatchObject({ id: s.id, archiveSha256: s.archive.sha256, authorization: { basis: "client_owned" } });
    for (const f of prov.files) {
      const bytes = readFileSync(join(base, f.workspacePath));
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(f.sha256);
      expect(f.archivePath).toBe(`studio/${f.sourcePath}`);
    }
    const snippet = readFileSync(join(base, "snippet.html"), "utf8");
    expect(snippet).toContain('<header class="site-header"><nav class="main-nav">');
    expect(snippet).toContain("Extracted verbatim from about.html");

    // Authority cannot be withdrawn while extracted files exist.
    expectStoreError(() => store.sources.updateAuthorization(p.id, s.id, { basis: "study_only", note: "", license: "" }), "conflict");
    store.sources.removeTemplate(p.id, t.id);
    expect(existsSync(base)).toBe(false);
    store.sources.updateAuthorization(p.id, s.id, { basis: "study_only", note: "", license: "" });
  });

  it("records build results only for extracted, buildable templates, and only with what was run", () => {
    const { p, s } = setup(nextRepo(), owned);
    store.sources.runScan(p.id, s.id);
    const t = store.sources.acceptCandidate(p.id, s.id, "component:components/Header.tsx:Header");
    expect(t.build.status).toBe("not_verified");
    expectStoreError(() => store.sources.recordBuild(p.id, t.id, { status: "passed", note: "npm run build" }), "conflict");
    store.sources.extractTemplate(p.id, t.id);
    expect(existsSync(join(dir, "workspaces", p.id, t.slug, "files", "components", "Header.tsx"))).toBe(true);
    expectStoreError(() => store.sources.recordBuild(p.id, t.id, { status: "passed", note: " " }), "invalid");
    expectStoreError(() => store.sources.recordBuild(p.id, t.id, { status: "great", note: "x" }), "invalid");
    const b = store.sources.recordBuild(p.id, t.id, { status: "failed", note: "npx tsc --noEmit: cannot find module 'gsap'" });
    expect(b.build).toMatchObject({ status: "failed", note: "npx tsc --noEmit: cannot find module 'gsap'" });
  });
});

describe("analyst findings import", () => {
  const prepared = () => {
    const { p, s } = setup(nextRepo(), owned);
    const scan = store.sources.runScan(p.id, s.id);
    return { p, s, digest: scan.digest };
  };
  const file = (digest: string, over: object = {}) => ({
    schema: ANALYST_FINDINGS_SCHEMA,
    scanDigest: digest,
    findings: [
      { basis: "fact", topic: "components", statement: "Header renders the site navigation.", evidence: [{ path: "components/Header.tsx", line: 3 }] },
      { basis: "assumption", topic: "interaction", statement: "GSAP probably animates the header on scroll.", evidence: [] },
    ],
    questions: [{ topic: "licensing", text: "Is GSAP's licence compatible with the client's use?" }],
    templates: [{ kind: "page_template", name: "Marketing page", basis: "inferred", rationale: "Shared by /about.", files: ["app/(marketing)/about/page.tsx"] }],
    ...over,
  });

  it("imports facts, assumptions, questions and templates pinned to a scan", () => {
    const { p, s, digest } = prepared();
    expect(store.sources.importFindings(p.id, s.id, file(digest))).toEqual({ findings: 2, questions: 1, templates: 1 });
    const d = store.sources.get(p.id, s.id);
    expect(d.findings.map((f) => [f.basis, f.origin])).toEqual([
      ["fact", "analysis_kit"],
      ["assumption", "analysis_kit"],
    ]);
    expect(d.templates.find((t) => t.name === "Marketing page")).toMatchObject({ origin: "analysis_kit", build: { status: "not_verified" } });
  });

  it("rejects the whole file if any citation is not in the source, and imports nothing", () => {
    const { p, s, digest } = prepared();
    const bad = file(digest, {
      findings: [
        { basis: "fact", topic: "components", statement: "ok", evidence: [{ path: "components/Header.tsx", line: 1 }] },
        { basis: "fact", topic: "components", statement: "invented", evidence: [{ path: "components/Footer.tsx", line: 1 }] },
        { basis: "fact", topic: "components", statement: "bad line", evidence: [{ path: "components/Header.tsx", line: 999 }] },
      ],
    });
    const err = expectStoreError(() => store.sources.importFindings(p.id, s.id, bad), "invalid");
    expect(err.message).toBe("Nothing imported: 2 citations do not match the source.");
    expect(err.issues.map((i) => i.message)).toEqual(["findings[1]: components/Footer.tsx is not a file in the source", "findings[2]: components/Header.tsx has no line 999"]);
    expect(store.sources.get(p.id, s.id).findings).toHaveLength(0);
    expect(store.sources.get(p.id, s.id).templates).toHaveLength(0);
  });

  it("rejects facts without evidence, and files made against another scan", () => {
    const { p, s, digest } = prepared();
    expectStoreError(() => store.sources.importFindings(p.id, s.id, file(digest, { findings: [{ basis: "fact", topic: "other", statement: "No evidence", evidence: [] }] })), "invalid");
    expectStoreError(() => store.sources.importFindings(p.id, s.id, file("0".repeat(64))), "invalid");
  });
});

describe("outputs", () => {
  it("builds an analysis kit with instructions, schema and the source", () => {
    const { p, s } = setup();
    expectStoreError(() => store.sources.analysisKit(p.id, s.id), "conflict");
    store.sources.runScan(p.id, s.id);
    const entries = unzipSync(store.sources.analysisKit(p.id, s.id).bytes);
    expect(Object.keys(entries)).toEqual(expect.arrayContaining(["CLAUDE.md", "analysis.json", "findings.schema.json", "findings.example.json", "source/index.html"]));
    const claude = new TextDecoder().decode(entries["CLAUDE.md"]);
    expect(claude).toContain("It is for study only.");
    expect(claude).toContain(store.sources.get(p.id, s.id).latest!.scan.digest);
  });

  it("produces a manifest for WF-04/05 that validates, with tokens kept apart from brand", () => {
    const { p, s } = setup(staticSite(), owned);
    store.sources.runScan(p.id, s.id);
    const cand = store.sources.get(p.id, s.id).latest!.analysis.templateCandidates.find((c) => c.kind === "navigation")!;
    const t = store.sources.acceptCandidate(p.id, s.id, cand.key);
    store.sources.extractTemplate(p.id, t.id);
    const m = TemplateManifest.parse(store.sources.manifest(p.id));
    expect(m.sources[0].authorization).toMatchObject({ basis: "client_owned", extractionAllowed: true });
    expect(m.templates[0].files.every((f) => /^[0-9a-f]{64}$/.test(f.sha256 ?? ""))).toBe(true);
    expect(m.templates[0].extraction.status).toBe("extracted");
    expect(m.sourceTokens[0].customProperties.map((c) => c.name)).toEqual(["--brand", "--space-2"]);
    expect(m.notices.sourceTokens).toMatch(/not the client's brand/);
    expect(m.openQuestions.length).toBeGreaterThan(0);
    expect(JSON.stringify(m)).not.toContain("storageKey");

    const ws = unzipSync(store.sources.workspaceZip(p.id).bytes);
    expect(Object.keys(ws)).toEqual(expect.arrayContaining(["MANIFEST.json", "WORKSPACE.md", `${t.slug}/PROVENANCE.json`, `${t.slug}/snippet.html`]));
  });

  it("removing a source removes its archive and extracted files", () => {
    const { p, s } = setup(staticSite(), owned);
    store.sources.runScan(p.id, s.id);
    const cand = store.sources.get(p.id, s.id).latest!.analysis.templateCandidates[0];
    const t = store.sources.extractTemplate(p.id, store.sources.acceptCandidate(p.id, s.id, cand.key).id);
    store.sources.remove(p.id, s.id);
    expect(existsSync(join(dir, "workspaces", p.id, t.slug))).toBe(false);
    expect(existsSync(join(dir, "uploads", p.id, "sources", `${s.id}.zip`))).toBe(false);
  });
});
