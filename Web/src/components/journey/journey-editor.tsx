"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState, useTransition } from "react";
import { approveJourneyAction, saveJourneyAction } from "@/app/(dashboard)/projects/journey-actions";
import { AspectRatio, CameraMovement, NO_TEXT_NEGATIVE, SCENE_TYPE_LABELS, SceneType, TransitionStyle, type JourneyContent, type Scene, type TransitionStyle as TransitionStyleT } from "@/domain/journey";
import { blankScene } from "@/domain/journey-samples";
import { outgoing, sceneOrder, validateJourney } from "@/domain/journey-validate";
import { Check, Field, Pick } from "../content/section-fields";

// The WF-06 storyboard editor. The board lays scenes out by distance from
// the opening (one column per step) with their transitions and branch
// choices; selecting a card opens its production spec. Checks run live with
// the validator the server uses on approval and export.

type Props = {
  projectId: string;
  journeyId: string;
  versionId: string;
  version: number;
  initial: JourneyContent;
  pages: { id: string; title: string; sections: { id: string; label: string }[] }[];
  images: { id: string; label: string }[];
  captures: { referenceId: string; captureId: string; label: string }[];
  desiredActions: string[];
};

const uuid = () => crypto.randomUUID();

export function JourneyEditor({ projectId, journeyId, versionId, version, initial, pages, images, captures, desiredActions }: Props) {
  const router = useRouter();
  const [j, setJ] = useState(initial);
  const [selected, setSelected] = useState<string | null>(initial.startSceneId);
  const [dirty, setDirty] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string; issues?: { path: string; message: string }[] } | null>(null);
  const [pending, start] = useTransition();
  const [addType, setAddType] = useState<string>("information");

  const ctx = useMemo(() => ({ pages: pages.map((p) => ({ id: p.id, title: p.title, sectionIds: p.sections.map((s) => s.id) })), assetIds: new Set(images.map((i) => i.id)), captures: new Set(captures.map((c) => `${c.referenceId}:${c.captureId}`)), desiredActions }), [pages, images, captures, desiredActions]);
  const issues = useMemo(() => validateJourney(j, ctx), [j, ctx]);
  const { order, depth, reachable } = useMemo(() => sceneOrder(j), [j]);
  const errorsFor = (sceneId: string) => issues.filter((i) => i.sceneId === sceneId && i.level === "error").length;
  const err = (path: string) => issues.find((i) => i.path === path && i.level === "error")?.message;
  const edit = (fn: (d: JourneyContent) => void) => {
    setJ((prev) => {
      const next = structuredClone(prev);
      fn(next);
      return next;
    });
    setDirty(true);
  };
  const editScene = (id: string, fn: (s: Scene) => void) => edit((d) => fn(d.scenes.find((s) => s.id === id)!));
  const title = (id: string) => {
    const s = j.scenes.find((x) => x.id === id);
    return s ? s.title || SCENE_TYPE_LABELS[s.type] : "(missing scene)";
  };
  const run = (fn: () => Promise<{ ok: true; data: unknown } | { ok: false; message: string; issues: { path: string; message: string }[] }>, ok: string) =>
    start(async () => {
      const r = await fn();
      if (r.ok) {
        setDirty(false);
        setMsg({ ok: true, text: ok });
        router.refresh();
      } else setMsg({ ok: false, text: r.message, issues: r.issues });
    });

  // Board columns: one per step from the opening; unconnected scenes last.
  const columns = useMemo(() => {
    const cols: Scene[][] = [];
    for (const s of order) {
      if (!reachable.has(s.id)) continue;
      const d = depth.get(s.id)!;
      (cols[d] ??= []).push(s);
    }
    return cols;
  }, [order, depth, reachable]);
  const orphans = order.filter((s) => !reachable.has(s.id));
  const scene = j.scenes.find((s) => s.id === selected) ?? null;
  const sceneOptions = (except: string) => j.scenes.filter((s) => s.id !== except).map((s): [string, string] => [s.id, `${s.title || "Untitled"} (${SCENE_TYPE_LABELS[s.type]})`]);
  const errorCount = issues.filter((i) => i.level === "error").length;

  return (
    <div>
      {msg && (
        <div className={`alert ${msg.ok ? "success" : "error"}`} role={msg.ok ? "status" : "alert"}>
          {msg.text}
          {!msg.ok && msg.issues && (
            <ul>
              {msg.issues.slice(0, 12).map((i, n) => (
                <li key={n}>{i.message}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      <section className="card" aria-labelledby="board-heading">
        <div className="actions" style={{ justifyContent: "space-between" }}>
          <h2 id="board-heading" style={{ margin: 0 }}>
            Storyboard
          </h2>
          <div className="actions" style={{ alignItems: "end" }}>
            <Pick label="New scene type" value={addType} options={SceneType.options.map((t): [string, string] => [t, SCENE_TYPE_LABELS[t]])} onChange={setAddType} />
            <button
              type="button"
              className="button"
              style={{ marginBottom: "1rem" }}
              onClick={() => {
                const s = blankScene(addType as Scene["type"], j.format.aspectRatio, `New ${SCENE_TYPE_LABELS[addType as Scene["type"]].toLowerCase()}`);
                edit((d) => {
                  d.scenes.push(s);
                  if (!d.startSceneId && s.type === "opening") d.startSceneId = s.id;
                });
                setSelected(s.id);
              }}
            >
              Add scene
            </button>
          </div>
        </div>
        <div role="list" aria-label="Scenes by step from the opening" style={{ display: "grid", gridAutoFlow: "column", gridAutoColumns: "minmax(200px, 1fr)", gap: "0.75rem", overflowX: "auto", paddingBottom: "0.5rem" }}>
          {columns.map((col, i) => (
            <div key={i} role="listitem" aria-label={`Step ${i + 1}`} className="stack">
              <span className="small muted">Step {i + 1}</span>
              {col.map((s) => (
                <SceneCard key={s.id} s={s} projectId={projectId} selected={selected === s.id} isStart={j.startSceneId === s.id} errors={errorsFor(s.id)} title={title} onSelect={setSelected} />
              ))}
            </div>
          ))}
          {orphans.length > 0 && (
            <div role="listitem" aria-label="Not connected" className="stack">
              <span className="small" style={{ color: "var(--color-danger)" }}>
                Not connected
              </span>
              {orphans.map((s) => (
                <SceneCard key={s.id} s={s} projectId={projectId} selected={selected === s.id} isStart={j.startSceneId === s.id} errors={errorsFor(s.id)} title={title} onSelect={setSelected} />
              ))}
            </div>
          )}
        </div>
        <p className="small muted">{j.scenes.length} scenes, {j.scenes.reduce((n, s) => n + s.durationSeconds, 0)}s of footage in all (a visitor sees one path through it); target runtime {j.format.targetRuntimeSeconds}s.</p>
      </section>

      <div className="grid grid-main-side" style={{ marginTop: "1rem" }}>
        <div className="stack">
          {scene ? (
            <section className="card" aria-labelledby="scene-heading">
              <div className="actions" style={{ justifyContent: "space-between" }}>
                <h2 id="scene-heading" style={{ margin: 0 }}>
                  Scene: {scene.title || "Untitled"}
                </h2>
                <div className="actions">
                  {j.startSceneId !== scene.id && (
                    <button type="button" className="button" onClick={() => edit((d) => void (d.startSceneId = scene.id))}>
                      Make start scene
                    </button>
                  )}
                  <button
                    type="button"
                    className="button link danger small"
                    onClick={() => {
                      edit((d) => {
                        d.scenes = d.scenes.filter((s) => s.id !== scene.id);
                        if (d.startSceneId === scene.id) d.startSceneId = null;
                      });
                      setSelected(null);
                    }}
                  >
                    Delete scene
                  </button>
                </div>
              </div>
              <p className="small muted">
                id <code>{scene.id}</code>
              </p>
              <div className="two-col">
                <Field label="Title" required value={scene.title} onChange={(v) => editScene(scene.id, (s) => void (s.title = v))} error={err(`scenes.${scene.id}.title`)} />
                <Pick
                  label="Scene type"
                  value={scene.type}
                  options={SceneType.options.map((t): [string, string] => [t, SCENE_TYPE_LABELS[t]])}
                  onChange={(v) =>
                    editScene(scene.id, (s) => {
                      s.type = v as Scene["type"];
                      if (s.type === "decision") s.next = null;
                      else s.branches = [];
                      if (s.type === "ending") s.next = null;
                    })
                  }
                />
              </div>
              <Field label="Narrative purpose" required multiline value={scene.purpose} onChange={(v) => editScene(scene.id, (s) => void (s.purpose = v))} error={err(`scenes.${scene.id}.purpose`)} />
              <div className="two-col">
                <Field label="Duration (seconds)" value={String(scene.durationSeconds)} onChange={(v) => editScene(scene.id, (s) => void (s.durationSeconds = Number(v) || 0))} />
                <Pick label="Aspect ratio" value={scene.aspectRatio} options={AspectRatio.options.map((a): [string, string] => [a, a])} onChange={(v) => editScene(scene.id, (s) => void (s.aspectRatio = v as Scene["aspectRatio"]))} />
              </div>

              <h3>Visual</h3>
              <Field label="Visual description" required multiline value={scene.visual.description} onChange={(v) => editScene(scene.id, (s) => void (s.visual.description = v))} error={err(`scenes.${scene.id}.visual.description`)} />
              <div className="two-col">
                {(["subject", "environment", "lighting", "mood"] as const).map((k) => (
                  <Field key={k} label={k[0].toUpperCase() + k.slice(1)} required value={scene.visual[k]} onChange={(v) => editScene(scene.id, (s) => void (s.visual[k] = v))} error={err(`scenes.${scene.id}.visual.${k}`)} />
                ))}
                <Pick label="Camera movement" value={scene.visual.camera} options={CameraMovement.options.map((c): [string, string] => [c, c.replace("_", " ")])} onChange={(v) => editScene(scene.id, (s) => void (s.visual.camera = v as Scene["visual"]["camera"]))} />
                <Field label="Camera notes" value={scene.visual.cameraNotes} onChange={(v) => editScene(scene.id, (s) => void (s.visual.cameraNotes = v))} />
              </div>
              <Field label="Visual notes" multiline value={scene.visualNotes} onChange={(v) => editScene(scene.id, (s) => void (s.visualNotes = v))} />

              <h3>Continuity</h3>
              <Field label="Must stay consistent with" multiline value={scene.continuity.notes} onChange={(v) => editScene(scene.id, (s) => void (s.continuity.notes = v))} />
              {j.scenes
                .filter((s) => s.id !== scene.id)
                .map((s) => (
                  <Check
                    key={s.id}
                    label={`Matches ${s.title || "Untitled"}`}
                    checked={scene.continuity.matchesSceneIds.includes(s.id)}
                    onChange={(on) => editScene(scene.id, (x) => void (x.continuity.matchesSceneIds = on ? [...x.continuity.matchesSceneIds, s.id] : x.continuity.matchesSceneIds.filter((m) => m !== s.id)))}
                  />
                ))}

              <h3>Keyframes</h3>
              {scene.keyframes.map((k, i) => (
                <div key={k.id} style={{ borderLeft: "3px solid var(--color-border)", paddingLeft: "0.75rem", marginBottom: "0.5rem" }}>
                  <div className="two-col">
                    <Field label={`Keyframe ${i + 1} label`} value={k.label} onChange={(v) => editScene(scene.id, (s) => void (s.keyframes[i].label = v))} />
                    <Pick label="Position" value={k.position} options={[["start", "Start"], ["middle", "Middle"], ["end", "End"]]} onChange={(v) => editScene(scene.id, (s) => void (s.keyframes[i].position = v as "start"))} />
                  </div>
                  <Pick
                    label="Reference image"
                    value={!k.ref ? "" : k.ref.kind === "asset" ? `a:${k.ref.assetId}` : k.ref.kind === "reference_capture" ? `c:${k.ref.referenceId}:${k.ref.captureId}` : "url"}
                    options={[["", "None yet"], ...images.map((im): [string, string] => [`a:${im.id}`, `Register: ${im.label}`]), ...captures.map((c): [string, string] => [`c:${c.referenceId}:${c.captureId}`, `WF-02 capture: ${c.label}`]), ["url", "External https URL"]]}
                    onChange={(v) =>
                      editScene(scene.id, (s) => {
                        const [kind, a, b] = v.split(":");
                        s.keyframes[i].ref = !v ? null : kind === "a" ? { kind: "asset", assetId: a } : kind === "c" ? { kind: "reference_capture", referenceId: a, captureId: b } : { kind: "url", url: "https://" };
                      })
                    }
                  />
                  {k.ref?.kind === "url" && <Field label="Image URL" value={k.ref.url} onChange={(v) => editScene(scene.id, (s) => void (s.keyframes[i].ref = { kind: "url", url: v }))} />}
                  <Field label="Notes" value={k.notes} onChange={(v) => editScene(scene.id, (s) => void (s.keyframes[i].notes = v))} />
                  <button type="button" className="button link danger small" onClick={() => editScene(scene.id, (s) => void s.keyframes.splice(i, 1))}>
                    Remove keyframe {i + 1}
                  </button>
                </div>
              ))}
              <button type="button" className="button" onClick={() => editScene(scene.id, (s) => void s.keyframes.push({ id: uuid(), label: "", position: "middle", ref: null, notes: "" }))}>
                Add keyframe
              </button>

              <h3 style={{ marginTop: "1rem" }}>Generation prompt</h3>
              <Field label="Prompt" required multiline value={scene.prompt.positive} onChange={(v) => editScene(scene.id, (s) => void (s.prompt.positive = v))} error={err(`scenes.${scene.id}.prompt.positive`)} hint="Describe the shot only. Interface text, captions and CTAs are overlaid by the site, never generated." />
              <Field label="Negative prompt" multiline value={scene.prompt.negative} onChange={(v) => editScene(scene.id, (s) => void (s.prompt.negative = v))} hint={scene.prompt.negative.includes(NO_TEXT_NEGATIVE) ? undefined : "The no-on-screen-text instruction is added to every export regardless."} />

              <h3>Asset slots</h3>
              {err(`scenes.${scene.id}.assetSlots`) && <p className="field-error">{err(`scenes.${scene.id}.assetSlots`)}</p>}
              {scene.assetSlots.map((a, i) => (
                <div key={a.id} className="two-col" style={{ borderLeft: "3px solid var(--color-border)", paddingLeft: "0.75rem", marginBottom: "0.5rem" }}>
                  <Field label={`Slot ${i + 1} label`} value={a.label} onChange={(v) => editScene(scene.id, (s) => void (s.assetSlots[i].label = v))} />
                  <Pick label="Kind" value={a.kind} options={[["video", "Video"], ["loop", "Loop"], ["still", "Still"], ["audio", "Audio"]]} onChange={(v) => editScene(scene.id, (s) => void (s.assetSlots[i].kind = v as "video"))} />
                  <Check label="Required" checked={a.required} onChange={(v) => editScene(scene.id, (s) => void (s.assetSlots[i].required = v))} />
                  <button type="button" className="button link danger small" onClick={() => editScene(scene.id, (s) => void s.assetSlots.splice(i, 1))}>
                    Remove slot {i + 1}
                  </button>
                </div>
              ))}
              <button type="button" className="button" onClick={() => editScene(scene.id, (s) => void s.assetSlots.push({ id: uuid(), kind: "video", label: "", durationSeconds: null, required: true }))}>
                Add asset slot
              </button>

              <h3 style={{ marginTop: "1rem" }}>What happens next</h3>
              {err(`scenes.${scene.id}.next`) && <p className="field-error">{err(`scenes.${scene.id}.next`)}</p>}
              {issues.filter((i) => i.path === `scenes.${scene.id}.transitions` && i.level === "error").map((i, n) => <p key={n} className="field-error">{i.message}</p>)}
              {scene.type === "ending" && <p className="small muted">An ending hands the visitor back to the website.</p>}
              {scene.type !== "ending" && scene.type !== "decision" && (
                <div className="two-col">
                  <Pick label="Next scene" value={scene.next?.to ?? ""} options={[["", "None"], ...sceneOptions(scene.id)]} onChange={(v) => editScene(scene.id, (s) => void (s.next = v ? { id: s.next?.id ?? uuid(), to: v, style: s.next?.style ?? "crossfade", durationMs: s.next?.durationMs ?? 600 } : null))} />
                  {scene.next && <Pick label="Transition" value={scene.next.style} options={TransitionStyle.options.map((t): [string, string] => [t, t.replace(/_/g, " ")])} onChange={(v) => editScene(scene.id, (s) => void (s.next!.style = v as TransitionStyleT))} />}
                </div>
              )}
              {scene.type === "decision" && (
                <>
                  {err(`scenes.${scene.id}.branches`) && <p className="field-error">{err(`scenes.${scene.id}.branches`)}</p>}
                  {scene.branches.map((b, i) => (
                    <div key={b.id} className="two-col" style={{ borderLeft: "3px solid var(--color-border)", paddingLeft: "0.75rem", marginBottom: "0.5rem" }}>
                      <Field label={`Choice ${i + 1} label (shown as a button, not in footage)`} value={b.label} onChange={(v) => editScene(scene.id, (s) => void (s.branches[i].label = v))} error={err(`scenes.${scene.id}.branches.${i}.label`)} />
                      <Pick label={`Choice ${i + 1} leads to`} value={b.to} options={[...(j.scenes.some((s) => s.id === b.to) ? [] : [[b.to, "(missing scene)"] as [string, string]]), ...sceneOptions(scene.id)]} onChange={(v) => editScene(scene.id, (s) => void (s.branches[i].to = v))} />
                      <button type="button" className="button link danger small" onClick={() => editScene(scene.id, (s) => void s.branches.splice(i, 1))}>
                        Remove choice {i + 1}
                      </button>
                    </div>
                  ))}
                  <button type="button" className="button" onClick={() => editScene(scene.id, (s) => void s.branches.push({ id: uuid(), label: "", to: j.scenes.find((x) => x.id !== s.id)?.id ?? s.id, style: "crossfade", durationMs: 600 }))}>
                    Add choice
                  </button>
                  <Check
                    label="Choose for the visitor if they do nothing"
                    checked={scene.decisionTimeout !== null}
                    onChange={(on) => editScene(scene.id, (s) => void (s.decisionTimeout = on && s.branches[0] ? { seconds: 20, defaultBranchId: s.branches[0].id } : null))}
                  />
                </>
              )}

              <h3 style={{ marginTop: "1rem" }}>Calls to action (overlaid, not in footage)</h3>
              {err(`scenes.${scene.id}.ctas`) && <p className="field-error">{err(`scenes.${scene.id}.ctas`)}</p>}
              {scene.ctas.map((c, i) => (
                <div key={c.id} style={{ borderLeft: "3px solid var(--color-border)", paddingLeft: "0.75rem", marginBottom: "0.5rem" }}>
                  <div className="two-col">
                    <Field label={`CTA ${i + 1} label`} value={c.label} onChange={(v) => editScene(scene.id, (s) => void (s.ctas[i].label = v))} error={err(`scenes.${scene.id}.ctas.${i}.label`)} />
                    <Pick label="Desired action" value={c.actionKind ?? ""} options={[["", "None"], ...desiredActions.map((a): [string, string] => [a, a])]} onChange={(v) => editScene(scene.id, (s) => void (s.ctas[i].actionKind = v || null))} />
                    <Pick
                      label="Goes to"
                      value={c.target.kind === "url" ? "url" : c.target.kind === "section" ? `${c.target.pageId}#${c.target.sectionId}` : c.target.pageId}
                      options={[...pages.flatMap((p): [string, string][] => [[p.id, `Page: ${p.title}`], ...p.sections.map((s): [string, string] => [`${p.id}#${s.id}`, `  ${p.title} › ${s.label}`])]), ["url", "External link"]]}
                      onChange={(v) =>
                        editScene(scene.id, (s) => {
                          if (v === "url") s.ctas[i].target = { kind: "url", url: "https://" };
                          else if (v.includes("#")) {
                            const [pageId, sectionId] = v.split("#");
                            s.ctas[i].target = { kind: "section", pageId, sectionId };
                          } else s.ctas[i].target = { kind: "page", pageId: v };
                        })
                      }
                    />
                    <Pick label="Placement" value={c.placement} options={[["overlay", "Overlay"], ["end_card", "End card"], ["beside", "Beside the video"]]} onChange={(v) => editScene(scene.id, (s) => void (s.ctas[i].placement = v as "overlay"))} />
                  </div>
                  {c.target.kind === "url" && <Field label="Link" value={c.target.url} onChange={(v) => editScene(scene.id, (s) => void (s.ctas[i].target = { kind: "url", url: v }))} />}
                  <button type="button" className="button link danger small" onClick={() => editScene(scene.id, (s) => void s.ctas.splice(i, 1))}>
                    Remove CTA {i + 1}
                  </button>
                </div>
              ))}
              <button
                type="button"
                className="button"
                onClick={() => editScene(scene.id, (s) => void s.ctas.push({ id: uuid(), label: "", actionKind: desiredActions[0] ?? null, target: pages[0] ? { kind: "page", pageId: pages[0].id } : { kind: "url", url: "https://" }, placement: "end_card", appearsAtSeconds: Math.max(0, s.durationSeconds - 4) }))}
              >
                Add CTA
              </button>
            </section>
          ) : (
            <section className="card">
              <p className="muted">Select a scene on the storyboard to edit it.</p>
            </section>
          )}

          <section className="card" aria-labelledby="goals-heading">
            <h2 id="goals-heading">Goals and format</h2>
            <Field label="Objective" required multiline value={j.goals.objective} onChange={(v) => edit((d) => void (d.goals.objective = v))} error={err("goals.objective")} />
            <Field label="Target audience" required value={j.goals.audience} onChange={(v) => edit((d) => void (d.goals.audience = v))} error={err("goals.audience")} />
            <Pick
              label="Entry point"
              value={j.goals.entryPoint.kind === "standalone" ? "" : j.goals.entryPoint.kind === "page" ? j.goals.entryPoint.pageId : `${j.goals.entryPoint.pageId}#${j.goals.entryPoint.sectionId}`}
              options={[["", "Standalone (its own URL)"], ...pages.flatMap((p): [string, string][] => [[p.id, `From page: ${p.title}`], ...p.sections.map((s): [string, string] => [`${p.id}#${s.id}`, `  ${p.title} › ${s.label}`])])]}
              onChange={(v) =>
                edit((d) => {
                  if (!v) d.goals.entryPoint = { kind: "standalone" };
                  else if (v.includes("#")) {
                    const [pageId, sectionId] = v.split("#");
                    d.goals.entryPoint = { kind: "page_section", pageId, sectionId };
                  } else d.goals.entryPoint = { kind: "page", pageId: v };
                })
              }
            />
            {err("goals.entryPoint") && <p className="field-error">{err("goals.entryPoint")}</p>}
            <span className="label">Intended actions</span>
            {desiredActions.length === 0 && <p className="small muted">The approved brief lists no desired actions.</p>}
            {desiredActions.map((a) => (
              <Check key={a} label={a} checked={j.goals.intendedActions.includes(a)} onChange={(on) => edit((d) => void (d.goals.intendedActions = on ? [...d.goals.intendedActions, a] : d.goals.intendedActions.filter((x) => x !== a)))} />
            ))}
            <span className="label">Success criteria</span>
            {err("goals.successCriteria") && <p className="field-error">{err("goals.successCriteria")}</p>}
            {j.goals.successCriteria.map((c, i) => (
              <div key={c.id} className="two-col">
                <Field label={`Metric ${i + 1}`} value={c.metric} onChange={(v) => edit((d) => void (d.goals.successCriteria[i].metric = v))} />
                <Field label="Target" value={c.target} onChange={(v) => edit((d) => void (d.goals.successCriteria[i].target = v))} />
              </div>
            ))}
            <button type="button" className="button" onClick={() => edit((d) => void d.goals.successCriteria.push({ id: uuid(), metric: "", target: "" }))}>
              Add success criterion
            </button>
            <div className="two-col" style={{ marginTop: "1rem" }}>
              <Pick label="Aspect ratio" value={j.format.aspectRatio} options={AspectRatio.options.map((a): [string, string] => [a, a])} onChange={(v) => edit((d) => void (d.format.aspectRatio = v as Scene["aspectRatio"]))} />
              <Field label="Target runtime (seconds)" value={String(j.format.targetRuntimeSeconds)} onChange={(v) => edit((d) => void (d.format.targetRuntimeSeconds = Math.round(Number(v)) || 0))} />
            </div>
          </section>
        </div>

        <aside className="stack sticky-side" aria-label="Checks">
          <section className="card">
            <h2>Checks</h2>
            {issues.length === 0 ? (
              <p className="small">Structurally valid and ready for production.</p>
            ) : (
              <>
                <p className="small">{errorCount} item(s) block approval.</p>
                <ul className="small">
                  {issues.map((i, n) => (
                    <li key={n} style={{ color: i.level === "error" ? "var(--color-danger)" : undefined }}>
                      {i.level === "warning" && "Warning: "}
                      {i.message}
                    </li>
                  ))}
                </ul>
              </>
            )}
          </section>
        </aside>
      </div>

      <div className="save-bar">
        <span className="save-status" role="status" aria-live="polite">
          {pending ? "Working…" : dirty ? "Unsaved changes" : `Version ${version} draft saved`}
        </span>
        <div className="actions">
          <button type="button" className="button" disabled={pending || !dirty} onClick={() => run(() => saveJourneyAction(projectId, journeyId, versionId, j), "Saved.")}>
            Save draft
          </button>
          <button type="button" className="button primary" disabled={pending} onClick={() => run(() => approveJourneyAction(projectId, journeyId, versionId, j), `Version ${version} approved.`)}>
            Approve version {version}
          </button>
        </div>
      </div>
    </div>
  );
}

type CardProps = {
  s: Scene;
  projectId: string;
  selected: boolean;
  isStart: boolean;
  errors: number;
  title: (id: string) => string;
  onSelect: (id: string) => void;
};

function SceneCard({ s, projectId, selected, isStart, errors, title, onSelect }: CardProps) {
  return (
    <button
      type="button"
      className="card"
      onClick={() => onSelect(s.id)}
      aria-pressed={selected}
      aria-label={`Scene ${s.title || "Untitled"}, ${SCENE_TYPE_LABELS[s.type]}`}
      data-scene-id={s.id}
      style={{ textAlign: "left", width: "100%", cursor: "pointer", outline: selected ? "2px solid var(--color-accent)" : undefined, font: "inherit", color: "inherit" }}
    >
      <span className="actions" style={{ justifyContent: "space-between" }}>
        <span className={`badge ${s.type === "conversion" ? "ok" : s.type === "decision" ? "warn" : ""}`}>{SCENE_TYPE_LABELS[s.type]}</span>
        <span className="small muted">{s.durationSeconds}s</span>
      </span>
      <strong style={{ display: "block", marginTop: "0.35rem" }}>
        {s.title || "Untitled"}
        {isStart && <span className="muted small"> · start</span>}
      </strong>
      {s.keyframes[0]?.ref?.kind === "asset" && (
        // eslint-disable-next-line @next/next/no-img-element -- keyframe thumbnail from the register
        <img src={`/api/projects/${projectId}/media/${s.keyframes[0].ref.assetId}`} alt="" style={{ width: "100%", borderRadius: 4, marginTop: "0.35rem" }} />
      )}
      <span className="small" style={{ display: "block", marginTop: "0.35rem" }}>
        {outgoing(s).map((o) => (
          <span key={o.id} style={{ display: "block" }}>
            {s.type === "decision" ? `“${o.label || "?"}” → ` : "→ "}
            {title(o.to)}
          </span>
        ))}
        {s.ctas.map((c) => (
          <span key={c.id} style={{ display: "block" }} className="muted">
            CTA: {c.label || "?"}
          </span>
        ))}
      </span>
      {errors > 0 && <span className="badge danger" style={{ marginTop: "0.35rem" }}>{errors} to fix</span>}
    </button>
  );
}
