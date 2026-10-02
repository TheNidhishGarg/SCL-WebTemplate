import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import postcss, { type Declaration, type Node as CssNode } from "postcss";
import { StoreError } from "@/server/store/errors";
import { listFiles, readJson, writeJson } from "./model";

// Design tokens with declaration-level provenance.
//
// The generated stylesheets use var(--sar-color-x) / var(--sar-font-x)
// wherever the captured CSS had that colour or font. Web:
//  - adds the original value as each var()'s fallback, so a stylesheet still
//    renders as captured if a token is removed from the configuration;
//  - records every declaration that uses a token (file, selector, property,
//    the captured declaration it came from) in tokens/token-map.json;
//  - lets each declaration be detached from its token (back to its captured
//    value) or given an explicit value, without touching any other use of the
//    same colour. Nothing is replaced globally by Web.
//
// The captured declaration comes from the raw capture: the generated
// stylesheet is the captured one with values rewritten in place, so when both
// have the same declarations in the same order they are matched one to one.
// Otherwise the token's captured value from site.config.reference.json is used,
// and the binding says so.

export type TokenBinding = {
  id: string; // "<file>#<declaration index>"
  file: string;
  index: number;
  selector: string;
  property: string;
  line: number | null;
  tokens: string[];
  original: string;
  originalFrom: "raw-capture" | "reference-config";
  rawFile: string | null;
  value: string; // the bound value (var() with fallback)
  state: "bound" | "detached" | "overridden";
  current: string;
};
export type TokenInfo = { name: string; configKey: string; reference: string | null; uses: number };
export type InlineUse = { file: string; occurrences: number; tokens: string[] };
export type TokenMap = { note: string; tokens: TokenInfo[]; bindings: TokenBinding[]; inline: InlineUse[]; unaligned: string[] };

const VAR_BARE = /var\(\s*(--sar-[A-Za-z0-9_-]+)\s*\)/g;
const VAR_ANY = /var\(\s*(--sar-[A-Za-z0-9_-]+)\s*[,)]/g;
export const tokenMapFile = (t: string) => join(t, "tokens", "token-map.json");

type RefConfig = { colors?: Record<string, { value?: string }>; fonts?: Record<string, { family?: string }>; typography?: Record<string, { value?: string }> };
function referenceValues(t: string): Map<string, { value: string; key: string }> {
  const file = existsSync(join(t, "site.config.reference.json")) ? join(t, "site.config.reference.json") : join(t, "site.config.json");
  const out = new Map<string, { value: string; key: string }>();
  if (!existsSync(file)) return out;
  const ref = readJson<RefConfig>(file);
  for (const [k, c] of Object.entries(ref.colors ?? {})) if (c?.value) out.set(`--sar-color-${k}`, { value: c.value, key: `colors.${k}` });
  for (const [k, f] of Object.entries(ref.fonts ?? {})) if (f?.family) out.set(`--sar-font-${k}`, { value: f.family, key: `fonts.${k}` });
  for (const [k, ty] of Object.entries(ref.typography ?? {})) if (ty?.value) out.set(`--sar-${k}`, { value: ty.value, key: `typography.${k}` });
  return out;
}

function selectorOf(node: CssNode): string {
  const parts: string[] = [];
  for (let p = node.parent; p && p.type !== "root"; p = p.parent as CssNode["parent"]) {
    if (p.type === "rule") parts.unshift((p as postcss.Rule).selector);
    else if (p.type === "atrule") parts.unshift(`@${(p as postcss.AtRule).name} ${(p as postcss.AtRule).params}`.trim());
  }
  return parts.join(" › ") || "(top level)";
}
const declsOf = (root: postcss.Root) => {
  const out: Declaration[] = [];
  root.walkDecls((d) => {
    out.push(d);
  });
  return out;
};
const withFallbacks = (value: string, refs: Map<string, { value: string }>, html = false) =>
  value.replace(VAR_BARE, (m, name: string) => {
    const ref = refs.get(name)?.value;
    if (!ref) return m;
    return `var(${name}, ${html ? ref.replace(/"/g, "'") : ref})`;
  });
const resolveFallbacks = (value: string) => value.replace(/var\(\s*--sar-[A-Za-z0-9_-]+\s*,\s*((?:[^()]|\([^()]*\))*)\)/g, (_m, fb: string) => fb.trim());
const tokensIn = (value: string) => [...new Set([...value.matchAll(VAR_ANY)].map((m) => m[1]))];

type Resource = { localPath?: string; templatePath?: string };

/**
 * Adds fallbacks and writes the token map. Idempotent: a stylesheet that
 * already has fallbacks keeps them, and its bindings are recorded again.
 */
export function normalizeTokens(t: string, captureDir: string | null): TokenMap {
  const refs = referenceValues(t);
  const resources: Resource[] = captureDir && existsSync(join(captureDir, "manifest.json")) ? (readJson<{ resources?: Resource[] }>(join(captureDir, "manifest.json")).resources ?? []) : [];
  const previous = existsSync(tokenMapFile(t)) ? readJson<TokenMap>(tokenMapFile(t)) : null;
  const bindings: TokenBinding[] = [];
  const unaligned: string[] = [];
  const uses = new Map<string, number>();

  for (const rel of listFiles(t).filter((f) => f.endsWith(".css") && !f.startsWith("dist/") && !f.startsWith("brand/"))) {
    const file = join(t, rel);
    const text = readFileSync(file, "utf8");
    if (!text.includes("--sar-")) continue;
    let root: postcss.Root;
    try {
      root = postcss.parse(text, { from: undefined });
    } catch {
      unaligned.push(`${rel} (not parseable CSS)`);
      continue;
    }
    const decls = declsOf(root);
    // The captured stylesheet this one was generated from.
    const res = resources.find((r) => r.templatePath === rel);
    let raw: Declaration[] | null = null;
    if (res?.localPath && captureDir && existsSync(join(captureDir, res.localPath))) {
      try {
        const rawDecls = declsOf(postcss.parse(readFileSync(join(captureDir, res.localPath), "utf8"), { from: undefined }));
        if (rawDecls.length === decls.length && rawDecls.every((d, i) => d.prop === decls[i].prop)) raw = rawDecls;
      } catch {
        /* unparseable capture: reference values are used */
      }
    }
    if (!raw) unaligned.push(rel);
    let changed = false;
    decls.forEach((d, i) => {
      const kept = previous?.bindings.find((b) => b.id === `${rel}#${i}` && b.property === d.prop && b.state !== "bound");
      if (kept && !d.value.includes("var(--sar-")) {
        bindings.push({ ...kept, current: d.value }); // detached or overridden earlier
        return;
      }
      if (d.prop.startsWith("--") || !d.value.includes("var(--sar-")) return;
      const names = tokensIn(d.value);
      if (!names.length) return;
      const bound = withFallbacks(d.value, refs);
      if (bound !== d.value) {
        d.value = bound;
        changed = true;
      }
      for (const n of names) uses.set(n, (uses.get(n) ?? 0) + 1);
      const id = `${rel}#${i}`;
      const before = previous?.bindings.find((b) => b.id === id && b.property === d.prop);
      bindings.push({
        id,
        file: rel,
        index: i,
        selector: selectorOf(d),
        property: d.prop,
        line: d.source?.start?.line ?? null,
        tokens: names,
        original: raw ? raw[i].value : resolveFallbacks(bound),
        originalFrom: raw ? "raw-capture" : "reference-config",
        rawFile: raw ? res!.localPath! : null,
        value: before?.value ?? bound,
        state: before?.state ?? "bound",
        current: d.value,
      });
    });
    if (changed) writeFileSync(file, root.toString());
  }

  // var() inside the markup (style attributes, <style> blocks): fallbacks only.
  const inline: InlineUse[] = [];
  for (const rel of listFiles(t).filter((f) => f.endsWith(".html") && /^(components|layouts|composition)\//.test(f))) {
    const file = join(t, rel);
    const text = readFileSync(file, "utf8");
    if (!text.includes("var(--sar-")) continue;
    const next = withFallbacks(text, refs, true);
    if (next !== text) writeFileSync(file, next);
    const names = [...next.matchAll(VAR_ANY)].map((m) => m[1]);
    for (const n of names) uses.set(n, (uses.get(n) ?? 0) + 1);
    inline.push({ file: rel, occurrences: names.length, tokens: [...new Set(names)] });
  }

  const map: TokenMap = {
    note: "Every declaration that uses a design token. 'original' is the captured declaration's value; detach a declaration to use it instead of the token.",
    tokens: [...refs.entries()].map(([name, r]) => ({ name, configKey: r.key, reference: r.value, uses: uses.get(name) ?? 0 })),
    bindings,
    inline,
    unaligned,
  };
  writeJson(tokenMapFile(t), map);
  return map;
}

export const readTokenMap = (t: string): TokenMap | null => (existsSync(tokenMapFile(t)) ? readJson<TokenMap>(tokenMapFile(t)) : null);

const SAFE_VALUE = /^[^;{}<>\\]{1,500}$/;

/** Detach a declaration from its token, re-attach it, or give it an explicit value. */
export function setBinding(t: string, entry: string, action: "detach" | "attach" | "set", value?: string): TokenBinding {
  const map = readTokenMap(t);
  const b = map?.bindings.find((x) => x.id === entry);
  if (!map || !b) throw new StoreError("not_found", `No token binding "${entry}" in this template.`);
  const file = join(t, b.file);
  const root = postcss.parse(readFileSync(file, "utf8"), { from: undefined });
  const d = declsOf(root)[b.index];
  if (!d || d.prop !== b.property) throw new StoreError("conflict", `${b.file} has changed since its tokens were mapped, so ${b.property} in ${b.selector} cannot be found.`);
  if (action === "detach") {
    d.value = b.original;
    b.state = "detached";
  } else if (action === "attach") {
    d.value = b.value;
    b.state = "bound";
  } else {
    const v = (value ?? "").trim();
    if (!SAFE_VALUE.test(v) || /url\(/i.test(v)) throw new StoreError("invalid", "Enter a plain CSS value (no ; { } < > or url()).");
    d.value = v;
    b.state = "overridden";
  }
  b.current = d.value;
  writeFileSync(file, root.toString());
  writeJson(tokenMapFile(t), map);
  return b;
}
