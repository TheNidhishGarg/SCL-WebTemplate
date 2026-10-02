import { NO_TEXT_NEGATIVE, type JourneyContent, type Scene, type SceneType, type TransitionStyle } from "./journey";

// Starting points for a journey: two structural templates (valid graphs with
// the production details left blank for the team to fill) and one complete
// sample, which passes every check and shows what "ready for production"
// looks like.

const uuid = () => crypto.randomUUID();

export function blankScene(type: SceneType, aspectRatio: Scene["aspectRatio"], title = ""): Scene {
  return {
    id: uuid(),
    title,
    type,
    purpose: "",
    durationSeconds: type === "transition" ? 3 : type === "decision" ? 8 : 10,
    aspectRatio,
    visual: { description: "", subject: "", environment: "", lighting: "", mood: "", camera: "static", cameraNotes: "" },
    continuity: { notes: "", matchesSceneIds: [] },
    keyframes: [],
    visualNotes: "",
    prompt: { positive: "", negative: NO_TEXT_NEGATIVE },
    assetSlots: [{ id: uuid(), kind: type === "decision" ? "loop" : "video", label: type === "decision" ? "Choice loop" : "Main shot", durationSeconds: null, required: true }],
    next: null,
    branches: [],
    decisionTimeout: null,
    ctas: [],
  };
}

const link = (from: Scene, to: Scene, style: TransitionStyle = "crossfade") => {
  from.next = { id: uuid(), to: to.id, style, durationMs: style === "cut" ? 0 : 600 };
};

export type TemplateInput = {
  objective: string;
  audience: string;
  aspectRatio: Scene["aspectRatio"];
  targetRuntimeSeconds: number;
  intendedActions: string[];
  conversion: Scene["ctas"][number]["target"] | null;
  conversionAction: string | null;
};

export function templateJourney(kind: "linear" | "branching", t: TemplateInput): JourneyContent {
  const cta = (scene: Scene) => {
    if (t.conversion) scene.ctas = [{ id: uuid(), label: "", actionKind: t.conversionAction, target: t.conversion, placement: "end_card", appearsAtSeconds: Math.max(0, scene.durationSeconds - 4) }];
  };
  const opening = blankScene("opening", t.aspectRatio, "Opening");
  let scenes: Scene[];
  if (kind === "linear") {
    const info = blankScene("information", t.aspectRatio, "Story");
    const conv = blankScene("conversion", t.aspectRatio, "Invitation");
    const end = blankScene("ending", t.aspectRatio, "Ending");
    link(opening, info);
    link(info, conv);
    link(conv, end, "fade_to_black");
    cta(conv);
    scenes = [opening, info, conv, end];
  } else {
    const choice = blankScene("decision", t.aspectRatio, "Choice");
    const a = blankScene("information", t.aspectRatio, "Path A");
    const b = blankScene("information", t.aspectRatio, "Path B");
    const conv = blankScene("conversion", t.aspectRatio, "Invitation");
    const end = blankScene("ending", t.aspectRatio, "Ending");
    link(opening, choice);
    choice.branches = [
      { id: uuid(), label: "", to: a.id, style: "crossfade", durationMs: 600 },
      { id: uuid(), label: "", to: b.id, style: "crossfade", durationMs: 600 },
    ];
    link(a, conv);
    link(b, conv);
    link(conv, end, "fade_to_black");
    cta(conv);
    scenes = [opening, choice, a, b, conv, end];
  }
  return {
    goals: { objective: t.objective, audience: t.audience, entryPoint: { kind: "standalone" }, intendedActions: t.intendedActions, successCriteria: [] },
    format: { aspectRatio: t.aspectRatio, targetRuntimeSeconds: t.targetRuntimeSeconds },
    startSceneId: opening.id,
    scenes,
  };
}

// A complete, production-ready example: an architecture studio's site visit
// with a choice between two buildings. Every field filled, every check passed.
export function sampleJourney(intendedAction = "lead_form"): JourneyContent {
  const ar = "16:9" as const;
  const scene = (type: SceneType, title: string, f: Omit<Partial<Scene>, "prompt"> & { visual: Scene["visual"]; purpose: string; prompt: string }): Scene => ({
    ...blankScene(type, ar, title),
    ...f,
    prompt: { positive: f.prompt, negative: NO_TEXT_NEGATIVE },
  });
  const opening = scene("opening", "Arrival at dusk", {
    purpose: "Set the tone: calm, crafted, local. Establish the studio's landscape.",
    durationSeconds: 12,
    visual: { description: "Slow approach along a gravel path towards a low timber house glowing at dusk.", subject: "Timber house", environment: "Wooded hillside, late autumn", lighting: "Blue hour, warm interior light", mood: "Calm, inviting", camera: "dolly_in", cameraNotes: "Steady, walking pace" },
    prompt: "Cinematic slow dolly along a gravel path toward a low timber house on a wooded hillside at blue hour, warm light glowing from large windows, light mist, 35mm, shallow depth of field",
    visualNotes: "Hold the final frame for the choice overlay.",
  });
  const choice = scene("decision", "Choose a building", {
    purpose: "Let the visitor pick what interests them: homes or public buildings.",
    durationSeconds: 10,
    visual: { description: "The camera settles on the house facade; light shifts gently while the visitor chooses.", subject: "House facade", environment: "Same hillside", lighting: "Blue hour", mood: "Expectant", camera: "static", cameraNotes: "Locked off, seamless loop" },
    prompt: "Locked-off shot of a timber house facade at blue hour, subtle movement of trees and mist, seamless loop",
    assetSlots: [{ id: uuid(), kind: "loop", label: "Choice loop", durationSeconds: 6, required: true }],
  });
  const homes = scene("information", "Homes", {
    purpose: "Show how the studio designs homes around the people living in them.",
    durationSeconds: 15,
    visual: { description: "Inside a family kitchen: morning light, a table being set, a child at the window.", subject: "Family kitchen", environment: "Interior of the timber house", lighting: "Soft morning daylight", mood: "Warm, lived-in", camera: "truck", cameraNotes: "Gentle lateral move" },
    prompt: "Warm morning light in a timber family kitchen, people setting a table, a child at a large window, gentle lateral camera movement, natural colour",
  });
  const civic = scene("information", "Public buildings", {
    purpose: "Show the studio's public work: a library full of people.",
    durationSeconds: 15,
    visual: { description: "A daylit timber library, people reading, a reading room with tall windows.", subject: "Library interior", environment: "Public library", lighting: "Bright diffuse daylight", mood: "Open, civic", camera: "crane", cameraNotes: "Rise from floor to balcony level" },
    prompt: "Crane shot rising through a daylit timber library, people reading at long tables, tall windows, calm atmosphere",
  });
  const invite = scene("conversion", "Start a conversation", {
    purpose: "Invite the visitor to talk to the studio about their project.",
    durationSeconds: 10,
    visual: { description: "Back outside, an architect opens the front door and steps aside invitingly.", subject: "Architect at the door", environment: "Entrance of the timber house", lighting: "Warm interior spilling outward", mood: "Welcoming", camera: "static", cameraNotes: "Leave space on the right for the overlay" },
    prompt: "An architect opens the front door of a timber house at dusk and steps aside invitingly, warm light spilling out, static camera, generous negative space on the right",
  });
  const end = scene("ending", "Closing", {
    purpose: "Close calmly and hand over to the website.",
    durationSeconds: 6,
    visual: { description: "Wide shot of the house in the landscape as the light fades.", subject: "House in landscape", environment: "Wooded hillside", lighting: "Last light", mood: "Resolved", camera: "dolly_out", cameraNotes: "Slow pull back" },
    prompt: "Wide slow pull back from a timber house on a wooded hillside as the last light fades",
  });
  link(opening, choice);
  choice.branches = [
    { id: uuid(), label: "Homes", to: homes.id, style: "crossfade", durationMs: 600 },
    { id: uuid(), label: "Public buildings", to: civic.id, style: "crossfade", durationMs: 600 },
  ];
  choice.decisionTimeout = { seconds: 20, defaultBranchId: choice.branches[0].id };
  link(homes, invite, "match_cut");
  link(civic, invite, "match_cut");
  link(invite, end, "fade_to_black");
  invite.ctas = [{ id: uuid(), label: "Talk to the studio", actionKind: intendedAction, target: { kind: "url", url: "mailto:studio@example.com" }, placement: "beside", appearsAtSeconds: 4 }];
  homes.continuity = { notes: "Same house as the opening; interior matches the window light seen from outside.", matchesSceneIds: [opening.id] };
  invite.continuity = { notes: "Same entrance and dusk light as the opening.", matchesSceneIds: [opening.id] };
  for (const s of [opening, choice, homes, civic, invite, end]) {
    s.keyframes = [{ id: uuid(), label: `${s.title}: key frame`, position: "middle", ref: null, notes: s.visual.description }];
  }
  return {
    goals: {
      objective: "Make visitors feel what it is like to live and work in the studio's buildings, and start a conversation.",
      audience: "Families and public clients considering a new building",
      entryPoint: { kind: "standalone" },
      intendedActions: [intendedAction],
      successCriteria: [{ id: uuid(), metric: "Journeys reaching the invitation", target: "60% of starts" }],
    },
    format: { aspectRatio: ar, targetRuntimeSeconds: 60 },
    startSceneId: opening.id,
    scenes: [opening, choice, homes, civic, invite, end],
  };
}
