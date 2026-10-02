import { createHash } from "node:crypto";
import { unzipSync } from "fflate";
import { MAX_CAPTURE_BYTES } from "@/domain/reference";

// Reads an uploaded source archive into memory, safely. Archives come from
// users and from captured third-party sites, so nothing in one is trusted:
// paths that escape the archive are refused, sizes are capped before and
// after decompression (a zip bomb can lie about its sizes), and what is
// skipped is reported rather than silently dropped.

export type SourceFile = { path: string; bytes: Uint8Array; sizeBytes: number; sha256: string };

export type ArchiveLimits = { maxFiles: number; maxFileBytes: number; maxTotalBytes: number };

// The expansion ceiling (zip-bomb guard) is twice the largest archive WF-02
// accepts: real SaveAllResources templates expand about 1.3x, so a
// 200 MB template must stay analysable, while a bomb is still refused.
export const DEFAULT_LIMITS: ArchiveLimits = {
  maxFiles: 5000,
  maxFileBytes: 25 * 1024 * 1024,
  maxTotalBytes: 2 * MAX_CAPTURE_BYTES,
};

export class ArchiveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArchiveError";
  }
}

// Folders whose contents are not the project's own source. Their presence is
// recorded; their files are not read.
const IGNORED_DIRS = /(^|\/)(node_modules|\.git|\.next|\.nuxt|\.svelte-kit|\.cache|\.turbo|__MACOSX)\//;
const IGNORED_FILES = /(^|\/)(\.DS_Store|Thumbs\.db)$/;

// Normalises an entry name; null if it is unsafe or not a file.
export function safePath(name: string): string | null {
  const p = name.replace(/\\/g, "/");
  if (p.endsWith("/")) return null; // directory entry
  if (p.startsWith("/") || /^[A-Za-z]:/.test(p)) return null; // absolute
  const parts = p.split("/").filter((s) => s !== "" && s !== ".");
  if (parts.length === 0 || parts.some((s) => s === "..")) return null;
  if (parts.some((s) => s.includes("\0"))) return null;
  return parts.join("/");
}

export function readArchive(
  bytes: Uint8Array,
  limits: ArchiveLimits = DEFAULT_LIMITS,
  // Inflate only the entries this accepts (by path before root stripping);
  // every entry is still listed and checked. Default: everything.
  select?: (path: string) => boolean,
): { files: SourceFile[]; skipped: { path: string; reason: string }[]; rootPrefix: string; names: string[] } {
  const names: string[] = [];
  const skipped: { path: string; reason: string }[] = [];
  const ignoredDirs = new Set<string>();
  let declaredTotal = 0;
  let accepted = 0;

  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(bytes, {
      // Decide from the central directory, before anything is inflated.
      filter: (f) => {
        const path = safePath(f.name);
        if (path === null) {
          if (!f.name.endsWith("/")) skipped.push({ path: f.name.slice(0, 300), reason: "unsafe path (absolute or contains ..)" });
          return false;
        }
        const ignored = IGNORED_DIRS.exec(path);
        if (ignored) {
          ignoredDirs.add(path.slice(0, ignored.index + ignored[0].length));
          return false;
        }
        if (IGNORED_FILES.test(path)) return false;
        if (f.originalSize > limits.maxFileBytes) {
          skipped.push({ path, reason: `larger than ${limits.maxFileBytes / 1024 / 1024} MB` });
          return false;
        }
        if (accepted >= limits.maxFiles) {
          skipped.push({ path, reason: `beyond the ${limits.maxFiles}-file limit` });
          return false;
        }
        declaredTotal += f.originalSize;
        if (declaredTotal > limits.maxTotalBytes) throw new ArchiveError(`The archive expands to more than ${limits.maxTotalBytes / 1024 / 1024} MB.`);
        accepted++;
        names.push(path);
        return select ? select(path) : true;
      },
    });
  } catch (e) {
    if (e instanceof ArchiveError) throw e;
    throw new ArchiveError(`Not a readable zip archive (${(e as Error).message}).`);
  }

  let actualTotal = 0;
  const files: SourceFile[] = [];
  for (const [name, data] of Object.entries(entries)) {
    const path = safePath(name)!;
    // Declared sizes can lie; check what actually came out.
    if (data.byteLength > limits.maxFileBytes) throw new ArchiveError(`${path} expands beyond its declared size.`);
    actualTotal += data.byteLength;
    if (actualTotal > limits.maxTotalBytes) throw new ArchiveError(`The archive expands to more than ${limits.maxTotalBytes / 1024 / 1024} MB.`);
    files.push({ path, bytes: data, sizeBytes: data.byteLength, sha256: createHash("sha256").update(data).digest("hex") });
  }
  for (const dir of [...ignoredDirs].sort()) skipped.push({ path: dir, reason: "not project source (dependency, build or VCS folder); contents not read" });
  if ((select ? names.length : files.length) === 0) throw new ArchiveError("The archive contains no readable files.");

  // Strip one top-level folder shared by every file (GitHub and `git archive`
  // downloads wrap everything in one), keeping it so paths map back exactly.
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const basis = select ? names : files.map((f) => f.path);
  const first = basis[0].split("/")[0];
  const shared = basis.every((p) => p.startsWith(`${first}/`));
  const rootPrefix = shared ? `${first}/` : "";
  if (rootPrefix) for (const f of files) f.path = f.path.slice(rootPrefix.length);
  skipped.sort((a, b) => (a.path < b.path ? -1 : 1));
  return { files, skipped, rootPrefix, names: names.map((p) => (rootPrefix ? p.slice(rootPrefix.length) : p)) };
}
