import { describe, expect, it } from "vitest";
import { JourneyContent, NO_TEXT_NEGATIVE, type Scene } from "./journey";
import { blankScene, sampleJourney, templateJourney } from "./journey-samples";
import { sceneOrder, validateJourney, type JourneyContext } from "./journey-validate";

const ctx: JourneyContext = { pages: [], assetIds: new Set(), captures: new Set(), desiredActions: ["lead_form"] };
const errors = (j: JourneyContent) => validateJourney(j, ctx).filter((i) => i.level === "error").map((i) => i.message);
const warnings = (j: JourneyContent) => validateJourney(j, ctx).filter((i) => i.level === "warning").map((i) => i.message);
const byTitle = (j: JourneyContent, t: string) => j.scenes.find((s) => s.title === t)!;

describe("sample and templates", () => {
  it("the sample journey is complete: valid schema, no errors, no warnings", () => {
    const j = sampleJourney();
    expect(JourneyContent.safeParse(j).success).toBe(true);
    expect(errors(j)).toEqual([]);
    expect(warnings(j)).toEqual([]);
  });

  it("templates are structurally sound but list every missing production detail", () => {
    for (const kind of ["linear", "branching"] as const) {
      const j = templateJourney(kind, { objective: "x", audience: "y", aspectRatio: "16:9", targetRuntimeSeconds: 60, intendedActions: ["lead_form"], conversion: { kind: "url", url: "https://example.com/contact" }, conversionAction: "lead_form" });
      expect(JourneyContent.safeParse(j).success).toBe(true);
      const e = errors(j);
      expect(e.filter((m) => /Unreachable|Invalid transition|goes nowhere|never reach|Missing conversion/.test(m))).toEqual([]);
      expect(e).toEqual(expect.arrayContaining(['"Opening": visual description is missing', '"Opening": generation prompt is missing']));
    }
  });
});

describe("structure", () => {
  it("reports missing scenes", () => {
    const j = sampleJourney();
    expect(errors({ ...j, scenes: [], startSceneId: null })).toEqual(["Missing scenes: the journey has none"]);
    const noEnding = structuredClone(j);
    noEnding.scenes = noEnding.scenes.filter((s) => s.type !== "ending");
    byTitle(noEnding, "Start a conversation").next = null;
    expect(errors(noEnding)).toContain("Missing scene: add at least one ending scene");
  });

  it("reports unreachable scenes and branches to nowhere", () => {
    const j = sampleJourney();
    const orphan = { ...blankScene("information", "16:9", "Orphan"), next: { id: crypto.randomUUID(), to: byTitle(j, "Closing").id, style: "cut" as const, durationMs: 0 } };
    j.scenes.push(orphan);
    expect(errors(j)).toContain('Unreachable: no path from the opening leads to "Orphan"');
    const choice = byTitle(j, "Choose a building");
    choice.branches[1].to = crypto.randomUUID();
    expect(errors(j)).toContain('Invalid transition: "Choose a building" leads to a scene that does not exist');
    expect(errors(j)).toContain('Unreachable: no path from the opening leads to "Public buildings"');
  });

  it("reports invalid transitions: to itself, back to the opening, branches on non-decisions", () => {
    const j = sampleJourney();
    const homes = byTitle(j, "Homes");
    homes.next!.to = homes.id;
    expect(errors(j)).toContain('Invalid transition: "Homes" leads to itself');
    homes.next!.to = j.startSceneId!;
    expect(errors(j)).toContain('Invalid transition: "Homes" leads back to the opening scene');
    homes.branches = [{ id: crypto.randomUUID(), label: "x", to: byTitle(j, "Closing").id, style: "cut", durationMs: 0 }];
    expect(errors(j)).toContain("Only decision scenes have branches; \"Homes\" is information");
  });

  it("requires decisions to offer a real choice, with labels and a valid timeout", () => {
    const j = sampleJourney();
    const c = byTitle(j, "Choose a building");
    c.branches[0].label = "";
    c.decisionTimeout!.defaultBranchId = crypto.randomUUID();
    expect(errors(j)).toEqual(expect.arrayContaining(['Branch 1 of "Choose a building" needs a label for its on-screen choice', 'The timeout of "Choose a building" defaults to a branch that does not exist']));
    c.branches = c.branches.slice(0, 1);
    expect(errors(j)).toContain('"Choose a building" needs at least two branches');
  });

  it("reports loops with no way out", () => {
    const j = sampleJourney();
    // Public buildings → Homes and Homes → Public buildings: neither reaches the end.
    byTitle(j, "Homes").next!.to = byTitle(j, "Public buildings").id;
    byTitle(j, "Public buildings").next!.to = byTitle(j, "Homes").id;
    expect(errors(j)).toContain('"Homes" can never reach an ending (a loop with no way out)');
  });

  it("reports missing conversion paths, overall and per branch", () => {
    const j = sampleJourney();
    const civic = byTitle(j, "Public buildings");
    civic.next!.to = byTitle(j, "Closing").id;
    expect(warnings(j)).toContain('Branch "Public buildings" of "Choose a building" never reaches a conversion scene');
    byTitle(j, "Homes").next!.to = byTitle(j, "Closing").id;
    expect(errors(j)).toContain("Missing conversion path: no path from the opening reaches a conversion scene");
    const conv = byTitle(j, "Start a conversation");
    conv.ctas = [];
    expect(errors(j)).toContain('Conversion scene "Start a conversation" needs at least one call to action');
  });
});

describe("production readiness and text policy", () => {
  it("requires every field production needs", () => {
    const j = sampleJourney();
    const s = byTitle(j, "Homes") as Scene;
    s.visual.lighting = "";
    s.prompt.positive = "";
    s.assetSlots = [];
    expect(errors(j)).toEqual(expect.arrayContaining(['"Homes": lighting is missing', '"Homes": generation prompt is missing', '"Homes": needs a required video or loop asset slot']));
  });

  it("keeps interface text out of footage", () => {
    const j = sampleJourney();
    byTitle(j, "Start a conversation").prompt.positive += ", with a button that says Contact us";
    expect(warnings(j).some((w) => /mentions "button"/.test(w))).toBe(true);
    expect(byTitle(j, "Homes").prompt.negative).toBe(NO_TEXT_NEGATIVE);
  });

  it("checks keyframe references belong to this project", () => {
    const j = sampleJourney();
    byTitle(j, "Homes").keyframes[0].ref = { kind: "asset", assetId: crypto.randomUUID() };
    expect(errors(j)).toContain("Keyframe refers to an asset not in this project's register");
  });

  it("orders scenes breadth-first from the opening", () => {
    const { order } = sceneOrder(sampleJourney());
    expect(order.map((s) => s.title)).toEqual(["Arrival at dusk", "Choose a building", "Homes", "Public buildings", "Start a conversation", "Closing"]);
  });
});
