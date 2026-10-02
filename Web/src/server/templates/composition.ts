import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { composeTemplate } from "../../../scripts/template-compose.mjs";
import { StoreError } from "@/server/store/errors";
import { compositionFile, pageIds, readPage, skeletonFile, writeComposition, writeText, type Composition, type Region } from "./model";

// Turns a generated layout into Web's editable composition.
//
// The generated layout places sections with {{@section <id>}} placeholders.
// Placeholders separated only by whitespace are siblings inside one wrapper
// element: that run is a region. The skeleton is the layout with each run
// replaced by {{@region rN}}; the composition lists each region's sections.
// Nothing else in the layout changes, so wrappers and DOM order are kept.

const SECTION = /\{\{@section\s+([^}\s]+)\s*\}\}/g;
const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);

/** The element a position in the layout is inside of, e.g. "main" or "div.content". */
function parentLabel(html: string, offset: number): string {
  const stack: string[] = [];
  for (const m of html.slice(0, offset).matchAll(/<(\/?)([A-Za-z][\w-]*)([^>]*)>/g)) {
    const tag = m[2].toLowerCase();
    if (m[1]) {
      for (let k = stack.length - 1; k >= 0; k--) {
        if (stack[k].split(/[.#]/)[0] === tag) {
          stack.length = k;
          break;
        }
      }
    } else if (!VOID.has(tag) && !m[3].trim().endsWith("/")) {
      const id = /\sid="([^"]+)"/.exec(m[3])?.[1];
      const cls = /\sclass="([^"]+)"/.exec(m[3])?.[1]?.trim().split(/\s+/)[0];
      stack.push(tag + (id && !id.includes("{{") ? `#${id}` : cls && !cls.includes("{{") ? `.${cls}` : ""));
    }
  }
  return stack.at(-1) ?? "document";
}

export function compositionFromLayout(pageId: string, layout: string): { skeleton: string; composition: Composition } {
  const matches = [...layout.matchAll(SECTION)];
  const runs: { start: number; end: number; ids: string[]; gaps: string[] }[] = [];
  for (const m of matches) {
    const start = m.index!;
    const last = runs.at(-1);
    const gap = last ? layout.slice(last.end, start) : null;
    if (last && gap !== null && /^\s*$/.test(gap)) {
      last.gaps.push(gap);
      last.ids.push(m[1]);
      last.end = start + m[0].length;
    } else runs.push({ start, end: start + m[0].length, ids: [m[1]], gaps: [] });
  }
  const regions: Record<string, Region> = {};
  let skeleton = "";
  let at = 0;
  runs.forEach((run, i) => {
    const id = `r${i + 1}`;
    // Positional gaps keep the generated whitespace exactly; joiner is used beyond them.
    regions[id] = { parent: parentLabel(layout, run.start), joiner: run.gaps[0] ?? "", ...(run.gaps.some((g) => g !== run.gaps[0]) ? { gaps: run.gaps } : {}), items: run.ids.map((section) => ({ section })) };
    skeleton += layout.slice(at, run.start) + `{{@region ${id}}}`;
    at = run.end;
  });
  skeleton += layout.slice(at);
  return { skeleton, composition: { version: 1, page: pageId, regions, removed: [] } };
}

/** Creates the composition of every page that has none yet. */
export function initCompositions(t: string): string[] {
  const created: string[] = [];
  for (const id of pageIds(t)) {
    if (existsSync(compositionFile(t, id))) continue;
    const page = readPage(t, id);
    const layoutPath = join(t, page.layout ?? "");
    if (!page.layout || !existsSync(layoutPath)) continue;
    const { skeleton, composition } = compositionFromLayout(id, readFileSync(layoutPath, "utf8"));
    if (!Object.keys(composition.regions).length) continue;
    writeText(skeletonFile(t, id), skeleton);
    writeComposition(t, composition);
    created.push(id);
  }
  return created;
}

/** Writes layouts/ from the compositions (the same script the exported template ships). */
export function compose(t: string) {
  try {
    return composeTemplate(t);
  } catch (e) {
    throw new StoreError("conflict", `The page composition is invalid: ${(e as Error).message}`);
  }
}
