import { z } from "zod";

// WF-08: the journey bundle, the only input the journey runtime takes.
//
// It is self-contained and provider-independent: scenes, branches, CTAs and
// media sources, with no knowledge of how media was made (no provider, model
// or prompt) and no knowledge of the project's CMS. Any project that can
// produce a valid bundle can use the runtime; nothing in it is per-project.
//
// Links are either site-relative ("/contact#s-…", prefixed with the site root
// at runtime) or absolute https/mailto/tel. Media sources are same-origin
// paths or https URLs. Both are checked here, at publish time and again when
// the runtime loads the bundle.

export const JOURNEY_BUNDLE_SCHEMA = "scl.wf-08.journey-bundle/v1";

const SitePath = z.string().regex(/^\/(?!\/)[^\s]*$/, "A site path starting with /");
const External = z.string().regex(/^(https:\/\/[^\s]+|mailto:[^\s]+|tel:[+\d][\d\s-]*)$/, "An https, mailto or tel link");
export const Href = z.union([SitePath, External]);
const MediaSrc = z.union([SitePath, z.string().regex(/^https:\/\/[^\s]+$/, "An https media URL")]);

export const TRANSITION_STYLES = ["cut", "crossfade", "match_cut", "whip_pan", "fade_to_black", "continuous"] as const;
const Motion = { style: z.enum(TRANSITION_STYLES), durationMs: z.int().min(0).max(5000) };

export const Destination = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("scene"), sceneId: z.string().min(1) }),
  // Leaves the journey for a conventional page.
  z.object({ kind: z.literal("page"), href: Href }),
]);
export type Destination = z.infer<typeof Destination>;

export const BundleMedia = z.object({
  src: MediaSrc,
  type: z.enum(["video/mp4", "video/quicktime", "video/webm"]),
  width: z.int().positive().nullable(),
  height: z.int().positive().nullable(),
  durationSeconds: z.number().positive().nullable(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
});

export const BundleScene = z.object({
  id: z.string().min(1),
  title: z.string().min(1).max(160),
  type: z.enum(["opening", "transition", "decision", "information", "conversion", "ending"]),
  durationSeconds: z.number().positive(),
  // Moving footage, if any. Without it the scene plays as a title card over
  // the poster or the brand background, and every control still works.
  video: BundleMedia.nullable(),
  loop: z.boolean(),
  poster: z.object({ src: MediaSrc, type: z.enum(["image/png", "image/jpeg", "image/webp"]) }).nullable(),
  // Why there is no video (shown to editors in preview, not to visitors).
  unavailableReason: z.string().max(500).nullable(),
  next: z.object({ to: Destination, ...Motion }).nullable(),
  choice: z
    .object({
      heading: z.string().max(160),
      branches: z.array(z.object({ id: z.string().min(1), label: z.string().min(1).max(60), to: Destination, ...Motion })).min(1).max(6),
      timeout: z.object({ seconds: z.number().min(5).max(600), defaultBranchId: z.string() }).nullable(),
    })
    .nullable(),
  ctas: z.array(
    z.object({
      id: z.string().min(1),
      label: z.string().min(1).max(60),
      href: Href,
      actionKind: z.string().max(40).nullable(),
      placement: z.enum(["overlay", "end_card", "beside"]),
      appearsAtSeconds: z.number().min(0),
    }),
  ),
});
export type BundleScene = z.infer<typeof BundleScene>;

export const JourneyBundle = z.object({
  schema: z.literal(JOURNEY_BUNDLE_SCHEMA),
  generatedAt: z.iso.datetime(),
  // null in preview: assembled on request, never published.
  release: z.object({ number: z.int().positive(), publishedAt: z.iso.datetime() }).nullable(),
  project: z.object({ id: z.string() }),
  journey: z.object({ id: z.string(), key: z.string(), name: z.string(), version: z.int() }),
  // The contracts this bundle was assembled from, for traceability.
  sources: z.object({
    journeySpec: z.object({ schema: z.string(), version: z.int() }),
    assetManifest: z.object({ schema: z.string(), productionId: z.string() }).nullable(),
    content: z.enum(["published", "preview"]),
  }),
  aspectRatio: z.enum(["16:9", "9:16", "1:1", "4:5", "21:9"]),
  // Where the journey sits on the conventional site (a launcher is shown there).
  entry: z.object({ pageId: z.string(), sectionId: z.string().nullable() }).nullable(),
  // Where visitors go when they leave, finish, or the journey cannot play.
  exit: z.object({ href: Href, label: z.string().min(1).max(60) }),
  startSceneId: z.string(),
  scenes: z.array(BundleScene).min(1),
});
export type JourneyBundle = z.infer<typeof JourneyBundle>;

export type BundleIssue = { level: "error" | "warning"; sceneId: string | null; message: string };

// Referential checks zod cannot express. Errors mean the runtime must not
// play the bundle (it falls back to the conventional site instead).
export function checkBundle(input: unknown): { bundle: JourneyBundle | null; issues: BundleIssue[] } {
  const parsed = JourneyBundle.safeParse(input);
  if (!parsed.success) return { bundle: null, issues: parsed.error.issues.map((i) => ({ level: "error", sceneId: null, message: `${i.path.join(".")}: ${i.message}` })) };
  const b = parsed.data;
  const issues: BundleIssue[] = [];
  const ids = new Set(b.scenes.map((s) => s.id));
  if (ids.size !== b.scenes.length) issues.push({ level: "error", sceneId: null, message: "Scene ids are not unique" });
  if (!ids.has(b.startSceneId)) issues.push({ level: "error", sceneId: null, message: "The start scene does not exist" });
  const dest = (d: Destination, sceneId: string, what: string) => {
    if (d.kind === "scene" && !ids.has(d.sceneId)) issues.push({ level: "error", sceneId, message: `${what} leads to a scene that does not exist` });
  };
  for (const s of b.scenes) {
    if (s.next) dest(s.next.to, s.id, "The next transition");
    if (s.choice) {
      s.choice.branches.forEach((br) => dest(br.to, s.id, `Choice "${br.label}"`));
      if (s.choice.timeout && !s.choice.branches.some((br) => br.id === s.choice!.timeout!.defaultBranchId)) issues.push({ level: "error", sceneId: s.id, message: "The timeout's default choice does not exist" });
    }
    if (s.next && s.choice) issues.push({ level: "error", sceneId: s.id, message: "A scene has both a next scene and choices" });
    if (s.loop && !s.choice) issues.push({ level: "warning", sceneId: s.id, message: "A looping scene without choices only advances when skipped" });
  }
  return { bundle: issues.some((i) => i.level === "error") ? null : b, issues };
}
