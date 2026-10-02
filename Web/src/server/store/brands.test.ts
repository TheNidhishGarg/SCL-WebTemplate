import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BrandExport } from "@/domain/brand-contract";
import { staticSite } from "@/server/wf03/test-fixtures";
import { openDatabase } from "./db";
import { createStore, StoreError, type Store } from "./store";

let dir: string;
let store: Store;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "scl-brand-"));
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
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

function setup() {
  const p = store.createProject({ name: "Acme", clientName: "Acme" });
  const logo = store.addAssetUpload(p.id, { kind: "logo", label: "Acme logo", notes: "" }, { filename: "logo.png", mimeType: "image/png", bytes: png });
  const brand = store.brands.create(p.id, { name: "Acme" });
  return { p, logo, brand };
}

describe("brands", () => {
  it("creates a default draft, saves, and refuses invalid values with field errors", () => {
    const { p, brand } = setup();
    const v1 = store.brands.get(p.id, brand.id).latest;
    expect(v1).toMatchObject({ version: 1, status: "draft" });
    const bad = structuredClone(v1.content) as unknown as { colors: { primary: { value: string } } };
    bad.colors.primary.value = "red";
    const e = err(() => store.brands.saveDraft(p.id, brand.id, v1.id, bad), "invalid");
    expect(e.issues).toContainEqual({ path: "colors.primary.value", message: "Use a 6-digit hex colour, e.g. #1A2B3C" });
    expect(store.brands.get(p.id, brand.id).latest.content.colors.primary.value).toBe("#1d4ed8");
  });

  it("suggests from owned sources and the register, never from study-only sources", () => {
    const { p, brand } = setup();
    store.sources.registerUpload(p.id, { label: "Agency site", originUrl: "", originRef: "", authorization: { basis: "study_only", note: "", license: "" } }, { filename: "a.zip", bytes: staticSite() });
    store.sources.runScan(p.id, store.sources.list(p.id)[0].source.id);
    const v1 = store.brands.get(p.id, brand.id).latest;
    const r = store.brands.suggest(p.id, brand.id, v1.id);
    expect(r.applied).toEqual(["assets.logos"]); // the study-only source's --brand and Inter are not used
    expect(store.brands.get(p.id, brand.id).latest.content.colors.primary.status).toBe("default");
  });

  it("blocks approval until errors are fixed, then versions like the brief", () => {
    const { p, logo, brand } = setup();
    const v1 = store.brands.get(p.id, brand.id).latest;
    const e = err(() => store.brands.approve(p.id, brand.id, v1.id), "invalid");
    expect(e.issues.map((i) => i.path)).toEqual(expect.arrayContaining(["typography.heading.family.value", "assets.logos"]));

    const c = structuredClone(v1.content);
    c.typography.heading.family = { value: "Inter", status: "confirmed", note: "" };
    c.typography.body.family = { value: "Inter", status: "confirmed", note: "" };
    c.assets.logos = [{ variant: "primary", ref: { kind: "asset", assetId: logo.id }, background: "any", minWidthPx: null, status: "confirmed", note: "" }];
    store.brands.saveDraft(p.id, brand.id, v1.id, c);
    expect(store.brands.approve(p.id, brand.id, v1.id)).toMatchObject({ version: 1, status: "approved" });
    err(() => store.brands.saveDraft(p.id, brand.id, v1.id, c), "conflict");

    const v2 = store.brands.revise(p.id, brand.id);
    c.colors.primary = { value: "#7a1fa2", status: "confirmed", note: "" };
    store.brands.saveDraft(p.id, brand.id, v2.id, c);
    expect(store.brands.exportJson(p.id, brand.id, "approved").cssVariables["--scl-color-primary"]).toBe("#1d4ed8");
    expect(store.brands.exportJson(p.id, brand.id, "latest").cssVariables["--scl-color-primary"]).toBe("#7a1fa2");
    store.brands.approve(p.id, brand.id, v2.id);
    const ex = BrandExport.parse(store.brands.exportJson(p.id, brand.id, "approved"));
    expect(ex.version).toMatchObject({ number: 2, status: "approved" });
    expect(ex.provenance.confirmed).toContain("colors.primary");
    expect(ex.assets[0].location).toEqual({ kind: "asset", assetId: logo.id, url: `/api/projects/${p.id}/assets/${logo.id}/file` });
    expect(store.brands.get(p.id, brand.id).versions.map((v) => [v.version, v.status])).toEqual([
      [2, "approved"],
      [1, "superseded"],
    ]);
    // The CSS export carries the same values as the JSON.
    const css = store.brands.exportCss(p.id, brand.id, "approved", true);
    for (const [k, v] of Object.entries(ex.cssVariables)) expect(css).toContain(`${k}: ${v};`);
    expect(css).toContain(`[data-scl-brand="${brand.key}"] {`);
  });

  it("keeps projects isolated: no reading another project's brand, no using its assets", () => {
    const a = setup();
    const b = store.createProject({ name: "Other", clientName: "Other" });
    err(() => store.brands.get(b.id, a.brand.id), "not_found");
    err(() => store.brands.exportCss(b.id, a.brand.id, "latest", false), "not_found");
    const otherBrand = store.brands.create(b.id, { name: "Other" });
    const v = store.brands.get(b.id, otherBrand.id).latest;
    const c = structuredClone(v.content);
    c.assets.logos = [{ variant: "primary", ref: { kind: "asset", assetId: a.logo.id }, background: "any", minWidthPx: null, status: "confirmed", note: "" }];
    const e = err(() => store.brands.saveDraft(b.id, otherBrand.id, v.id, c), "invalid");
    expect(e.issues[0]).toEqual({ path: "assets.logos.0.ref", message: "Not in this project's asset register" });
    // Same brand name in two projects: separate keys, separate scopes.
    expect(store.brands.create(b.id, { name: "Acme" }).key).toBe("acme");
  });

  it("supports several brands in one project", () => {
    const { p } = setup();
    const sub = store.brands.create(p.id, { name: "Acme" });
    expect(sub.key).toBe("acme-2");
    expect(store.brands.list(p.id)).toHaveLength(2);
  });
});
