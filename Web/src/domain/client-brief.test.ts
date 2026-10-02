import { describe, expect, it } from "vitest";
import { ClientBriefDraft, emptyDraft, evaluateDraft, type ClientBriefDraft as Draft } from "./client-brief";
import { completeConventionalDraft } from "./test-fixtures";

const paths = (d: Draft) => evaluateDraft(d).completeness.issues.map((i) => i.path);

describe("evaluateDraft", () => {
  it("treats an empty draft as incomplete without failing to evaluate it", () => {
    const { completeness, content } = evaluateDraft(emptyDraft());
    expect(content).toBeNull();
    expect(completeness.complete).toBe(false);
    expect(completeness.percent).toBeLessThan(50);
    expect(paths(emptyDraft())).toEqual(expect.arrayContaining(["deliveryMode", "industry", "audiences", "desiredActions"]));
  });

  it("checks cross-field rules even while other fields are failing", () => {
    const { completeness } = evaluateDraft(emptyDraft());
    const pages = completeness.sections.find((s) => s.key === "pages");
    expect(pages?.complete).toBe(false);
    expect(completeness.issues).toContainEqual({ path: "requiredPages", message: "Add at least one required page." });
    expect(completeness.issues).toContainEqual({ path: "deliveryMode", message: "Choose what we are delivering" });

    const d = { ...emptyDraft(), deliveryMode: "combined" as const };
    expect(paths(d)).toContain("cinematic");
  });

  it("approves a complete conventional brief and normalises blanks to null", () => {
    const { completeness, content } = evaluateDraft(completeConventionalDraft());
    expect(completeness.complete).toBe(true);
    expect(completeness.percent).toBe(100);
    expect(content?.cinematic).toBeNull();
    expect(content?.referenceUrls[0].note).toBeNull();
    expect(content?.constraints.launchDate).toBeNull();
  });

  it("ignores rows left completely blank but reports half-filled ones", () => {
    const d = completeConventionalDraft();
    d.audiences.push({ name: "", description: "" });
    expect(evaluateDraft(d).completeness.complete).toBe(true);
    d.audiences.push({ name: "Planners", description: "" });
    expect(paths(d)).toContain("audiences.2.description");
  });

  it("points errors at the form row, not the filtered row", () => {
    const d = completeConventionalDraft();
    // A blank row before a bad one: the bad one is row 2 in the form.
    d.referenceUrls = [{ url: "https://ok.example", note: "" }, { url: "", note: "" }, { url: "not a url", note: "" }];
    expect(paths(d)).toContain("referenceUrls.2.url");
    expect(paths(d)).not.toContain("referenceUrls.1.url");
  });

  it("requires the cinematic section only when the deliverable includes a journey", () => {
    const d = completeConventionalDraft();
    d.deliveryMode = "combined";
    expect(paths(d)).toContain("cinematic");
    d.cinematic = { intent: "A walk through the venue at dusk", targetRuntimeSeconds: null, branching: true };
    expect(paths(d)).toContain("cinematic.targetRuntimeSeconds");
    d.cinematic.targetRuntimeSeconds = 90;
    expect(evaluateDraft(d).completeness.complete).toBe(true);
  });

  it("drops cinematic details for a conventional site rather than failing it", () => {
    const d = completeConventionalDraft();
    d.cinematic = { intent: "Left over from an earlier choice", targetRuntimeSeconds: 60, branching: false };
    const { content } = evaluateDraft(d);
    expect(content?.cinematic).toBeNull();
  });

  it("lets a cinematic-only project skip pages, but not a website", () => {
    const d = completeConventionalDraft();
    d.requiredPages = [];
    expect(paths(d)).toContain("requiredPages");
    d.deliveryMode = "cinematic";
    d.cinematic = { intent: "A guided film", targetRuntimeSeconds: 120, branching: false };
    expect(evaluateDraft(d).completeness.complete).toBe(true);
    expect(evaluateDraft(d).completeness.sections.find((s) => s.key === "pages")?.applicable).toBe(false);
  });

  it("flags duplicate and malformed page slugs at the row", () => {
    const d = completeConventionalDraft();
    d.requiredPages.push({ slug: "home", title: "Home again", purpose: "dup" });
    d.requiredPages.push({ slug: "About Us", title: "About", purpose: "About" });
    expect(paths(d)).toEqual(expect.arrayContaining(["requiredPages.2.slug", "requiredPages.3.slug"]));
  });

  it("rejects non-http URLs and bad language tags", () => {
    const d = completeConventionalDraft();
    d.websiteUrl = "ftp://files.example.com";
    d.constraints.locales = ["English"];
    expect(paths(d)).toEqual(expect.arrayContaining(["websiteUrl", "constraints.locales.0"]));
  });
});

describe("ClientBriefDraft", () => {
  it("accepts a half-written draft", () => {
    expect(ClientBriefDraft.safeParse({ ...emptyDraft(), industry: "Retail" }).success).toBe(true);
  });

  it("rejects unknown fields and oversized values, so a draft cannot smuggle data", () => {
    expect(ClientBriefDraft.safeParse({ ...emptyDraft(), contactEmail: "a@b.c" }).success).toBe(false);
    expect(ClientBriefDraft.safeParse({ ...emptyDraft(), summary: "x".repeat(2001) }).success).toBe(false);
  });
});
