import { createHash } from "node:crypto";
import { z } from "zod";
import { normaliseReferenceUrl } from "@/domain/reference";
import { ArchiveError, readArchive } from "@/server/wf03/archive";
import { StoreError } from "@/server/store/errors";

// Adapter: a SaveAllResources export ZIP (exports/<job>-website-template.zip,
// produced by the sar-website-template app) → the existing WF-02 capture and
// WF-03 source registration.
//
// The ZIP is not transformed: it is stored, hashed and scanned exactly as a
// manually uploaded archive. The adapter only reads the export's own
// manifest.json (through WF-03's readArchive, so the same path and size
// rules apply) and fills in the metadata a person would otherwise type:
// which tool, which URL, when, which job and manifest version. Authority is
// always study_only, as for every WF-02 capture; raising it is the existing
// WF-03 step, with its required evidence.

export const SAR_TOOL = "SaveAllResources";
// Two writers produce this manifest format: the SaveAllResources app's own
// export, and Web's packager for captures sent straight to Web (sar-package.ts).
export const SAR_GENERATOR = "sar-website-template";
export const WEB_GENERATOR = "scl-web-sar-capture";
const GENERATORS = [SAR_GENERATOR, WEB_GENERATOR];
export const SAR_SUPPORTED_MAJOR = "1";

// SaveAllResources records capture times as epoch milliseconds (Date.now());
// manifest creation as ISO. Accept both, normalise to ISO.
const Instant = z.union([z.number().int().positive(), z.iso.datetime({ offset: true })]).transform((v) => new Date(v).toISOString());

// The subset of manifest.json this adapter relies on (manifestVersion 1.x,
// app/processing/package.mjs). Anything else in the manifest is ignored.
const SarManifest = z.object({
  manifestVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
  generator: z.enum([SAR_GENERATOR, WEB_GENERATOR]),
  jobId: z.string().min(1).max(200),
  createdAt: Instant,
  entryUrl: z.string().min(1).max(2000),
  capture: z
    .object({
      engine: z.string().nullish(),
      status: z.string().nullish(),
      startedAt: Instant.nullish(),
      finishedAt: Instant.nullish(),
      discoveryComplete: z.boolean().nullish(),
    })
    .passthrough(),
  pages: z.array(z.object({ id: z.string(), requestedUrl: z.string().nullish(), status: z.string().nullish() }).passthrough()),
});

export type SarExport = {
  generator: string;
  manifestVersion: string;
  jobId: string;
  entryUrl: string; // as recorded by SaveAllResources
  referenceUrl: string; // normalised for the WF-02 library
  host: string;
  capturedAt: string; // capture finish (or start, or manifest creation) time
  capturedOn: string; // its UTC date, for WF-02
  engine: string | null;
  captureStatus: string | null;
  discoveryComplete: boolean | null;
  pages: { total: number; captured: number };
  sha256: string;
};

const invalid = (message: string) => new StoreError("invalid", message, [{ path: "file", message }]);

// A plain download from the Chrome Web Store build of Save All Resources: no
// manifest, just one folder per host ("<host>/<path>", SAR's resolveURLToPath)
// and "_DataURI/". SaveAllResources' `--import` turns it into an export; this
// only recognises one and guesses its site, so Web can hand it over.
const HOST_DIR = /^(?:(?:[a-z0-9_](?:[a-z0-9_-]{0,62}[a-z0-9_])?\.)+[a-z0-9-]{2,63}\d{0,5}|localhost\d{0,5}|\d{1,3}(?:\.\d{1,3}){3}\d{0,5})$/i;
const SPECIAL_DIR = /^(_DataURI|[a-z][a-z0-9+.-]*---.*)$/i;

export type SarDownload = { host: string; entryUrl: string; htmlPages: number };

export function detectSarDownload(bytes: Uint8Array, filename = ""): SarDownload | null {
  let names: string[];
  try {
    const a = readArchive(bytes, undefined, () => false); // list and check every entry, inflate none
    names = a.names.map((n) => `${a.rootPrefix}${n}`);
  } catch {
    return null;
  }
  if (names.some((n) => n === "manifest.json" || /^[^/]+\/manifest\.json$/.test(n))) return null;
  const layout = (paths: string[]) => {
    const html = new Map<string, number>();
    let inTree = 0;
    for (const p of paths) {
      const top = p.split("/")[0];
      if (!p.includes("/")) continue;
      if (SPECIAL_DIR.test(top)) inTree++;
      else if (HOST_DIR.test(top)) {
        inTree++;
        html.set(top, (html.get(top) ?? 0) + (/\.html?$/i.test(p) ? 1 : 0));
      }
    }
    return [...html.values()].some((n) => n > 0) && inTree >= paths.length * 0.9 ? html : null;
  };
  // A download re-zipped after extracting it gains one wrapper folder.
  const tops = new Set(names.map((n) => n.split("/")[0]));
  const only = tops.size === 1 ? `${[...tops][0]}/` : null;
  const hosts = (only && names.every((n) => n.startsWith(only)) && layout(names.map((n) => n.slice(only.length)))) || layout(names);
  if (!hosts) return null;
  // SAR names the file after the page's hostname; otherwise the host with the most pages.
  const hinted = filename.replace(/^.*[\\/]/, "").replace(/\s*\(\d+\)(?=\.zip$)/i, "").replace(/\.zip$/i, "");
  const ranked = [...hosts.entries()].filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const [host, htmlPages] = ranked.find(([h]) => h === hinted || h.replace(/[^A-Za-z0-9.]/g, "_") === hinted) ?? ranked[0];
  const entryUrl = normaliseReferenceUrl(`https://${host}/`);
  return entryUrl ? { host, entryUrl, htmlPages } : null;
}

// Recognises a SaveAllResources export and reads its provenance. Throws
// StoreError("invalid") for anything else, before anything is stored.
export function readSaveAllResourcesExport(bytes: Uint8Array): SarExport {
  let archive;
  try {
    // Every entry is listed and checked; only manifest.json is inflated.
    archive = readArchive(bytes, undefined, (p) => p === "manifest.json" || p.endsWith("/manifest.json") && p.split("/").length === 2);
  } catch (e) {
    if (e instanceof ArchiveError) throw invalid(e.message);
    throw e;
  }
  const manifestFile = archive.files.find((f) => f.path === "manifest.json");
  if (!manifestFile) {
    throw invalid(
      "Not a SaveAllResources export: there is no manifest.json at the top of the archive. Nor is it a Save All Resources download, which has one folder per website (for example www.example.com/index.html) with at least one HTML page.",
    );
  }
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder().decode(manifestFile.bytes));
  } catch {
    throw invalid("Not a SaveAllResources export: manifest.json is not valid JSON.");
  }
  const generator = (raw as { generator?: unknown })?.generator;
  if (!GENERATORS.includes(String(generator))) throw invalid(`Not a SaveAllResources export: manifest.json was not written by ${GENERATORS.join(" or ")}.`);
  const version = String((raw as { manifestVersion?: unknown }).manifestVersion ?? "");
  if (version.split(".")[0] !== SAR_SUPPORTED_MAJOR) {
    throw invalid(`SaveAllResources manifest version ${version || "(missing)"} is not supported; this adapter reads version ${SAR_SUPPORTED_MAJOR}.x.`);
  }
  const parsed = SarManifest.safeParse(raw);
  if (!parsed.success) throw invalid(`The SaveAllResources manifest is incomplete: ${parsed.error.issues.slice(0, 3).map((i) => `${i.path.join(".") || "manifest"}: ${i.message}`).join("; ")}.`);
  const m = parsed.data;
  // The captured site lives in raw-capture/; without it there is nothing captured to analyse.
  if (!archive.names.some((p) => p.startsWith("raw-capture/pages/"))) {
    throw invalid("This SaveAllResources export has no captured pages (raw-capture/pages/ is missing or empty).");
  }
  const referenceUrl = normaliseReferenceUrl(m.entryUrl);
  if (!referenceUrl) throw invalid("The export's entry URL is not a plain http(s) URL, so it cannot be a WF-02 reference.");
  const capturedAt = m.capture.finishedAt ?? m.capture.startedAt ?? m.createdAt;
  return {
    generator: m.generator,
    manifestVersion: m.manifestVersion,
    jobId: m.jobId,
    entryUrl: m.entryUrl,
    referenceUrl,
    host: new URL(referenceUrl).host,
    capturedAt,
    capturedOn: new Date(capturedAt).toISOString().slice(0, 10),
    engine: m.capture.engine ?? null,
    captureStatus: m.capture.status ?? null,
    discoveryComplete: m.capture.discoveryComplete ?? null,
    pages: { total: m.pages.length, captured: m.pages.filter((p) => p.status === "captured").length },
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

// WF-02 capture metadata (CaptureMeta) for the export.
export function sarCaptureMeta(x: SarExport) {
  const notes = [
    `${x.generator === WEB_GENERATOR ? "SaveAllResources capture sent to SCL Web" : "SaveAllResources export"} (job ${x.jobId}, manifest v${x.manifestVersion}).`,
    `Entry ${x.entryUrl}; ${x.pages.captured} of ${x.pages.total} pages captured${x.discoveryComplete === false ? ", discovery incomplete" : ""}; capture ${x.captureStatus ?? "status not recorded"}, finished ${x.capturedAt}.`,
    x.engine ? `Engine: ${x.engine}.` : "",
    x.generator === WEB_GENERATOR
      ? "raw-capture/ holds the page packages exactly as the extension uploaded them, plus their extracted files."
      : "raw-capture/ holds the captured site; template/ and the reports are generated by SaveAllResources, not taken from the site.",
  ]
    .filter(Boolean)
    .join(" ");
  return { kind: "archive" as const, tool: SAR_TOOL, capturedOn: x.capturedOn, notes: notes.slice(0, 1000) };
}

// WF-03 SourceRegistration for the export. study_only unless a person
// explicitly declared otherwise (WF-03 validates the declaration as usual).
export function sarSourceRegistration(x: SarExport, authorization: { basis: "study_only" | "client_owned"; note: string; license: string } = { basis: "study_only", note: "", license: "" }) {
  return {
    label: `${SAR_TOOL} capture · ${x.host}`.slice(0, 160),
    originUrl: x.entryUrl.slice(0, 500),
    originRef: `saveallresources:job=${x.jobId};manifest=${x.manifestVersion}`.slice(0, 200),
    authorization,
  };
}

// The narrow slice of the store this import uses: existing WF-02 and WF-03 calls only.
type Deps = {
  references: {
    list: (projectId: string) => { reference: { id: string; url: string }; captures: { id: string; file: { sha256: string } }[] }[];
    add: (projectId: string, input: unknown) => { id: string };
    addCapture: (projectId: string, referenceId: string, meta: unknown, file: { filename: string; mimeType: string; bytes: Uint8Array }) => { id: string };
  };
  sources: {
    list: (projectId: string) => { source: { id: string; archive: { sha256: string } } }[];
    registerFromCapture: (projectId: string, referenceId: string, captureId: string, meta: unknown) => { id: string };
  };
};

// Registers an already-validated export for a known reference: the WF-02
// capture, then the study-only WF-03 source. Used by direct captures, whose
// job already belongs to a reference.
export function registerSarExport(store: Deps, projectId: string, referenceId: string, x: SarExport, file: { filename: string; bytes: Uint8Array }) {
  if (store.sources.list(projectId).some((s) => s.source.archive.sha256 === x.sha256)) {
    throw new StoreError("conflict", "This exact SaveAllResources capture is already a source in this project.", [{ path: "file", message: "Already imported" }]);
  }
  const capture = store.references.addCapture(projectId, referenceId, sarCaptureMeta(x), { filename: file.filename, mimeType: "application/zip", bytes: file.bytes });
  const source = store.sources.registerFromCapture(projectId, referenceId, capture.id, sarSourceRegistration(x));
  return { captureId: capture.id, sourceId: source.id };
}

export type SarImportResult = { referenceId: string; captureId: string; sourceId: string; createdReference: boolean; reusedCapture: boolean; export: SarExport };

// SaveAllResources ZIP → WF-02 reference capture → WF-03 source (study_only).
// Analysis is then the existing "Run analysis" step.
export function importSaveAllResourcesExport(store: Deps, projectId: string, file: { filename: string; bytes: Uint8Array }): SarImportResult {
  if (!/\.zip$/i.test(file.filename)) throw invalid("Upload the SaveAllResources export .zip.");
  const x = readSaveAllResourcesExport(file.bytes);
  // Refuse a repeat before anything is written.
  if (store.sources.list(projectId).some((s) => s.source.archive.sha256 === x.sha256)) {
    throw new StoreError("conflict", "This exact SaveAllResources export is already a source in this project.", [{ path: "file", message: "Already imported" }]);
  }
  const existing = store.references.list(projectId).find((r) => r.reference.url === x.referenceUrl);
  const referenceId = existing?.reference.id ?? store.references.add(projectId, { url: x.referenceUrl, label: `${x.host} (SaveAllResources)`, pageType: "" }).id;
  // An earlier import that stopped after the capture is completed, not duplicated.
  const prior = existing?.captures.find((c) => c.file.sha256 === x.sha256);
  const captureId = prior?.id ?? store.references.addCapture(projectId, referenceId, sarCaptureMeta(x), { filename: file.filename, mimeType: "application/zip", bytes: file.bytes }).id;
  const source = store.sources.registerFromCapture(projectId, referenceId, captureId, sarSourceRegistration(x));
  return { referenceId, captureId, sourceId: source.id, createdReference: !existing, reusedCapture: !!prior, export: x };
}
