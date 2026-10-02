import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { strToU8, zipSync } from "fflate";

// TEST FIXTURE: a stand-in SaveAllResources installation with the same
// interface as the real app/cli.mjs (positional URL, --max-pages/--max-depth/
// --max-minutes/--out, SAR_DATA_DIR/jobs/<id>/job.json, <out>/<id>-website-
// template.zip, exit codes 0/1/130, graceful SIGINT). Behaviour is chosen by
// the URL's host so tests never need a browser. Not SaveAllResources code.

const CLI = String.raw`
import { copyFileSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
const argv = process.argv.slice(2);
const url = argv[0];
const out = argv[argv.indexOf("--out") + 1];
const host = new URL(url).hostname;
const jobId = "job_stub_" + Math.random().toString(36).slice(2, 10);
const dir = join(process.env.SAR_DATA_DIR, "jobs", jobId);
mkdirSync(dir, { recursive: true });
const write = (status, progress) => writeFileSync(join(dir, "job.json"), JSON.stringify({ jobId, url, status, capture: progress ? { progress } : null }));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
console.log("Job " + jobId);
const home = new URL("..", import.meta.url).pathname;
const zipTo = () => { mkdirSync(out, { recursive: true }); copyFileSync(join(home, "fixture.zip"), join(out, jobId + "-website-template.zip")); };
if (host === "env.test") writeFileSync(join(out, "env.json"), JSON.stringify(Object.keys(process.env).sort()));
if (host === "fail.test") { console.log("error: navigation to the site failed"); process.exit(1); }
if (host === "slow.test" || host === "hang.test") {
  write("capturing", { discovered: 3, captured: 1, failed: 0, pending: 2 });
  process.on("SIGINT", () => { if (host === "slow.test") { write("cancelled", null); setTimeout(() => process.exit(130), 50); } });
  setInterval(() => {}, 1000);
} else {
  write("awaiting_extension", null); await sleep(60);
  write("capturing", { discovered: 2, captured: 1, failed: 0, pending: 1 }); await sleep(60);
  write("templatising", { discovered: 2, captured: 2, failed: 0, pending: 0 }); await sleep(60);
  write("completed", { discovered: 2, captured: 2, failed: 0, pending: 0 }); await sleep(60);
  if (host !== "nozip.test") zipTo();
  console.log("Status: completed");
  process.exit(0);
}
`;

// A small, valid export laid out as SaveAllResources writes it.
export function stubExport(opts: { entryUrl?: string; padBytes?: number; padParts?: number; jobId?: string } = {}): Uint8Array {
  const page = `<!doctype html><html lang="en"><head><title>Stub</title><link rel="stylesheet" href="/css/site.css"></head><body><header class="site-header"><nav><a href="/">Home</a></nav></header><main><h1>Stub site</h1></main></body></html>`;
  const manifest = {
    manifestVersion: "1.0.0",
    generator: "sar-website-template",
    jobId: opts.jobId ?? "job_stub",
    createdAt: "2026-10-01T10:05:00.000Z",
    entryUrl: opts.entryUrl ?? "http://ok.test/",
    capture: { engine: "stub", status: "completed", startedAt: 1790000000000, finishedAt: 1790000100000, discoveryComplete: true },
    pages: [{ id: "home", requestedUrl: opts.entryUrl ?? "http://ok.test/", status: "captured" }],
  };
  const files: Record<string, Uint8Array | [Uint8Array, { level: 0 }]> = {
    "website-template/manifest.json": strToU8(JSON.stringify(manifest)),
    "website-template/raw-capture/pages/home/document.original.html": strToU8(page),
    "website-template/raw-capture/resources/ok.test/css/site.css": strToU8(":root { --brand: #7a1fa2; }\nbody { font-family: Georgia, serif; }\n"),
    "website-template/template/site.config.json": strToU8(JSON.stringify({ brand: { name: "Stub" } })),
    "website-template/template/layouts/home.html": strToU8(page),
  };
  // Incompressible padding, in parts under WF-03's 25 MB per-file read limit.
  const total = opts.padBytes ?? 0;
  const parts = total ? (opts.padParts ?? Math.ceil(total / (20 * 1024 * 1024))) : 0;
  for (let i = 0; i < parts; i++) {
    const n = Math.floor(total / parts) + (i < total % parts ? 1 : 0);
    const buf = new Uint8Array(n);
    for (let k = 0; k < n; k += 4) buf[k] = (k * 2654435761) >>> 24;
    files[`website-template/raw-capture/resources/pad/${i}.bin`] = [buf, { level: 0 }];
  }
  return zipSync(files as Parameters<typeof zipSync>[0]);
}

// An export of exactly `target` bytes (stored entries, so the overhead is fixed).
export function stubExportOfSize(target: number, entryUrl?: string): Uint8Array {
  const parts = Math.ceil(target / (20 * 1024 * 1024));
  const overhead = stubExport({ entryUrl, padBytes: parts, padParts: parts }).byteLength - parts;
  const z = stubExport({ entryUrl, padBytes: target - overhead, padParts: parts });
  if (z.byteLength !== target) throw new Error(`stub export is ${z.byteLength}, wanted ${target}`);
  return z;
}

export function makeStubSarHome(dir: string, fixture: Uint8Array = stubExport()) {
  mkdirSync(join(dir, "app"), { recursive: true });
  mkdirSync(join(dir, "node_modules", "puppeteer"), { recursive: true });
  mkdirSync(join(dir, "extension", "dist"), { recursive: true });
  writeFileSync(join(dir, "app", "cli.mjs"), CLI);
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "sar-website-template", type: "module" }));
  writeFileSync(join(dir, "node_modules", "puppeteer", "package.json"), "{}");
  writeFileSync(join(dir, "extension", "dist", "extension-id.txt"), "stub");
  writeFileSync(join(dir, "fixture.zip"), fixture);
  return dir;
}
