import type { BundleScene, Destination, JourneyBundle } from "./bundle";

// The Journey Controller: a pure state machine over a validated bundle. It
// decides which scene is showing, what the playback state is, which
// transition to run, and what the visitor has seen. It never touches the DOM
// or a <video>; the player reports media events in and performs effects out.
// That keeps every branch and failure path testable without a browser.

export type Phase =
  | "loading" // waiting for the media to start
  | "playing"
  | "buffering" // started, then ran out of data
  | "paused" // by the visitor, or the page was hidden
  | "blocked" // the browser refused to start playback without a gesture
  | "ended" // reached the end (choices/CTAs remain)
  | "failed" // media error: the scene is shown as a title card, controls still work
  | "still"; // no footage for this scene: a title card by design

export type State = {
  status: "intro" | "running" | "finished" | "exited";
  sceneId: string;
  phase: Phase;
  time: number;
  history: string[]; // scenes visited before the current one, for Back
  visited: string[]; // every scene seen, in order (progress)
  transition: { style: string; durationMs: number } | null; // how the current scene was entered
  timer: "running" | "stopped"; // the decision timeout, if the scene has one
  error: string | null;
  exitHref: string | null;
  attempt: number; // bumps to remount the media after "Try again"
  cause: "visitor" | "media" | null; // what caused the last scene change (focus management)
};

export type Event =
  | { type: "start" }
  | { type: "resume_saved"; sceneId: string; history: string[]; visited: string[] }
  | { type: "media_playing" }
  | { type: "media_waiting" }
  | { type: "media_time"; seconds: number }
  | { type: "media_ended" }
  | { type: "media_error"; message: string }
  | { type: "autoplay_blocked" }
  | { type: "pause" }
  | { type: "play" }
  | { type: "retry" }
  | { type: "choose"; branchId: string }
  | { type: "timeout" }
  | { type: "stop_timer" }
  | { type: "skip" }
  | { type: "back" }
  | { type: "restart" }
  | { type: "leave" };

export function createController(bundle: JourneyBundle) {
  const scenes = new Map(bundle.scenes.map((s) => [s.id, s]));
  const scene = (id: string): BundleScene => scenes.get(id) ?? bundle.scenes[0];
  const entryPhase = (s: BundleScene): Phase => (s.video ? "loading" : "still");

  const initial = (): State => ({
    status: "intro",
    sceneId: bundle.startSceneId,
    phase: entryPhase(scene(bundle.startSceneId)),
    time: 0,
    history: [],
    visited: [],
    transition: null,
    timer: "stopped",
    error: null,
    exitHref: null,
    attempt: 0,
    cause: null,
  });

  const enter = (s: State, sceneId: string, transition: State["transition"], cause: State["cause"], history = [...s.history, s.sceneId]): State => {
    const next = scene(sceneId);
    return {
      ...s,
      status: "running",
      sceneId,
      phase: entryPhase(next),
      time: 0,
      history,
      visited: [...s.visited, sceneId],
      transition,
      timer: next.choice?.timeout ? "running" : "stopped",
      error: null,
      cause,
    };
  };

  const go = (s: State, to: Destination, motion: { style: string; durationMs: number }, cause: State["cause"]): State =>
    to.kind === "page" ? { ...s, status: "exited", exitHref: to.href, timer: "stopped", cause } : enter(s, to.sceneId, motion, cause);

  // What happens when a scene is over (it ended, failed and was skipped, or had no footage).
  const advance = (s: State, cause: State["cause"]): State => {
    const cur = scene(s.sceneId);
    if (cur.next) return go(s, cur.next.to, cur.next, cause);
    if (cur.choice) return { ...s, phase: "ended" }; // wait for a choice
    return { ...s, status: "finished", phase: "ended", timer: "stopped" };
  };

  function reduce(s: State, e: Event): State {
    const cur = scene(s.sceneId);
    switch (e.type) {
      case "start":
        return enter({ ...initial(), visited: [] }, bundle.startSceneId, null, "visitor", []);
      case "resume_saved": {
        if (!scenes.has(e.sceneId)) return s;
        const resumed = enter(initial(), e.sceneId, null, "visitor", e.history.filter((id) => scenes.has(id)));
        return { ...resumed, visited: e.visited.filter((id) => scenes.has(id)) };
      }
      case "media_playing":
        return s.status === "running" ? { ...s, phase: "playing", error: null } : s;
      case "media_waiting":
        return s.phase === "playing" ? { ...s, phase: "buffering" } : s;
      case "media_time":
        return { ...s, time: e.seconds };
      case "media_ended":
        if (s.status !== "running" || cur.loop) return s;
        return advance(s, "media");
      case "media_error":
        return s.status === "running" ? { ...s, phase: "failed", error: e.message } : s;
      case "autoplay_blocked":
        return s.status === "running" ? { ...s, phase: "blocked" } : s;
      case "pause":
        return s.phase === "playing" || s.phase === "buffering" || s.phase === "loading" ? { ...s, phase: "paused" } : s;
      case "play":
        return s.phase === "paused" || s.phase === "blocked" ? { ...s, phase: "loading" } : s;
      case "retry":
        return cur.video ? { ...s, phase: "loading", error: null, attempt: s.attempt + 1 } : s;
      case "choose": {
        const br = cur.choice?.branches.find((b) => b.id === e.branchId);
        return br && s.status === "running" ? go(s, br.to, br, "visitor") : s;
      }
      case "timeout": {
        const t = cur.choice?.timeout;
        const br = t && cur.choice!.branches.find((b) => b.id === t.defaultBranchId);
        return br && s.timer === "running" && s.status === "running" ? go(s, br.to, br, "media") : s;
      }
      case "stop_timer":
        return { ...s, timer: "stopped" };
      case "skip":
        // Decision scenes are never skipped past: the visitor must choose.
        return s.status === "running" && !cur.choice ? advance(s, "visitor") : s;
      case "back": {
        if (s.history.length === 0) return s;
        const prev = s.history[s.history.length - 1];
        return enter(s, prev, { style: "cut", durationMs: 0 }, "visitor", s.history.slice(0, -1));
      }
      case "restart":
        return enter({ ...initial(), visited: [] }, bundle.startSceneId, { style: "fade_to_black", durationMs: 600 }, "visitor", []);
      case "leave":
        return { ...s, status: "exited", exitHref: bundle.exit.href, timer: "stopped", cause: "visitor" };
    }
  }

  // Overlays shown for the current state: what the visitor can act on.
  const view = (s: State) => {
    const cur = scene(s.sceneId);
    const settled = s.phase === "ended" || s.phase === "failed" || s.phase === "still" || s.status === "finished";
    return {
      scene: cur,
      index: bundle.scenes.indexOf(cur),
      // Choices are offered as soon as the decision scene is on screen.
      choices: s.status === "running" && cur.choice ? cur.choice.branches : [],
      // A CTA appears at its time, or at once when the footage can't play.
      ctas: cur.ctas.filter((c) => settled || s.time >= c.appearsAtSeconds),
      canSkip: s.status === "running" && !cur.choice,
      canBack: s.history.length > 0 && s.status !== "intro",
      timeout: cur.choice?.timeout && s.timer === "running" ? { ...cur.choice.timeout, label: cur.choice.branches.find((b) => b.id === cur.choice!.timeout!.defaultBranchId)!.label } : null,
    };
  };

  return { initial, reduce, view, scene };
}

export type Controller = ReturnType<typeof createController>;
