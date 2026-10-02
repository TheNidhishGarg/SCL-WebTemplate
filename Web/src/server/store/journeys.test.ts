import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NO_TEXT_NEGATIVE } from "@/domain/journey";
import { JourneySpec, SceneManifest } from "@/domain/journey-contract";
import { openDatabase } from "./db";
import { createStore, StoreError, type Store } from "./store";

let dir: string;
let store: Store;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "scl-journey-"));
  store = createStore(openDatabase(join(dir, "scl.sqlite")), join(dir, "uploads"), { checkUrl: async () => { throw new Error("offline"); } });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const err = (fn: () => unknown, code: string) => {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(StoreError);
    expect((e as StoreError).code).toBe(code);
    return e as StoreError;
  }
  throw new Error("expected StoreError");
};

describe("journeys", () => {
  it("plans, approves and exports a complete journey with no video anywhere", () => {
    const p = store.createProject({ name: "P", clientName: "P" });
    const j = store.journeys.create(p.id, { name: "Site visit", start: "sample" });
    const v1 = store.journeys.get(p.id, j.id).latest;
    expect(store.journeys.approve(p.id, j.id, v1.id)).toMatchObject({ version: 1, status: "approved" });

    const m = SceneManifest.parse(store.journeys.sceneManifest(p.id, j.id, "approved"));
    expect(m.scenes.map((s) => s.order)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(m.scenes.every((s) => s.prompt.negative.includes(NO_TEXT_NEGATIVE))).toBe(true);
    expect(m.scenes.every((s) => s.assetSlots.every((a) => a.acceptance.noBurnedInText))).toBe(true);
    const choice = m.scenes.find((s) => s.type === "decision")!;
    expect(choice.assetSlots[0].acceptance).toMatchObject({ seamlessLoop: true, minDurationSeconds: 6 });
    expect(choice.overlays.map((o) => o.label)).toEqual(["Homes", "Public buildings"]);

    const spec = JourneySpec.parse(store.journeys.journeySpec(p.id, j.id, "approved"));
    // The same ids in both exports.
    expect(spec.scenes.map((s) => s.id)).toEqual(m.scenes.map((s) => s.id));
    expect(spec.scenes.flatMap((s) => s.slotIds)).toEqual(m.scenes.flatMap((s) => s.assetSlots.map((a) => a.id)));
    const specChoice = spec.scenes.find((s) => s.type === "decision")!;
    expect(specChoice.choice?.branches).toHaveLength(2);
    expect(specChoice.choice?.timeout?.defaultBranchId).toBe(specChoice.choice?.branches[0].id);
    expect(spec.conversionSceneIds).toHaveLength(1);
  });

  it("refuses approval with errors, and versions like the brand", () => {
    const p = store.createProject({ name: "P", clientName: "P" });
    const j = store.journeys.create(p.id, { name: "Draft", start: "branching" });
    const v1 = store.journeys.get(p.id, j.id).latest;
    const e = err(() => store.journeys.approve(p.id, j.id, v1.id), "invalid");
    expect(e.issues.length).toBeGreaterThan(5);
    err(() => store.journeys.sceneManifest(p.id, j.id, "approved"), "not_found");
    // The latest draft can still be exported for review.
    expect(SceneManifest.parse(store.journeys.sceneManifest(p.id, j.id, "latest")).issues.length).toBeGreaterThan(0);

    const s = store.journeys.create(p.id, { name: "Sample", start: "sample" });
    const sv = store.journeys.get(p.id, s.id).latest;
    store.journeys.approve(p.id, s.id, sv.id);
    err(() => store.journeys.saveDraft(p.id, s.id, sv.id, sv.content), "conflict");
    const v2 = store.journeys.revise(p.id, s.id);
    expect(v2).toMatchObject({ version: 2, status: "draft" });
    expect(store.journeys.sceneManifest(p.id, s.id, "approved").version.number).toBe(1);
  });

  it("links CTAs and entry points to WF-05 pages, and flags them when the page goes", () => {
    const p = store.createProject({ name: "P", clientName: "P" });
    const page = store.content.createPage(p.id, { title: "Contact", slug: "contact" });
    const j = store.journeys.create(p.id, { name: "Visit", start: "sample" });
    const v = store.journeys.get(p.id, j.id).latest;
    const c = structuredClone(v.content);
    c.goals.entryPoint = { kind: "page_section", pageId: page.id, sectionId: page.content.sections[0].id };
    c.scenes.find((s) => s.type === "conversion")!.ctas[0].target = { kind: "page", pageId: page.id };
    store.journeys.saveDraft(p.id, j.id, v.id, c);
    const spec = store.journeys.journeySpec(p.id, j.id, "latest");
    expect(spec.entryPoint).toMatchObject({ kind: "page_section", pageId: page.id, path: "/contact" });
    expect(spec.fallback.path).toBe("/contact");
    expect(spec.scenes.find((s) => s.type === "conversion")!.ctas[0].target).toMatchObject({ kind: "page", path: "/contact" });

    store.content.deletePage(p.id, page.id);
    const msgs = store.journeys.validate(p.id, store.journeys.get(p.id, j.id).latest.content).map((i) => i.message);
    expect(msgs).toEqual(expect.arrayContaining(["The entry page no longer exists (WF-05)", 'CTA "Talk to the studio" links to a page that no longer exists (WF-05)']));
  });

  it("keeps projects isolated", () => {
    const a = store.createProject({ name: "A", clientName: "A" });
    const b = store.createProject({ name: "B", clientName: "B" });
    const j = store.journeys.create(a.id, { name: "Visit", start: "sample" });
    err(() => store.journeys.get(b.id, j.id), "not_found");
    err(() => store.journeys.journeySpec(b.id, j.id, "latest"), "not_found");
    const asset = store.addAssetUpload(b.id, { kind: "photography", label: "x", notes: "" }, { filename: "x.png", mimeType: "image/png", bytes: new Uint8Array([1]) });
    const v = store.journeys.get(a.id, j.id).latest;
    const c = structuredClone(v.content);
    c.scenes[0].keyframes[0].ref = { kind: "asset", assetId: asset.id };
    store.journeys.saveDraft(a.id, j.id, v.id, c);
    const e = err(() => store.journeys.approve(a.id, j.id, v.id), "invalid");
    expect(e.issues.map((i) => i.message)).toContain("Keyframe refers to an asset not in this project's register");
  });
});
