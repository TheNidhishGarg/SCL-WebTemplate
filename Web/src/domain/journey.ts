import { z } from "zod";

// WF-06: a cinematic journey, planned as a graph of scenes. It is a plan, not
// footage: nothing here needs a video to exist, and the plan can be reviewed,
// approved and exported before WF-07 produces anything.
//
// Interface text never goes into footage. Branch labels and CTAs are data the
// live site overlays as HTML (WF-08); generation prompts always carry a
// no-on-screen-text instruction, and prompts that ask for text are flagged.
//
// Every scene, transition, branch, CTA, keyframe and asset slot has a UUID
// that never changes, so WF-07 assets and WF-08 runtime state can refer to them.

export const JourneyId = z.uuid().brand<"JourneyId">();

export const SceneType = z.enum(["opening", "transition", "decision", "information", "conversion", "ending"]);
export type SceneType = z.infer<typeof SceneType>;
export const SCENE_TYPE_LABELS: Record<SceneType, string> = {
  opening: "Opening",
  transition: "Transition",
  decision: "Decision",
  information: "Information",
  conversion: "Conversion",
  ending: "Ending",
};

export const AspectRatio = z.enum(["16:9", "9:16", "1:1", "4:5", "21:9"]);
export const CameraMovement = z.enum(["static", "pan", "tilt", "dolly_in", "dolly_out", "truck", "pedestal", "crane", "orbit", "handheld", "drone", "zoom"]);
export const TransitionStyle = z.enum(["cut", "crossfade", "match_cut", "whip_pan", "fade_to_black", "continuous"]);
export type TransitionStyle = z.infer<typeof TransitionStyle>;

const Text = (max: number) => z.string().trim().max(max);
const Id = z.uuid();

export const MediaRef = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("asset"), assetId: z.uuid() }),
  z.object({ kind: z.literal("reference_capture"), referenceId: z.uuid(), captureId: z.uuid() }),
  z.object({ kind: z.literal("url"), url: z.url({ protocol: /^https$/, error: "Use an https URL" }) }),
]);
export type MediaRef = z.infer<typeof MediaRef>;

export const Keyframe = z.object({
  id: Id,
  label: Text(80),
  position: z.enum(["start", "middle", "end"]),
  ref: MediaRef.nullable(),
  notes: Text(1000),
});

export const AssetSlot = z.object({
  id: Id,
  kind: z.enum(["video", "loop", "still", "audio"]),
  label: Text(80),
  durationSeconds: z.number().min(0.5).max(600).nullable(),
  required: z.boolean(),
});
export type AssetSlot = z.infer<typeof AssetSlot>;

export const Transition = z.object({ id: Id, to: Id, style: TransitionStyle, durationMs: z.int().min(0).max(5000) });
export const Branch = z.object({
  id: Id,
  // Shown as an HTML button over the footage by WF-08; never rendered into video.
  label: Text(60),
  to: Id,
  style: TransitionStyle,
  durationMs: z.int().min(0).max(5000),
});
export type Branch = z.infer<typeof Branch>;

export const CtaTarget = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("page"), pageId: Id }),
  z.object({ kind: z.literal("section"), pageId: Id, sectionId: Id }),
  z.object({ kind: z.literal("url"), url: z.url({ protocol: /^(https|mailto|tel)$/, error: "Use https://, mailto: or tel:" }) }),
]);
export const JourneyCta = z.object({
  id: Id,
  label: Text(60),
  actionKind: z.string().max(40).nullable(),
  target: CtaTarget,
  placement: z.enum(["overlay", "end_card", "beside"]),
  appearsAtSeconds: z.number().min(0).max(600),
});
export type JourneyCta = z.infer<typeof JourneyCta>;

export const Scene = z.object({
  id: Id,
  title: Text(80),
  type: SceneType,
  purpose: Text(500),
  durationSeconds: z.number().min(1, "At least 1 second").max(120, "At most 120 seconds per scene"),
  aspectRatio: AspectRatio,
  visual: z.object({
    description: Text(2000),
    subject: Text(300),
    environment: Text(300),
    lighting: Text(300),
    mood: Text(200),
    camera: CameraMovement,
    cameraNotes: Text(300),
  }),
  continuity: z.object({
    // What must stay the same as the scenes it follows or matches.
    notes: Text(1000),
    matchesSceneIds: z.array(Id).max(10),
  }),
  keyframes: z.array(Keyframe).max(8),
  visualNotes: Text(2000),
  prompt: z.object({ positive: Text(4000), negative: Text(1000) }),
  assetSlots: z.array(AssetSlot).max(8),
  // Linear scenes: where it goes next. Null for endings and decisions.
  next: Transition.nullable(),
  // Decision scenes only.
  branches: z.array(Branch).max(6),
  decisionTimeout: z.object({ seconds: z.number().min(3).max(120), defaultBranchId: Id }).nullable(),
  // Conversion (and optionally other) scenes: overlaid calls to action.
  ctas: z.array(JourneyCta).max(4),
});
export type Scene = z.infer<typeof Scene>;

export const EntryPoint = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("page_section"), pageId: Id, sectionId: Id }),
  z.object({ kind: z.literal("page"), pageId: Id }),
  z.object({ kind: z.literal("standalone") }),
]);

export const JourneyContent = z
  .object({
    goals: z.object({
      objective: Text(1000),
      audience: Text(500),
      entryPoint: EntryPoint,
      intendedActions: z.array(z.string().max(40)).max(10),
      successCriteria: z.array(z.object({ id: Id, metric: Text(120), target: Text(120) })).max(10),
    }),
    format: z.object({ aspectRatio: AspectRatio, targetRuntimeSeconds: z.int().min(10).max(1800) }),
    startSceneId: Id.nullable(),
    scenes: z.array(Scene).max(60),
  })
  .strict();
export type JourneyContent = z.infer<typeof JourneyContent>;

// Appended to every exported negative prompt: footage must stay free of text
// so the interface can be localised, made accessible and changed without
// regenerating video.
export const NO_TEXT_NEGATIVE = "no on-screen text, no captions, no subtitles, no logos rendered as text, no UI elements, no buttons, no watermarks";

// Positive-prompt wording that asks for text in the frame.
export const TEXT_REQUEST = /\b(text|caption|subtitle|title card|words?|lettering|typography|button|logo (?:text|wordmark)|sign that says|says ["'])\b/i;
