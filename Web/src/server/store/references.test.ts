import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { decidingAttempt } from "@/domain/reference";
import { ReferenceLibrary } from "@/domain/reference-library";
import { completeConventionalDraft } from "@/domain/test-fixtures";
import type { CheckResult } from "@/server/reference-check";
import { openDatabase } from "./db";
import { createStore, StoreError, type Store } from "./store";

// Real SQLite and real files; the URL check is a stand-in returning whatever
// the test queues, so nothing here touches the network (the check itself is
// tested against a real server in reference-check.test.ts).

let dir: string;
let db: DatabaseSync;
let store: Store;
let nextCheck: CheckResult;
const checked: string[] = [];

const result = (over: Partial<CheckResult>): CheckResult => ({
  outcome: "reachable",
  httpStatus: 200,
  finalUrl: null,
  redirectChain: [],
  pageTitle: null,
  contentType: "text/html",
  detail: "HTTP 200.",
  inferences: [],
  ...over,
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "scl-refs-"));
  db = openDatabase(join(dir, "scl.sqlite"));
  checked.length = 0;
  nextCheck = result({});
  store = createStore(db, join(dir, "uploads"), {
    checkUrl: async (url) => {
      checked.push(url);
      return nextCheck;
    },
  });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const expectStoreError = async (fn: () => unknown, code: string) => {
  try {
    await fn();
  } catch (e) {
    expect(e).toBeInstanceOf(StoreError);
    expect((e as StoreError).code).toBe(code);
    return e as StoreError;
  }
  throw new Error("expected a StoreError");
};

const zip = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]);
const today = new Date().toISOString().slice(0, 10);

function projectWithApprovedBrief() {
  const p = store.createProject({ name: "Anaïs", clientName: "Anaïs Events" });
  const v1 = store.getProject(p.id)!.latest;
  store.saveDraft(p.id, v1.id, {
    ...completeConventionalDraft(),
    referenceUrls: [
      { url: "https://studio.example/work?utm_source=x#top", note: "Portfolio grid" },
      { url: "https://other.example/", note: "" },
    ],
  });
  store.approveBrief(p.id, v1.id);
  return p;
}

describe("adding references", () => {
  it("normalises URLs and refuses duplicates and credentials", async () => {
    const p = store.createProject({ name: "P", clientName: "C" });
    const r = store.references.add(p.id, { url: "HTTPS://Studio.Example/work?utm_campaign=a&page=2#x", label: "Work", pageType: "Portfolio" });
    expect(r.url).toBe("https://studio.example/work?page=2");
    expect(r.host).toBe("studio.example");
    await expectStoreError(() => store.references.add(p.id, { url: "https://studio.example/work?page=2", label: "", pageType: "" }), "conflict");
    await expectStoreError(() => store.references.add(p.id, { url: "https://user:pw@studio.example/", label: "", pageType: "" }), "invalid");
    await expectStoreError(() => store.references.add(p.id, { url: "javascript:alert(1)", label: "", pageType: "" }), "invalid");
  });

  it("imports the approved brief's references once, and refuses before approval", async () => {
    const draftOnly = store.createProject({ name: "Draft", clientName: "C" });
    await expectStoreError(() => store.references.importFromBrief(draftOnly.id), "conflict");

    const p = projectWithApprovedBrief();
    expect(store.references.importFromBrief(p.id)).toEqual({ added: 2, skipped: 0, briefVersion: 1 });
    expect(store.references.importFromBrief(p.id)).toEqual({ added: 0, skipped: 2, briefVersion: 1 });
    const refs = store.references.list(p.id);
    expect(refs.map((v) => v.reference.url)).toEqual(["https://other.example/", "https://studio.example/work"]);
    expect(refs.every((v) => v.reference.origin === "brief" && v.reference.briefVersion === 1)).toBe(true);
    expect(refs.find((v) => v.reference.host === "studio.example")?.reference.label).toBe("Portfolio grid");
  });

  it("only links references to pages the approved brief lists", async () => {
    const p = projectWithApprovedBrief();
    const r = store.references.add(p.id, { url: "https://a.example/", label: "A", pageType: "" });
    store.references.update(p.id, r.id, { label: "A", pageType: "Home", targetPages: ["home", "home"], attribution: "© A Ltd" });
    expect(store.references.get(p.id, r.id).reference.targetPages).toEqual(["home"]);
    await expectStoreError(() => store.references.update(p.id, r.id, { label: "A", pageType: "", targetPages: ["pricing"], attribution: "" }), "invalid");
  });
});

describe("acquisition status", () => {
  it("starts pending, records a failed check as evidence, and recovers with a capture", async () => {
    const p = store.createProject({ name: "P", clientName: "C" });
    const r = store.references.add(p.id, { url: "https://walled.example/members", label: "", pageType: "" });
    expect(store.references.get(p.id, r.id).status).toBe("pending");

    nextCheck = result({ outcome: "access_restricted", httpStatus: 403, detail: "HTTP 403." });
    await store.references.runCheck(p.id, r.id);
    expect(checked).toEqual(["https://walled.example/members"]);
    let v = store.references.get(p.id, r.id);
    expect(v.status).toBe("failed");
    expect(v.attempts[0]).toMatchObject({ method: "url_check", recordedBy: "system", outcome: "access_restricted", httpStatus: 403 });

    // A person captures it from their own signed-in browser.
    store.references.addCapture(p.id, r.id, { kind: "archive", tool: "SaveMyResources", capturedOn: today, notes: "" }, { filename: "walled.zip", mimeType: "application/zip", bytes: zip });
    v = store.references.get(p.id, r.id);
    expect(v.status).toBe("captured");
    // The failure stays on the record; recovery adds to it rather than replacing it.
    expect(v.attempts.map((a) => a.outcome)).toEqual(["captured", "access_restricted"]);
    expect(v.attempts[0].recordedBy).toBe("user");
  });

  it("marks a reachable-but-uncaptured page as checked, and a person's failed attempt as failed", async () => {
    const p = store.createProject({ name: "P", clientName: "C" });
    const r = store.references.add(p.id, { url: "https://ok.example/", label: "", pageType: "" });
    nextCheck = result({ pageTitle: "OK Studio", inferences: ["The final URL looks like a sign-in page."] });
    await store.references.runCheck(p.id, r.id);
    expect(store.references.get(p.id, r.id).status).toBe("checked");

    await expectStoreError(() => store.references.recordFailedAttempt(p.id, r.id, { outcome: "capture_failed", detail: " " }), "invalid");
    store.references.recordFailedAttempt(p.id, r.id, { outcome: "capture_failed", detail: "SaveMyResources saved an empty archive; the site renders in a canvas." });
    const v = store.references.get(p.id, r.id);
    expect(v.status).toBe("failed");
    expect(v.attempts[0]).toMatchObject({ recordedBy: "user", method: "manual_capture", outcome: "capture_failed" });
  });

  it("can be switched to manual observation and back", async () => {
    const p = store.createProject({ name: "P", clientName: "C" });
    const r = store.references.add(p.id, { url: "https://app.example/", label: "", pageType: "" });
    await expectStoreError(() => store.references.setManual(p.id, r.id, { reason: "" }), "invalid");
    store.references.setManual(p.id, r.id, { reason: "Behind the client's competitor's paid login." });
    expect(store.references.get(p.id, r.id).status).toBe("manual");
    store.references.setManual(p.id, r.id, null);
    expect(store.references.get(p.id, r.id).status).toBe("pending");
  });

  it("does not record a check for a reference deleted while the check was running", async () => {
    const p = store.createProject({ name: "P", clientName: "C" });
    const r = store.references.add(p.id, { url: "https://slow.example/", label: "", pageType: "" });
    let release!: () => void;
    const s2 = createStore(db, join(dir, "uploads"), {
      checkUrl: () => new Promise((res) => (release = () => res(result({})))),
    });
    const pending = s2.references.runCheck(p.id, r.id);
    store.references.remove(p.id, r.id);
    release();
    await expectStoreError(() => pending, "not_found");
    expect(db.prepare("select count(*) as n from reference_attempts").get()).toEqual({ n: 0 });
  });
});

describe("captures", () => {
  it("rejects wrong types, empty files and future dates, and writes nothing", async () => {
    const p = store.createProject({ name: "P", clientName: "C" });
    const r = store.references.add(p.id, { url: "https://a.example/", label: "", pageType: "" });
    const meta = { kind: "archive", tool: "SaveMyResources", capturedOn: today, notes: "" };
    await expectStoreError(() => store.references.addCapture(p.id, r.id, meta, { filename: "a.exe", mimeType: "", bytes: zip }), "invalid");
    await expectStoreError(() => store.references.addCapture(p.id, r.id, meta, { filename: "a.zip", mimeType: "", bytes: new Uint8Array() }), "invalid");
    await expectStoreError(() => store.references.addCapture(p.id, r.id, { ...meta, capturedOn: "2999-01-01" }, { filename: "a.zip", mimeType: "", bytes: zip }), "invalid");
    expect(existsSync(join(dir, "uploads", p.id))).toBe(false);
    expect(store.references.get(p.id, r.id).status).toBe("pending");
  });

  it("falls back to the previous evidence when the only capture is deleted", async () => {
    const p = store.createProject({ name: "P", clientName: "C" });
    const r = store.references.add(p.id, { url: "https://a.example/", label: "", pageType: "" });
    nextCheck = result({ outcome: "access_restricted", httpStatus: 401 });
    await store.references.runCheck(p.id, r.id);
    const c = store.references.addCapture(p.id, r.id, { kind: "archive", tool: "SaveMyResources", capturedOn: today, notes: "" }, { filename: "a.zip", mimeType: "", bytes: zip });
    expect(store.references.get(p.id, r.id).status).toBe("captured");
    store.references.removeCapture(p.id, r.id, c.id);
    // Not "checked": the only real check said access was restricted.
    const v = store.references.get(p.id, r.id);
    expect(v.status).toBe("failed");
    expect(decidingAttempt(v.attempts, v.captures)?.outcome).toBe("access_restricted");
  });

  it("deletes files with their capture and with their reference", () => {
    const p = store.createProject({ name: "P", clientName: "C" });
    const r = store.references.add(p.id, { url: "https://a.example/", label: "", pageType: "" });
    const meta = { kind: "screenshot", tool: "Browser screenshot", capturedOn: today, notes: "" };
    const c1 = store.references.addCapture(p.id, r.id, meta, { filename: "a.png", mimeType: "image/png", bytes: zip });
    store.references.addCapture(p.id, r.id, meta, { filename: "b.png", mimeType: "image/png", bytes: zip });
    const refDir = join(dir, "uploads", p.id, "references", r.id);
    expect(readdirSync(refDir)).toHaveLength(2);
    store.references.removeCapture(p.id, r.id, c1.id);
    expect(readdirSync(refDir)).toHaveLength(1);
    store.references.remove(p.id, r.id);
    expect(existsSync(refDir)).toBe(false);
  });

  it("keeps one project's captures out of another's reach", async () => {
    const a = store.createProject({ name: "A", clientName: "A" });
    const b = store.createProject({ name: "B", clientName: "B" });
    const r = store.references.add(a.id, { url: "https://a.example/", label: "", pageType: "" });
    const c = store.references.addCapture(a.id, r.id, { kind: "archive", tool: "SaveMyResources", capturedOn: today, notes: "" }, { filename: "a.zip", mimeType: "", bytes: zip });
    await expectStoreError(() => store.references.readCapture(b.id, r.id, c.id), "not_found");
    await expectStoreError(() => store.references.remove(b.id, r.id), "not_found");
  });
});

describe("observations", () => {
  it("keeps observed and inferred apart, and only links captures of the same reference", async () => {
    const p = store.createProject({ name: "P", clientName: "C" });
    const r1 = store.references.add(p.id, { url: "https://a.example/", label: "", pageType: "" });
    const r2 = store.references.add(p.id, { url: "https://b.example/", label: "", pageType: "" });
    const c = store.references.addCapture(p.id, r1.id, { kind: "screenshot", tool: "Browser", capturedOn: today, notes: "" }, { filename: "a.png", mimeType: "", bytes: zip });

    const o = store.references.addObservation(p.id, r1.id, { aspect: "layout", basis: "observed", text: "Three-column grid", captureId: c.id });
    store.references.addObservation(p.id, r1.id, { aspect: "interaction", basis: "inferred", text: "Probably GSAP ScrollTrigger", captureId: null });
    await expectStoreError(() => store.references.addObservation(p.id, r2.id, { aspect: "layout", basis: "observed", text: "x", captureId: c.id }), "not_found");
    await expectStoreError(() => store.references.addObservation(p.id, r1.id, { aspect: "layout", basis: "observed", text: "  ", captureId: null }), "invalid");

    store.references.updateObservation(p.id, r1.id, o.id, { aspect: "layout", basis: "observed", text: "Three-column grid, two on tablet", captureId: c.id });
    await expectStoreError(() => store.references.updateObservation(p.id, r2.id, o.id, { aspect: "layout", basis: "observed", text: "x", captureId: null }), "not_found");

    // Deleting the capture keeps the observation but drops the link.
    store.references.removeCapture(p.id, r1.id, c.id);
    expect(store.references.get(p.id, r1.id).observations.find((x) => x.id === o.id)?.captureId).toBeNull();
  });
});

describe("library export", () => {
  it("separates evidence, observations and inferences, and validates against the contract", async () => {
    const p = projectWithApprovedBrief();
    store.references.importFromBrief(p.id);
    const [other, studio] = store.references.list(p.id);
    nextCheck = result({ pageTitle: "Studio", inferences: ["Looks like a sign-in page."] });
    await store.references.runCheck(p.id, studio.reference.id);
    store.references.addCapture(p.id, studio.reference.id, { kind: "archive", tool: "SaveMyResources", capturedOn: today, notes: "Home only" }, { filename: "studio.zip", mimeType: "application/zip", bytes: zip });
    store.references.addObservation(p.id, studio.reference.id, { aspect: "visual_style", basis: "observed", text: "Muted palette", captureId: null });
    store.references.addObservation(p.id, studio.reference.id, { aspect: "interaction", basis: "inferred", text: "Likely Lenis smooth scroll", captureId: null });
    nextCheck = result({ outcome: "unreachable", httpStatus: null, detail: "Could not reach the page." });
    await store.references.runCheck(p.id, other.reference.id);

    const lib = ReferenceLibrary.parse(store.references.library(p.id));
    expect(lib.brief).toMatchObject({ version: 1, requiredPageSlugs: ["home", "contact"] });
    expect(lib.summary).toEqual({ references: 2, sites: 2, byStatus: { pending: 0, checked: 0, captured: 1, failed: 1, manual: 0 } });
    expect(lib.usage).toMatch(/Research input only/);

    const s = lib.references.find((x) => x.host === "studio.example")!;
    expect(s.evidence.captures[0]).toMatchObject({ tool: "SaveMyResources", filename: "studio.zip", downloadPath: expect.stringMatching(/\/captures\/.+\/file$/) });
    expect(s.observed.map((o) => o.text)).toEqual(["Muted palette"]);
    expect(s.inferred.map((i) => [i.source, i.text])).toEqual([
      ["person", "Likely Lenis smooth scroll"],
      ["url_check", "Looks like a sign-in page."],
    ]);
    const o = lib.references.find((x) => x.host === "other.example")!;
    expect(o.status).toBe("failed");
    expect(o.evidence.attempts[0]).toMatchObject({ outcome: "unreachable", succeeded: false });
    expect(JSON.stringify(lib)).not.toContain("storageKey");
  });
});
