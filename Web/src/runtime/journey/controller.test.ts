import { describe, expect, it } from "vitest";
import { checkBundle, JOURNEY_BUNDLE_SCHEMA, type JourneyBundle } from "./bundle";
import { createController, type Event, type State } from "./controller";

// TEST FIXTURE bundle: placeholder media paths, not production assets.
const video = (n: string) => ({ src: `/fixture/${n}.mp4`, type: "video/mp4" as const, width: 1280, height: 720, durationSeconds: 6, sha256: null });
const motion = { style: "crossfade" as const, durationMs: 600 };
function fixture(over: (b: JourneyBundle) => void = () => {}): JourneyBundle {
  const b: JourneyBundle = {
    schema: JOURNEY_BUNDLE_SCHEMA,
    generatedAt: new Date().toISOString(),
    release: null,
    project: { id: "fixture-project" },
    journey: { id: "fixture-journey", key: "fixture", name: "Fixture journey", version: 1 },
    sources: { journeySpec: { schema: "scl.wf-06.journey-spec/v1", version: 1 }, assetManifest: null, content: "preview" },
    aspectRatio: "16:9",
    entry: null,
    exit: { href: "/", label: "Continue to the website" },
    startSceneId: "open",
    scenes: [
      { id: "open", title: "Opening", type: "opening", durationSeconds: 6, video: video("open"), loop: false, poster: null, unavailableReason: null, next: { to: { kind: "scene", sceneId: "pick" }, ...motion }, choice: null, ctas: [] },
      {
        id: "pick",
        title: "Choose",
        type: "decision",
        durationSeconds: 6,
        video: video("loop"),
        loop: true,
        poster: null,
        unavailableReason: null,
        next: null,
        choice: {
          heading: "Where next?",
          branches: [
            { id: "a", label: "Homes", to: { kind: "scene", sceneId: "homes" }, ...motion },
            { id: "b", label: "Contact page", to: { kind: "page", href: "/contact" }, ...motion },
          ],
          timeout: { seconds: 20, defaultBranchId: "a" },
        },
        ctas: [],
      },
      { id: "homes", title: "Homes", type: "information", durationSeconds: 6, video: null, loop: false, poster: null, unavailableReason: "Blocked: client footage", next: { to: { kind: "scene", sceneId: "end" }, ...motion }, choice: null, ctas: [] },
      {
        id: "end",
        title: "Closing",
        type: "ending",
        durationSeconds: 6,
        video: video("end"),
        loop: false,
        poster: null,
        unavailableReason: null,
        next: null,
        choice: null,
        ctas: [{ id: "cta", label: "Talk to us", href: "/contact#s-1", actionKind: "lead_form", placement: "end_card", appearsAtSeconds: 4 }],
      },
    ],
  };
  over(b);
  return b;
}

const run = (b: JourneyBundle, events: Event[], from?: State) => {
  const c = createController(b);
  return events.reduce(c.reduce, from ?? c.initial());
};

describe("journey bundle", () => {
  it("accepts a valid bundle and rejects broken references and unsafe links", () => {
    expect(checkBundle(fixture())).toMatchObject({ issues: [] });
    expect(checkBundle(fixture((b) => (b.startSceneId = "nope"))).bundle).toBeNull();
    const dangling = checkBundle(fixture((b) => (b.scenes[0].next!.to = { kind: "scene", sceneId: "gone" })));
    expect(dangling.issues[0].message).toMatch(/does not exist/);
    expect(checkBundle(fixture((b) => (b.scenes[3].ctas[0].href = "javascript:alert(1)"))).bundle).toBeNull();
    expect(checkBundle(fixture((b) => (b.scenes[0].video!.src = "//evil.example/x.mp4"))).bundle).toBeNull();
    expect(checkBundle(fixture((b) => (b.scenes[0].video!.src = "http://insecure.example/x.mp4"))).bundle).toBeNull();
    expect(checkBundle(fixture((b) => (b.scenes[1].choice!.timeout!.defaultBranchId = "z"))).bundle).toBeNull();
    expect(checkBundle({ schema: "scl.wf-08.journey-bundle/v0" }).bundle).toBeNull();
  });
});

describe("journey controller", () => {
  it("plays a branch end to end: start → ended → choice → title card → ending", () => {
    const b = fixture();
    const c = createController(b);
    let s = c.initial();
    expect(s.status).toBe("intro");
    s = c.reduce(s, { type: "start" });
    expect(s).toMatchObject({ status: "running", sceneId: "open", phase: "loading", visited: ["open"] });
    s = c.reduce(s, { type: "media_playing" });
    s = c.reduce(s, { type: "media_ended" });
    expect(s).toMatchObject({ sceneId: "pick", phase: "loading", transition: { style: "crossfade" }, timer: "running", cause: "media" });
    expect(c.view(s).choices.map((x) => x.label)).toEqual(["Homes", "Contact page"]);
    expect(c.view(s).canSkip).toBe(false);
    // A loop never ends on its own; the decision waits.
    expect(c.reduce(s, { type: "media_ended" })).toBe(s);
    s = c.reduce(s, { type: "choose", branchId: "a" });
    expect(s).toMatchObject({ sceneId: "homes", phase: "still", cause: "visitor", history: ["open", "pick"] });
    s = c.reduce(s, { type: "media_ended" }); // the player's title-card timer
    expect(s).toMatchObject({ sceneId: "end", phase: "loading" });
    expect(c.view(s).ctas).toHaveLength(0);
    s = c.reduce(s, { type: "media_time", seconds: 4.2 });
    expect(c.view(s).ctas.map((x) => x.label)).toEqual(["Talk to us"]);
    s = c.reduce(s, { type: "media_ended" });
    expect(s).toMatchObject({ status: "finished", phase: "ended", visited: ["open", "pick", "homes", "end"] });
  });

  it("branches to a conventional page, and the timeout picks the default only while it runs", () => {
    const b = fixture();
    const atPick = run(b, [{ type: "start" }, { type: "skip" }]);
    expect(atPick.sceneId).toBe("pick");
    expect(run(b, [{ type: "choose", branchId: "b" }], atPick)).toMatchObject({ status: "exited", exitHref: "/contact" });
    expect(run(b, [{ type: "timeout" }], atPick)).toMatchObject({ sceneId: "homes", cause: "media" });
    const stopped = run(b, [{ type: "stop_timer" }, { type: "timeout" }], atPick);
    expect(stopped).toMatchObject({ sceneId: "pick", timer: "stopped" });
    expect(createController(b).view(stopped).timeout).toBeNull();
    expect(run(b, [{ type: "choose", branchId: "zzz" }], atPick)).toBe(atPick);
  });

  it("playback failure leaves every control working; retry remounts the media", () => {
    const b = fixture();
    const c = createController(b);
    let s = run(b, [{ type: "start" }, { type: "media_error", message: "MEDIA_ERR_SRC_NOT_SUPPORTED" }]);
    expect(s).toMatchObject({ sceneId: "open", phase: "failed", error: "MEDIA_ERR_SRC_NOT_SUPPORTED" });
    expect(c.view(s).canSkip).toBe(true);
    const retried = c.reduce(s, { type: "retry" });
    expect(retried).toMatchObject({ phase: "loading", error: null, attempt: 1 });
    s = c.reduce(s, { type: "skip" });
    expect(s.sceneId).toBe("pick");
    // A failed ending still offers its CTAs at once.
    const end = run(b, [{ type: "start" }, { type: "skip" }, { type: "choose", branchId: "a" }, { type: "skip" }, { type: "media_error", message: "x" }]);
    expect(end.sceneId).toBe("end");
    expect(c.view(end).ctas).toHaveLength(1);
  });

  it("handles autoplay refusal, buffering, pause and resume", () => {
    const b = fixture();
    let s = run(b, [{ type: "start" }, { type: "autoplay_blocked" }]);
    expect(s.phase).toBe("blocked");
    s = run(b, [{ type: "play" }, { type: "media_playing" }, { type: "media_waiting" }], s);
    expect(s.phase).toBe("buffering");
    s = run(b, [{ type: "media_playing" }, { type: "pause" }], s);
    expect(s.phase).toBe("paused");
    expect(run(b, [{ type: "media_waiting" }], s).phase).toBe("paused");
    expect(run(b, [{ type: "play" }], s).phase).toBe("loading");
  });

  it("goes back, restarts, leaves, and resumes saved progress", () => {
    const b = fixture();
    let s = run(b, [{ type: "start" }, { type: "skip" }, { type: "choose", branchId: "a" }]);
    s = run(b, [{ type: "back" }], s);
    expect(s).toMatchObject({ sceneId: "pick", history: ["open"] });
    s = run(b, [{ type: "back" }, { type: "back" }], s);
    expect(s).toMatchObject({ sceneId: "open", history: [] });
    expect(run(b, [{ type: "restart" }], s)).toMatchObject({ sceneId: "open", history: [], visited: ["open"], transition: { style: "fade_to_black" } });
    expect(run(b, [{ type: "leave" }], s)).toMatchObject({ status: "exited", exitHref: "/" });
    const resumed = run(b, [{ type: "resume_saved", sceneId: "homes", history: ["open", "pick", "gone"], visited: ["open", "pick", "homes"] }]);
    expect(resumed).toMatchObject({ status: "running", sceneId: "homes", history: ["open", "pick"], phase: "still" });
    expect(run(b, [{ type: "resume_saved", sceneId: "gone", history: [], visited: [] }]).status).toBe("intro");
  });

  it("is generic: a different bundle drives the same controller with no code change", () => {
    const linear = fixture((b) => {
      b.journey = { id: "other", key: "other", name: "Another project's film", version: 3 };
      b.scenes = [b.scenes[0], { ...b.scenes[3], id: "pick" }];
    });
    expect(checkBundle(linear).issues).toEqual([]);
    expect(run(linear, [{ type: "start" }, { type: "media_ended" }, { type: "media_ended" }])).toMatchObject({ status: "finished", visited: ["open", "pick"] });
  });
});
