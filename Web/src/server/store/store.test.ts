import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BriefHandoff } from "@/domain/brief-handoff";
import { completeConventionalDraft } from "@/domain/test-fixtures";
import type { DatabaseSync } from "node:sqlite";
import { openDatabase } from "./db";
import { createStore, StoreError, type Store } from "./store";

// Runs against a real SQLite file in a temp directory: the same code path the
// app uses, constraints and all.

let dir: string;
let store: Store;
let dbFile: string;
let db: DatabaseSync;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "scl-store-"));
  dbFile = join(dir, "scl.sqlite");
  db = openDatabase(dbFile);
  store = createStore(db, join(dir, "uploads"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const newProject = () => store.createProject({ name: "Anaïs website", clientName: "Anaïs Events" });

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

describe("projects", () => {
  it("creates a project with an empty draft brief and an activity entry", () => {
    const p = newProject();
    expect(p.slug).toBe("anais-website");
    const detail = store.getProject(p.id)!;
    expect(detail.latest).toMatchObject({ version: 1, status: "draft" });
    expect(detail.summary.stage).toBe("brief_in_progress");
    expect(store.listActivity(5, p.id)[0].kind).toBe("project_created");
  });

  it("validates required fields and keeps slugs unique", () => {
    const err = expectStoreError(() => store.createProject({ name: " ", clientName: "" }), "invalid");
    expect(err.issues.map((i) => i.path).sort()).toEqual(["clientName", "name"]);
    newProject();
    expect(newProject().slug).toBe("anais-website-2");
  });

  it("survives reopening the database", () => {
    const p = newProject();
    const reopened = createStore(openDatabase(dbFile), join(dir, "uploads"));
    expect(reopened.getProject(p.id)?.project.name).toBe("Anaïs website");
  });
});

describe("brief lifecycle", () => {
  it("saves an incomplete draft, then refuses to approve it", () => {
    const p = newProject();
    const { latest } = store.getProject(p.id)!;
    store.saveDraft(p.id, latest.id, { ...latest.draft, industry: "Weddings" });
    expect(store.getProject(p.id)!.latest.draft.industry).toBe("Weddings");
    const err = expectStoreError(() => store.approveBrief(p.id, latest.id), "invalid");
    expect(err.issues.length).toBeGreaterThan(0);
    expect(store.getProject(p.id)!.latest.status).toBe("draft");
  });

  it("rejects a malformed draft without writing it", () => {
    const p = newProject();
    const { latest } = store.getProject(p.id)!;
    expectStoreError(() => store.saveDraft(p.id, latest.id, { industry: 42 }), "invalid");
    expect(store.getProject(p.id)!.latest.draft.industry).toBe("");
  });

  it("approves, freezes, revises and supersedes", () => {
    const p = newProject();
    const v1 = store.getProject(p.id)!.latest;
    store.saveDraft(p.id, v1.id, completeConventionalDraft());
    const approved = store.approveBrief(p.id, v1.id);
    expect(approved).toMatchObject({ version: 1, status: "approved" });
    expect(approved.content?.industry).toBe("Wedding planning");

    // An approved version cannot be edited in place.
    expectStoreError(() => store.saveDraft(p.id, v1.id, completeConventionalDraft()), "conflict");

    const v2 = store.reviseBrief(p.id);
    expect(v2).toMatchObject({ version: 2, status: "draft" });
    expect(store.getProject(p.id)!.summary.stage).toBe("brief_revision");
    // While v2 is a draft, v1 is still what downstream receives.
    expect(store.getBriefHandoff(p.id)?.brief.version).toBe(1);

    store.saveDraft(p.id, v2.id, { ...completeConventionalDraft(), industry: "Luxury weddings" });
    store.approveBrief(p.id, v2.id);
    const handoff = store.getBriefHandoff(p.id)!;
    expect(handoff.brief.version).toBe(2);
    expect(handoff.brief.content.industry).toBe("Luxury weddings");
    expect(store.getProject(p.id)!.summary.stage).toBe("brief_approved");
  });

  it("refuses a save from a stale editor", () => {
    const p = newProject();
    const v1 = store.getProject(p.id)!.latest;
    store.saveDraft(p.id, v1.id, completeConventionalDraft());
    store.approveBrief(p.id, v1.id);
    store.reviseBrief(p.id);
    expectStoreError(() => store.saveDraft(p.id, v1.id, completeConventionalDraft()), "conflict");
  });
});

describe("asset register", () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);

  it("stores an upload under a generated key and reads it back", () => {
    const p = newProject();
    const asset = store.addAssetUpload(
      p.id,
      { kind: "logo", label: "Primary logo", notes: "" },
      { filename: "../../etc/logo.png", mimeType: "image/png", bytes: png },
    );
    if (asset.source.type !== "upload") throw new Error("expected upload");
    expect(asset.source.file.storageKey).toBe(`${p.id}/${asset.id}`);
    expect(asset.source.file.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(Array.from(store.readAssetFile(p.id, asset.id).bytes)).toEqual(Array.from(png));
  });

  it("rejects a file type the kind does not accept, and writes nothing", () => {
    const p = newProject();
    expectStoreError(
      () => store.addAssetUpload(p.id, { kind: "font", label: "Font", notes: "" }, { filename: "x.exe", mimeType: "", bytes: png }),
      "invalid",
    );
    expect(existsSync(join(dir, "uploads", p.id))).toBe(false);
    expect(store.getProject(p.id)!.assets).toHaveLength(0);
  });

  it("removes the stored file when the record cannot be written", () => {
    const p = newProject();
    // Make the insert itself fail, after the file has been written - the way a
    // locked or full database would.
    db.exec("create trigger fail_asset_insert before insert on assets begin select raise(abort, 'simulated write failure'); end;");
    expect(() =>
      store.addAssetUpload(p.id, { kind: "logo", label: "Logo", notes: "" }, { filename: "a.png", mimeType: "image/png", bytes: png }),
    ).toThrow(/simulated write failure/);
    expect(readdirSync(join(dir, "uploads", p.id))).toHaveLength(0);
    expect(store.getProject(p.id)!.assets).toHaveLength(0);
  });

  it("rolls back a failed save entirely, including its activity entry", () => {
    const p = newProject();
    const { latest } = store.getProject(p.id)!;
    db.exec("create trigger fail_activity before insert on activity begin select raise(abort, 'simulated write failure'); end;");
    expect(() => store.saveDraft(p.id, latest.id, { ...latest.draft, industry: "Weddings" })).toThrow(/simulated/);
    expect(store.getProject(p.id)!.latest.draft.industry).toBe("");
  });

  it("records links, removes assets with their files, and includes them in the handoff", () => {
    const p = newProject();
    store.addAssetUrl(p.id, { kind: "font", label: "Brand font licence", notes: "", url: "https://fonts.example.com/brand" });
    const up = store.addAssetUpload(p.id, { kind: "logo", label: "Logo", notes: "" }, { filename: "logo.png", mimeType: "image/png", bytes: png });
    expectStoreError(() => store.addAssetUrl(p.id, { kind: "font", label: "x", notes: "", url: "javascript:alert(1)" }), "invalid");

    const v1 = store.getProject(p.id)!.latest;
    store.saveDraft(p.id, v1.id, completeConventionalDraft());
    store.approveBrief(p.id, v1.id);
    const handoff = BriefHandoff.parse(store.getBriefHandoff(p.id));
    expect(handoff.assets).toHaveLength(2);
    const file = handoff.assets.find((a) => a.source.type === "upload");
    expect(file?.source).toMatchObject({ type: "upload", file: { downloadPath: `/api/projects/${p.id}/assets/${up.id}/file` } });
    // The storage key is internal and is not handed on.
    expect(JSON.stringify(handoff)).not.toContain("storageKey");

    store.removeAsset(p.id, up.id);
    expect(readdirSync(join(dir, "uploads", p.id))).toHaveLength(0);
    expect(store.getProject(p.id)!.assets).toHaveLength(1);
  });

  it("does not let one project read or remove another project's asset", () => {
    const a = newProject();
    const b = store.createProject({ name: "Other", clientName: "Other Co" });
    const asset = store.addAssetUpload(a.id, { kind: "logo", label: "Logo", notes: "" }, { filename: "l.png", mimeType: "image/png", bytes: png });
    expectStoreError(() => store.readAssetFile(b.id, asset.id), "not_found");
    expectStoreError(() => store.removeAsset(b.id, asset.id), "not_found");
  });
});

describe("handoff", () => {
  it("is null until a brief is approved", () => {
    const p = newProject();
    expect(store.getBriefHandoff(p.id)).toBeNull();
  });
});
