import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { JourneyBundle } from "@/runtime/journey/bundle";
import { createController } from "@/runtime/journey/controller";
import { synthMp4 } from "@/server/production/media";
import { openDatabase } from "./db";
import { createStore, StoreError, type Store } from "./store";

let dir: string;
let store: Store;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "scl-experience-"));
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

function publishPage(projectId: string, title: string, slug: string) {
  const pg = store.content.createPage(projectId, { title, slug });
  const c = structuredClone(pg.content);
  c.seo.description = "A description long enough to be useful in search results here.";
  store.content.savePage(projectId, pg.id, pg.revision, c);
  for (const a of ["submit", "approve", "publish"] as const) store.content.transition(projectId, pg.id, a);
  return store.content.pages(projectId).find((p) => p.id === pg.id)!;
}

// A site (approved brand, published home and contact pages) and the sample
// journey entered from the home page, its invitation CTA linking to contact.
function setup(name = "Studio") {
  const p = store.createProject({ name, clientName: name });
  const logo = store.addAssetUpload(p.id, { kind: "logo", label: "Logo", notes: "" }, { filename: "logo.png", mimeType: "image/png", bytes: new Uint8Array([0x89, 0x50]) });
  const brand = store.brands.create(p.id, { name });
  const b = store.brands.get(p.id, brand.id).latest;
  const bc = structuredClone(b.content);
  bc.typography.heading.family = { value: "Inter", status: "confirmed", note: "" };
  bc.typography.body.family = { value: "Inter", status: "confirmed", note: "" };
  bc.colors.primary = { value: "#7a1fa2", status: "confirmed", note: "" };
  bc.assets.logos = [{ variant: "primary", ref: { kind: "asset", assetId: logo.id }, background: "any", minWidthPx: null, status: "confirmed", note: "" }];
  store.brands.saveDraft(p.id, brand.id, b.id, bc);
  store.brands.approve(p.id, brand.id, b.id);
  const contact = publishPage(p.id, "Contact", "contact");
  const home = publishPage(p.id, "Home", "");

  const j = store.journeys.create(p.id, { name: "Site visit", start: "sample" });
  const v = store.journeys.get(p.id, j.id).latest;
  const jc = structuredClone(v.content);
  jc.goals.entryPoint = { kind: "page", pageId: home.id };
  const invite = jc.scenes.find((s) => s.type === "conversion")!;
  invite.ctas[0].target = { kind: "section", pageId: contact.id, sectionId: contact.content.sections[0].id };
  store.journeys.saveDraft(p.id, j.id, v.id, jc);
  store.journeys.approve(p.id, j.id, v.id);
  const productionId = store.production.start(p.id, j.id);
  return { p, j, home, contact, productionId, key: store.journeys.get(p.id, j.id).journey.key };
}

const footage = () => synthMp4({ durationSeconds: 15, width: 1280, height: 720 });
function approveAll(projectId: string, productionId: string, except: string[] = []) {
  for (const s of store.production.get(projectId, productionId).shots) {
    if (except.includes(s.scene.title)) continue;
    const t = store.production.uploadManual(projectId, productionId, s.slotId, { filename: `${s.scene.title}.mp4`, bytes: footage(), tool: "Unit test fixture" });
    store.production.review(projectId, productionId, t.id, { decision: "approve", note: "", confirmations: { plays: true, noText: true, loop: true } });
  }
}

describe("journey assembly (WF-08)", () => {
  it("refuses to publish until every scene has approved footage or is explicitly blocked; preview still plays", () => {
    const { p, j, productionId, key } = setup();
    const e = err(() => store.experience.publish(p.id, j.id), "invalid");
    expect(e.issues.filter((i) => /no approved take and is not marked blocked/.test(i.message))).toHaveLength(6);
    // Preview assembles anyway: scenes without footage play as title cards.
    const preview = store.experience.preview(p.id, key)!;
    expect(preview.bundle).not.toBeNull();
    expect(preview.bundle!.scenes.every((s) => s.video === null && s.unavailableReason)).toBe(true);
    expect(store.experience.live(p.id, key)).toMatchObject({ bundle: null });

    approveAll(p.id, productionId, ["Public buildings"]);
    expect(() => store.experience.publish(p.id, j.id)).toThrow(/1 item/);
    const civic = store.production.get(p.id, productionId).shots.find((s) => s.scene.title === "Public buildings")!;
    store.production.setBlocked(p.id, productionId, civic.slotId, "Client to supply footage");
    expect(store.experience.publish(p.id, j.id)).toMatchObject({ number: 1, journeyVersion: 1, productionId });
  });

  it("publishes a validated, provider-free bundle that wires scenes, media, CTAs and the fallback by id", () => {
    const { p, j, home, contact, productionId, key } = setup();
    approveAll(p.id, productionId, ["Public buildings"]);
    const civicShot = store.production.get(p.id, productionId).shots.find((s) => s.scene.title === "Public buildings")!;
    store.production.setBlocked(p.id, productionId, civicShot.slotId, "Client to supply footage");
    store.experience.publish(p.id, j.id);

    const live = store.experience.live(p.id, key)!;
    const b = JourneyBundle.parse(live.bundle);
    expect(b).toMatchObject({ release: { number: 1 }, journey: { key, version: 1 }, aspectRatio: "16:9", entry: { pageId: home.id, sectionId: null }, exit: { href: "/", label: "Home" }, sources: { content: "published", assetManifest: { productionId } } });
    const spec = store.journeys.journeySpec(p.id, j.id, "approved");
    expect(b.scenes.map((s) => s.id)).toEqual(spec.scenes.map((s) => s.id));
    expect(b.startSceneId).toBe(spec.startSceneId);
    // Media: approved takes only, by URL and hash; no provider details.
    const opening = b.scenes[0];
    expect(opening.video).toMatchObject({ type: "video/mp4", width: 1280, height: 720, durationSeconds: 15 });
    expect(opening.video!.src).toMatch(new RegExp(`^/api/projects/${p.id}/production/${productionId}/takes/[0-9a-f-]{36}/file$`));
    expect(JSON.stringify(b)).not.toMatch(/runway|veo|provider|prompt"/i);
    // The blocked scene is a title card; the loop is marked as a loop.
    expect(b.scenes.find((s) => s.title === "Public buildings")).toMatchObject({ video: null, unavailableReason: "Blocked in production: Client to supply footage" });
    expect(b.scenes.find((s) => s.type === "decision")).toMatchObject({ loop: true, choice: { branches: [{ label: "Homes" }, { label: "Public buildings" }] } });
    // CTA: resolved to the published contact section.
    const invite = b.scenes.find((s) => s.type === "conversion")!;
    expect(invite.ctas[0]).toMatchObject({ label: "Talk to the studio", href: `/contact#s-${contact.content.sections[0].id}`, actionKind: "lead_form" });
    // The launcher appears on the entry page.
    expect(store.experience.launchers(p.id, "published")).toEqual([{ key, name: "Site visit", pageId: home.id, sectionId: null, poster: null }]);

    // The runtime walks the published graph: a full branch to the ending.
    const c = createController(b);
    let s = c.reduce(c.initial(), { type: "start" });
    s = c.reduce(s, { type: "media_ended" });
    s = c.reduce(s, { type: "choose", branchId: b.scenes[1].choice!.branches[1].id });
    expect(s).toMatchObject({ sceneId: b.scenes.find((x) => x.title === "Public buildings")!.id, phase: "still" });
    for (let i = 0; i < 3 && s.status === "running"; i++) s = c.reduce(s, { type: "media_ended" });
    expect(s.status).toBe("finished");
  });

  it("refuses links to unpublished pages, keeps releases versioned, and withdraws to the fallback", () => {
    const { p, j, contact, productionId, key } = setup();
    approveAll(p.id, productionId);
    store.experience.publish(p.id, j.id);
    store.content.transition(p.id, contact.id, "unpublish");
    const e = err(() => store.experience.publish(p.id, j.id), "invalid");
    expect(e.issues.map((i) => i.message)).toContain('"Talk to the studio" links to a page that is not published.');
    // The live release is frozen: it is not changed by later content edits.
    expect(store.experience.live(p.id, key)!.bundle!.release!.number).toBe(1);
    for (const a of ["submit", "approve", "publish"] as const) {
      try {
        store.content.transition(p.id, contact.id, a);
      } catch {
        /* already in that state */
      }
    }
    expect(store.experience.publish(p.id, j.id).number).toBe(2);
    expect(store.experience.releases(p.id, j.id).map((r) => r.number)).toEqual([2, 1]);

    store.experience.withdraw(p.id, j.id);
    expect(store.experience.live(p.id, key)).toMatchObject({ bundle: null });
    expect(store.experience.launchers(p.id, "published")).toEqual([]);
    err(() => store.experience.withdraw(p.id, j.id), "conflict");
  });

  it("serves a second project from the same engine, by configuration only, without leaking between projects", () => {
    const a = setup("Studio A");
    const b = setup("Studio B");
    approveAll(a.p.id, a.productionId);
    approveAll(b.p.id, b.productionId);
    store.experience.publish(a.p.id, a.j.id);
    store.experience.publish(b.p.id, b.j.id);
    const ba = store.experience.live(a.p.id, a.key)!.bundle!;
    const bb = store.experience.live(b.p.id, b.key)!.bundle!;
    expect(ba.project.id).toBe(a.p.id);
    expect(bb.project.id).toBe(b.p.id);
    expect(bb.scenes.every((s) => !s.video || s.video.src.includes(b.p.id))).toBe(true);
    err(() => store.experience.publish(b.p.id, a.j.id), "not_found");
  });
});
