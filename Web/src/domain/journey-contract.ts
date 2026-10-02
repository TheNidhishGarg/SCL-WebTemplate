import { z } from "zod";
import { AspectRatio, CameraMovement, SceneType, TransitionStyle } from "./journey";

// WF-06 exports. Two documents from one approved journey version:
//   scene manifest (WF-07): what to produce, scene by scene, slot by slot.
//   journey spec (WF-08):   how the journey plays: graph, choices, CTAs.
// Both carry the same journey id and version, and the same scene, slot,
// transition, branch and CTA ids, so an asset produced for slot X in WF-07
// is placed by WF-08 without guessing.

export const SCENE_MANIFEST_SCHEMA = "scl.wf-06.scene-manifest/v1";
export const JOURNEY_SPEC_SCHEMA = "scl.wf-06.journey-spec/v1";

const Header = {
  generatedAt: z.iso.datetime(),
  project: z.object({ id: z.string(), slug: z.string() }),
  journey: z.object({ id: z.string(), key: z.string(), name: z.string() }),
  version: z.object({ number: z.int(), status: z.enum(["draft", "approved", "superseded"]), approvedAt: z.iso.datetime().nullable() }),
};
const Issue = z.object({ sceneId: z.string().nullable(), path: z.string(), level: z.enum(["error", "warning"]), area: z.string(), message: z.string() });
const ResolvedRef = z.object({ kind: z.enum(["asset", "reference_capture", "url"]), url: z.string() }).nullable();

export const SceneManifest = z.object({
  schema: z.literal(SCENE_MANIFEST_SCHEMA),
  ...Header,
  format: z.object({ aspectRatio: AspectRatio, targetRuntimeSeconds: z.int() }),
  // The WF-04 brand to keep visual continuity with (colour, mood), if any.
  brand: z.object({ id: z.string(), version: z.int(), configPath: z.string() }).nullable(),
  textPolicy: z.literal("No text, captions, UI or logos may be generated into footage. All interface text is overlaid by WF-08."),
  scenes: z.array(
    z.object({
      id: z.string(),
      order: z.int(),
      title: z.string(),
      type: SceneType,
      purpose: z.string(),
      durationSeconds: z.number(),
      aspectRatio: AspectRatio,
      visual: z.object({ description: z.string(), subject: z.string(), environment: z.string(), lighting: z.string(), mood: z.string(), camera: CameraMovement, cameraNotes: z.string() }),
      continuity: z.object({ notes: z.string(), matchesSceneIds: z.array(z.string()) }),
      keyframes: z.array(z.object({ id: z.string(), label: z.string(), position: z.string(), ref: ResolvedRef, notes: z.string() })),
      visualNotes: z.string(),
      prompt: z.object({ positive: z.string(), negative: z.string() }),
      assetSlots: z.array(
        z.object({
          id: z.string(),
          kind: z.enum(["video", "loop", "still", "audio"]),
          label: z.string(),
          durationSeconds: z.number().nullable(),
          required: z.boolean(),
          // What WF-07 output must satisfy to fill this slot.
          acceptance: z.object({ aspectRatio: AspectRatio, minDurationSeconds: z.number().nullable(), seamlessLoop: z.boolean(), noBurnedInText: z.literal(true) }),
        }),
      ),
      // Where interface elements will sit, so footage leaves room for them.
      overlays: z.array(z.object({ kind: z.enum(["choice", "cta"]), label: z.string(), placement: z.string(), atSeconds: z.number().nullable() })),
    }),
  ),
  issues: z.array(Issue),
});
export type SceneManifest = z.infer<typeof SceneManifest>;

const Target = z.object({ kind: z.enum(["page", "section", "url"]), pageId: z.string().nullable(), sectionId: z.string().nullable(), path: z.string() });

export const JourneySpec = z.object({
  schema: z.literal(JOURNEY_SPEC_SCHEMA),
  ...Header,
  goals: z.object({ objective: z.string(), audience: z.string(), intendedActions: z.array(z.string()), successCriteria: z.array(z.object({ id: z.string(), metric: z.string(), target: z.string() })) }),
  entryPoint: z.object({ kind: z.enum(["page_section", "page", "standalone"]), pageId: z.string().nullable(), sectionId: z.string().nullable(), path: z.string().nullable() }),
  // Where visitors go when the journey cannot play (no JS, data saver,
  // reduced motion by choice): a conventional WF-05 page.
  fallback: z.object({ path: z.string().nullable(), reason: z.string() }),
  startSceneId: z.string(),
  scenes: z.array(
    z.object({
      id: z.string(),
      order: z.int(),
      type: SceneType,
      title: z.string(),
      durationSeconds: z.number(),
      slotIds: z.array(z.string()),
      next: z.object({ id: z.string(), to: z.string(), style: TransitionStyle, durationMs: z.int() }).nullable(),
      choice: z
        .object({
          branches: z.array(z.object({ id: z.string(), label: z.string(), to: z.string(), style: TransitionStyle, durationMs: z.int() })),
          timeout: z.object({ seconds: z.number(), defaultBranchId: z.string() }).nullable(),
        })
        .nullable(),
      ctas: z.array(z.object({ id: z.string(), label: z.string(), actionKind: z.string().nullable(), target: Target, placement: z.string(), appearsAtSeconds: z.number() })),
    }),
  ),
  endingSceneIds: z.array(z.string()),
  conversionSceneIds: z.array(z.string()),
  issues: z.array(Issue),
});
export type JourneySpec = z.infer<typeof JourneySpec>;
