"use client";

import gsap from "gsap";
import { useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState, useSyncExternalStore, type CSSProperties } from "react";
import type { JourneyBundle } from "./bundle";
import { createController, type State } from "./controller";

// The journey player: renders a validated bundle. Footage plays in <video>;
// everything a visitor reads or acts on - the scene title, choices, CTAs,
// controls, messages - is real HTML over or beside it, never part of the
// footage. GSAP runs the scene transitions and overlay entrances, and is not
// used at all when the visitor prefers reduced motion.
//
// The player knows nothing about providers, projects or the CMS: a second
// project uses it with its own bundle, site root and (optionally) labels.

export const DEFAULT_LABELS = {
  start: "Start the journey",
  resume: "Resume where you left off",
  skipFilm: "Skip the film",
  play: "Play",
  pause: "Pause",
  mute: "Mute sound",
  unmute: "Turn sound on",
  back: "Previous scene",
  skip: "Next scene",
  restart: "Watch again",
  leave: "Leave the journey",
  retry: "Try again",
  failed: "This scene couldn't play. You can try again, carry on, or continue on the website.",
  loading: "Loading…",
  slow: "This is taking a while. You can wait, or go to the next scene.",
  blocked: "Your browser paused the film. Press Play to continue.",
  finished: "The end of the journey.",
  stopTimer: "Wait, I'll choose",
  continuing: (label: string, s: number) => `Continuing with “${label}” in ${s} s.`,
  sceneOf: (n: number, title: string) => `Scene ${n}: ${title}`,
  continueTo: (label: string) => `Continue to ${label}`,
  path: "Your path so far",
  reducedNote: "Reduced motion is on: scenes change without animation, and looping footage stays still until you press Play.",
};
export type Labels = typeof DEFAULT_LABELS;

const MEDIA_ERRORS: Record<number, string> = { 1: "aborted", 2: "network error", 3: "could not be decoded", 4: "format not supported or file not found" };

function useReducedMotion() {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const m = window.matchMedia("(prefers-reduced-motion: reduce)");
    const on = () => setReduced(m.matches);
    on();
    m.addEventListener("change", on);
    return () => m.removeEventListener("change", on);
  }, []);
  return reduced;
}

type Saved = { sceneId: string; history: string[]; visited: string[] };
const readRaw = (key: string): string | null => {
  try {
    return window.sessionStorage.getItem(key);
  } catch {
    return null;
  }
};
const parseSaved = (raw: string | null): Saved | null => {
  try {
    const v = JSON.parse(raw ?? "null");
    return v && typeof v.sceneId === "string" && Array.isArray(v.history) && Array.isArray(v.visited) ? v : null;
  } catch {
    return null;
  }
};
const noSubscribe = () => () => {};
const write = (key: string, v: Saved | null) => {
  try {
    if (v) window.sessionStorage.setItem(key, JSON.stringify(v));
    else window.sessionStorage.removeItem(key);
  } catch {
    /* storage unavailable: progress is simply not kept */
  }
};

export function JourneyPlayer({ bundle, root, labels: custom, debug = false }: { bundle: JourneyBundle; root: string; labels?: Partial<Labels>; debug?: boolean }) {
  const L = { ...DEFAULT_LABELS, ...custom };
  const c = useMemo(() => createController(bundle), [bundle]);
  const [s, dispatch] = useReducer(c.reduce, undefined, c.initial);
  const v = c.view(s);
  const reduced = useReducedMotion();
  const [muted, setMuted] = useState(false);
  const [slowAt, setSlowAt] = useState<string | null>(null);
  const [tick, setTick] = useState<{ key: string; elapsed: number }>({ key: "", elapsed: 0 });
  const videoRef = useRef<HTMLVideoElement>(null);
  const mediaRef = useRef<HTMLDivElement>(null);
  const curtainRef = useRef<HTMLDivElement>(null);
  const uiRef = useRef<HTMLDivElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const storageKey = `scl-journey:${bundle.journey.id}:${bundle.release?.number ?? "preview"}`;
  const href = (h: string) => (h.startsWith("/") ? (h === "/" ? root : `${root}${h}`) : h);
  const scene = v.scene;
  const running = s.status === "running";

  // Progress kept for this tab only (sessionStorage); absent on the server.
  const savedRaw = useSyncExternalStore(noSubscribe, () => readRaw(storageKey), () => null);
  const saved = useMemo(() => parseSaved(savedRaw), [savedRaw]);
  useEffect(() => {
    if (running) write(storageKey, { sceneId: s.sceneId, history: s.history, visited: s.visited });
    if (s.status === "finished" || s.status === "exited") write(storageKey, null);
  }, [running, s.status, s.sceneId, s.history, s.visited, storageKey]);

  // Leaving for a conventional page (a page branch, or Leave).
  useEffect(() => {
    if (s.status === "exited" && s.exitHref) window.location.assign(href(s.exitHref));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.status, s.exitHref]);

  // Start playback whenever a scene's media mounts. A refusal without sound
  // is retried muted; a refusal muted waits for the visitor to press Play.
  const tryPlay = () => {
    const el = videoRef.current;
    if (!el) return;
    el.play().catch(async (e: DOMException) => {
      if (e.name !== "NotAllowedError") return; // AbortError: superseded; media errors arrive as 'error'
      if (!el.muted) {
        el.muted = true;
        setMuted(true);
        try {
          await el.play();
          return;
        } catch {
          /* fall through */
        }
      }
      dispatch({ type: "autoplay_blocked" });
    });
  };
  useEffect(() => {
    if (!running || !scene.video || s.phase !== "loading") return;
    // Reduced motion: ambient loops stay on their first frame until Play.
    if (reduced && scene.loop) {
      dispatch({ type: "pause" });
      return;
    }
    tryPlay();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running, s.sceneId, s.attempt]);

  // Slow-loading notice, for this scene and phase only.
  const waitKey = `${s.sceneId}:${s.phase}:${s.attempt}:${s.visited.length}`;
  const slow = slowAt === waitKey;
  useEffect(() => {
    if (s.phase !== "loading" && s.phase !== "buffering") return;
    const t = window.setTimeout(() => setSlowAt(waitKey), 8000);
    return () => window.clearTimeout(t);
  }, [s.phase, waitKey]);

  // Title cards (no footage) hold for the scene's length, up to 8 s, then move on.
  useEffect(() => {
    if (!running || s.phase !== "still" || scene.choice) return;
    const t = window.setTimeout(() => dispatch({ type: "media_ended" }), Math.min(scene.durationSeconds, 8) * 1000);
    return () => window.clearTimeout(t);
  }, [running, s.phase, s.sceneId, scene]);

  // The decision timeout counts down only while visible, unpaused and not stopped.
  const timerKey = v.timeout && running && s.phase !== "paused" ? `${s.sceneId}:${s.visited.length}:${s.phase === "blocked"}` : null;
  const left = v.timeout && timerKey ? v.timeout.seconds - (tick.key === timerKey ? tick.elapsed : 0) : null;
  useEffect(() => {
    if (!timerKey || !v.timeout) return;
    const total = v.timeout.seconds;
    let elapsed = 0;
    const id = window.setInterval(() => {
      if (document.hidden) return;
      elapsed += 1;
      setTick({ key: timerKey, elapsed });
      if (elapsed >= total) {
        window.clearInterval(id);
        dispatch({ type: "timeout" });
      }
    }, 1000);
    return () => window.clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [timerKey]);

  // Hidden tab: pause, and wait for the visitor to resume.
  useEffect(() => {
    const on = () => {
      if (document.hidden && videoRef.current && !videoRef.current.paused) {
        videoRef.current.pause();
        dispatch({ type: "pause" });
      }
    };
    document.addEventListener("visibilitychange", on);
    return () => document.removeEventListener("visibilitychange", on);
  }, []);

  // Transitions and overlay entrances. Skipped entirely for reduced motion.
  useLayoutEffect(() => {
    if (reduced || !running) return;
    const ctx = gsap.context(() => {
      const t = s.transition;
      const d = t ? Math.max(0.15, t.durationMs / 1000) : 0.5;
      if (t?.style === "crossfade" || t?.style === "continuous") gsap.fromTo(mediaRef.current, { autoAlpha: 0 }, { autoAlpha: 1, duration: d, ease: "power1.out" });
      if (t?.style === "fade_to_black") gsap.fromTo(curtainRef.current, { autoAlpha: 1 }, { autoAlpha: 0, duration: d, ease: "power1.inOut" });
      if (t?.style === "whip_pan") gsap.fromTo(mediaRef.current, { xPercent: 8, filter: "blur(8px)" }, { xPercent: 0, filter: "blur(0px)", duration: Math.min(d, 0.4), ease: "power3.out" });
      if (t === null) gsap.fromTo(mediaRef.current, { autoAlpha: 0 }, { autoAlpha: 1, duration: 0.6 });
    });
    return () => ctx.revert();
    // Runs once per scene entry; the transition belongs to that entry.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.sceneId, s.status, s.visited.length, reduced]);
  useLayoutEffect(() => {
    if (reduced || !uiRef.current) return;
    const items = uiRef.current.querySelectorAll("[data-enter]");
    if (!items.length) return;
    const ctx = gsap.context(() => gsap.from(items, { autoAlpha: 0, y: 12, duration: 0.35, stagger: 0.06, ease: "power2.out", clearProps: "all" }));
    return () => ctx.revert();
  }, [s.sceneId, v.choices.length, v.ctas.length, s.status, reduced]);

  // Focus follows the visitor: after a scene change they caused (their
  // button is gone), or if focus would otherwise be lost, move it to the
  // scene heading. Scene changes from playback never steal focus.
  useEffect(() => {
    if (!running && s.status !== "finished") return;
    if (s.cause === "visitor" || document.activeElement === document.body) headingRef.current?.focus({ preventScroll: false });
  }, [s.sceneId, s.status, s.cause, running]);

  const pause = () => {
    videoRef.current?.pause();
    dispatch({ type: "pause" });
  };
  const play = () => {
    dispatch({ type: "play" });
    tryPlay();
  };
  const toggleMute = () => {
    const m = !muted;
    setMuted(m);
    if (videoRef.current) videoRef.current.muted = m;
  };

  const status =
    s.phase === "failed" ? L.failed : s.phase === "blocked" ? L.blocked : s.phase === "loading" || s.phase === "buffering" ? (slow ? L.slow : L.loading) : s.status === "finished" ? L.finished : "";
  const posterSrc = scene.poster?.src;
  const style = { "--scl-journey-ratio": bundle.aspectRatio.replace(":", " / ") } as CSSProperties;

  return (
    <section
      className="scl-journey"
      style={style}
      aria-labelledby="scl-journey-heading"
      data-scl-journey-id={bundle.journey.id}
      data-scl-release={bundle.release?.number ?? "preview"}
      data-motion={reduced ? "reduced" : "full"}
      data-status={s.status}
      data-phase={s.phase}
      data-scene-id={s.status === "intro" ? undefined : s.sceneId}
    >
      <div className="scl-journey-frame">
        <div className="scl-journey-stage">
          <div className="scl-journey-media" ref={mediaRef}>
            {running && scene.video && s.phase !== "failed" ? (
              <video
                key={`${s.sceneId}:${s.attempt}`}
                ref={videoRef}
                src={scene.video.src}
                poster={posterSrc}
                playsInline
                preload="auto"
                muted={muted}
                loop={scene.loop && !reduced}
                aria-hidden="true"
                tabIndex={-1}
                onPlaying={() => dispatch({ type: "media_playing" })}
                onWaiting={() => dispatch({ type: "media_waiting" })}
                onTimeUpdate={(e) => dispatch({ type: "media_time", seconds: e.currentTarget.currentTime })}
                onEnded={() => dispatch({ type: "media_ended" })}
                onPause={(e) => !e.currentTarget.ended && s.phase === "playing" && dispatch({ type: "pause" })}
                onError={(e) => dispatch({ type: "media_error", message: MEDIA_ERRORS[e.currentTarget.error?.code ?? 0] ?? "unknown error" })}
              />
            ) : (
              // Title card: the poster if there is one, otherwise the brand.
              <div className="scl-journey-card">
                {posterSrc && (
                  // eslint-disable-next-line @next/next/no-img-element -- approved still from the bundle
                  <img src={posterSrc} alt="" />
                )}
              </div>
            )}
          </div>
          <div className="scl-journey-curtain" ref={curtainRef} aria-hidden="true" />
        </div>

        <div className="scl-journey-ui" ref={uiRef}>
          {s.status === "intro" ? (
            <div className="scl-journey-intro">
              <h2 className="scl-h2 scl-journey-title" id="scl-journey-heading">
                {bundle.journey.name}
              </h2>
              {reduced && <p className="scl-journey-note">{L.reducedNote}</p>}
              <div className="scl-ctas">
                <button type="button" className="scl-button scl-button--primary" onClick={() => dispatch({ type: "start" })}>
                  {L.start}
                </button>
                {saved && (
                  <button type="button" className="scl-button scl-button--secondary" onClick={() => dispatch({ type: "resume_saved", ...saved })}>
                    {L.resume}
                  </button>
                )}
                <a className="scl-button scl-button--secondary" href={href(bundle.exit.href)}>
                  {L.skipFilm}: {L.continueTo(bundle.exit.label)}
                </a>
              </div>
            </div>
          ) : (
            <>
              <h2 className="scl-h2 scl-journey-title" id="scl-journey-heading" ref={headingRef} tabIndex={-1}>
                <span className="scl-visually-hidden">{L.sceneOf(s.visited.length, "")}</span>
                {scene.title}
              </h2>
              {(s.phase === "blocked" || slow) && (
                <p className="scl-journey-note" data-enter>
                  {status}
                </p>
              )}
              {s.phase === "failed" && (
                <div className="scl-journey-alert" role="alert" data-enter>
                  <p>{L.failed}</p>
                  {debug && s.error && <p className="scl-journey-note">Media: {s.error}</p>}
                  <button type="button" className="scl-button scl-button--secondary" onClick={() => dispatch({ type: "retry" })}>
                    {L.retry}
                  </button>
                </div>
              )}
              {debug && scene.unavailableReason && <p className="scl-journey-note">Preview: {scene.unavailableReason}</p>}
              {v.choices.length > 0 && (
                <div className="scl-journey-choices" role="group" aria-labelledby="scl-journey-choice-heading" data-enter>
                  <p id="scl-journey-choice-heading" className="scl-visually-hidden">
                    {scene.choice!.heading}
                  </p>
                  {v.choices.map((b) => (
                    <button key={b.id} type="button" className="scl-button scl-button--primary" data-scl-branch-id={b.id} onClick={() => dispatch({ type: "choose", branchId: b.id })}>
                      {b.label}
                    </button>
                  ))}
                </div>
              )}
              {v.timeout && left !== null && left > 0 && (
                <p className="scl-journey-note" data-enter>
                  {L.continuing(v.timeout.label, left)}{" "}
                  <button type="button" className="scl-journey-link" onClick={() => dispatch({ type: "stop_timer" })}>
                    {L.stopTimer}
                  </button>
                </p>
              )}
              {v.ctas.length > 0 && (
                <div className="scl-ctas" data-enter>
                  {v.ctas.map((cta) => (
                    <a key={cta.id} className="scl-button scl-button--primary" href={href(cta.href)} data-scl-cta-id={cta.id} data-scl-action={cta.actionKind ?? undefined}>
                      {cta.label}
                    </a>
                  ))}
                </div>
              )}
              {s.status === "finished" && (
                <div className="scl-ctas" data-enter>
                  <a className="scl-button scl-button--primary" href={href(bundle.exit.href)}>
                    {L.continueTo(bundle.exit.label)}
                  </a>
                  <button type="button" className="scl-button scl-button--secondary" onClick={() => dispatch({ type: "restart" })}>
                    {L.restart}
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {s.status !== "intro" && (
        <div className="scl-journey-controls" role="group" aria-label="Journey controls">
          <button type="button" onClick={() => dispatch({ type: "back" })} disabled={!v.canBack}>
            {L.back}
          </button>
          {scene.video && running && s.phase !== "failed" && s.phase !== "ended" && (
            s.phase === "paused" || s.phase === "blocked" ? (
              <button type="button" onClick={play}>
                {L.play}
              </button>
            ) : (
              <button type="button" onClick={pause}>
                {L.pause}
              </button>
            )
          )}
          {scene.video && running && (
            <button type="button" onClick={toggleMute} aria-pressed={muted}>
              {muted ? L.unmute : L.mute}
            </button>
          )}
          {v.canSkip && (
            <button type="button" onClick={() => dispatch({ type: "skip" })}>
              {L.skip}
            </button>
          )}
          <button type="button" onClick={() => dispatch({ type: "restart" })}>
            {L.restart}
          </button>
          <a href={href(bundle.exit.href)}>{L.leave}</a>
        </div>
      )}
      <p className="scl-visually-hidden" aria-live="polite">
        {running || s.status === "finished" ? `${L.sceneOf(s.visited.length, scene.title)}. ${status}` : ""}
      </p>
      {s.visited.length > 0 && (
        <ol className="scl-journey-path" aria-label={L.path}>
          {s.visited.map((id, i) => (
            <li key={`${id}:${i}`} aria-current={i === s.visited.length - 1 ? "step" : undefined}>
              {c.scene(id).title}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

export type { State };
