import type { Evidence, FileKind } from "@/domain/source-analysis";

// Shared helpers for the WF-03 scanner. Everything here is deterministic:
// no clocks, no randomness, no I/O.

const EXT_KIND: Record<string, FileKind> = {};
const kinds: [FileKind, string[]][] = [
  ["html", ["html", "htm"]],
  ["css", ["css", "scss", "sass", "less"]],
  ["script", ["js", "mjs", "cjs", "jsx", "ts", "tsx", "mts", "cts", "vue", "svelte", "astro"]],
  ["json", ["json", "webmanifest"]],
  ["image", ["png", "jpg", "jpeg", "gif", "webp", "avif", "svg", "ico", "bmp", "tif", "tiff"]],
  ["font", ["woff", "woff2", "ttf", "otf", "eot"]],
  ["video", ["mp4", "webm", "mov", "m4v", "ogv"]],
  ["audio", ["mp3", "wav", "ogg", "m4a", "aac"]],
  ["document", ["md", "mdx", "txt", "pdf", "xml", "yml", "yaml", "toml"]],
];
for (const [kind, exts] of kinds) for (const e of exts) EXT_KIND[e] = kind;

export const extOf = (path: string) => {
  const m = /\.([A-Za-z0-9]+)$/.exec(path);
  return m ? m[1].toLowerCase() : "";
};
export const kindOf = (path: string): FileKind => EXT_KIND[extOf(path)] ?? "other";
export const isTextKind = (k: FileKind, path: string) =>
  k === "html" || k === "css" || k === "script" || k === "json" || k === "document" || extOf(path) === "svg" || /(^|\/)(LICEN[CS]E|COPYING|NOTICE)[^/]*$/i.test(path) || /(^|\/)\.env/.test(path);

export const byString = <T>(key: (t: T) => string) => (a: T, b: T) => {
  const x = key(a);
  const y = key(b);
  return x < y ? -1 : x > y ? 1 : 0;
};

// Line numbers from string offsets, for evidence.
export function lineIndex(text: string): (offset: number) => number {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1);
  return (offset) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
}

export const excerpt = (s: string, max = 120) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

export const ev = (path: string, line: number | null = null, text: string | null = null): Evidence => ({
  path,
  line,
  excerpt: text === null ? null : excerpt(text),
});

// Keeps a bounded, ordered list of evidence per key while counting all.
export class Tally {
  private map = new Map<string, { count: number; evidence: Evidence[] }>();
  add(key: string, e: Evidence) {
    const entry = this.map.get(key) ?? { count: 0, evidence: [] };
    entry.count++;
    if (entry.evidence.length < 10) entry.evidence.push(e);
    this.map.set(key, entry);
  }
  get(key: string) {
    return this.map.get(key);
  }
  entries() {
    return [...this.map.entries()].sort(byString(([k]) => k));
  }
}

const SKIP_REF = /^(data:|blob:|mailto:|tel:|javascript:|#|about:)/i;

export type ResolvedRef = { type: "local"; path: string } | { type: "external"; url: string } | { type: "ignored" };

// Resolves a reference found in `from` (an href, src or url()) to a path in
// the archive, an external URL, or nothing worth tracking.
export function resolveRef(from: string, raw: string): ResolvedRef {
  const ref = raw.trim();
  if (!ref || SKIP_REF.test(ref)) return { type: "ignored" };
  if (/^https?:\/\//i.test(ref)) return { type: "external", url: ref };
  if (ref.startsWith("//")) return { type: "external", url: `https:${ref}` };
  if (/^[a-z][a-z0-9+.-]*:/i.test(ref)) return { type: "ignored" };
  let path = ref.split(/[?#]/)[0];
  try {
    path = decodeURIComponent(path);
  } catch {
    /* keep as written */
  }
  if (!path) return { type: "ignored" };
  const base = path.startsWith("/") ? [] : from.split("/").slice(0, -1);
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") base.pop();
    else base.push(part);
  }
  return { type: "local", path: base.join("/") };
}

// Secrets are reported by kind and location, never by value.
export const SECRET_PATTERNS: [string, RegExp][] = [
  ["AWS access key id", /AKIA[0-9A-Z]{16}/g],
  ["Google API key", /AIza[0-9A-Za-z_-]{35}/g],
  ["Stripe live secret key", /sk_live_[0-9A-Za-z]{20,}/g],
  ["GitHub token", /gh[pousr]_[A-Za-z0-9]{36,}/g],
  ["Slack token", /xox[abprs]-[A-Za-z0-9-]{10,}/g],
  ["Private key", /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g],
];

export const mask = (s: string) => (s.length <= 8 ? "****" : `${s.slice(0, 4)}…(${s.length} chars, masked)`);
