// Preview host for one generated website template (local development).
//
// Started by Web as a separate process (src/server/preview/preview-manager.ts):
//   node scripts/preview-host.mjs --dir <template> --port <n> --state <file> --heartbeat <file>
//        --frame-ancestors "<origins>" --idle-ms <ms>
//
// - Processing: writes the page layouts from the composition (Web's
//   template-compose.mjs), then runs the template's own build (node build.mjs,
//   its actual runtime) at start and after every change to its sources, in a
//   child process so a failing build never takes the server down; the last
//   good dist/ keeps being served and the error is reported.
// - Serving: dist/ from 127.0.0.1 only, with headers that keep captured
//   pages isolated: no cookies are ever set, forms cannot submit anywhere,
//   scripts cannot call other origins, and only the dashboard may frame it.
// - Reporting: a small JSON state file (building / ready / error, build id,
//   and the files the browser asked for that do not exist).
// - Lifetime: exits on SIGTERM/SIGINT, or by itself when the dashboard stops
//   touching the heartbeat file (an abandoned preview cleans itself up).
//
// Written for Web; no SaveAllResources code is used here. It only runs the
// template's build.mjs, which Web verified before starting this host.
import { composeTemplate } from "./template-compose.mjs";

import { spawn } from "node:child_process";
import { createReadStream, existsSync, renameSync, statSync, watch, writeFileSync } from "node:fs";
import http from "node:http";
import { extname, join, normalize, resolve } from "node:path";

const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : def;
};
const dir = resolve(arg("dir"));
const port = Number(arg("port"));
const stateFile = arg("state");
const heartbeat = arg("heartbeat");
const frameAncestors = arg("frame-ancestors", "'self'");
const idleMs = Number(arg("idle-ms", String(30 * 60_000)));
if (!dir || !Number.isInteger(port) || !stateFile) {
  console.error("usage: preview-host --dir <template> --port <n> --state <file> [--heartbeat <file>] [--frame-ancestors <origins>] [--idle-ms <ms>]");
  process.exit(64);
}
const dist = join(dir, "dist");

const TYPES = {
  ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
  ".webp": "image/webp", ".avif": "image/avif", ".ico": "image/x-icon", ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf",
  ".otf": "font/otf", ".mp4": "video/mp4", ".webm": "video/webm", ".txt": "text/plain; charset=utf-8",
};
// Captured pages may only load their own files: no outside requests, no form
// submissions, framed only by the dashboard. (The template's own meta CSP and
// runtime guard apply on top of this.)
const CSP = [
  "default-src 'self'",
  "img-src 'self' data: blob:",
  "media-src 'self' data: blob:",
  "font-src 'self' data:",
  "style-src 'self' 'unsafe-inline'",
  "script-src 'self' 'unsafe-inline'",
  "connect-src 'self'",
  "form-action 'none'",
  "base-uri 'self'",
  "object-src 'none'",
  `frame-ancestors ${frameAncestors}`,
].join("; ");

let state = { state: "starting", buildId: 0, error: null, pid: process.pid, port, startedAt: new Date().toISOString(), builtAt: null, notFound: [] };
const writeState = (patch) => {
  state = { ...state, ...patch, updatedAt: new Date().toISOString() };
  const tmp = `${stateFile}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(state));
  renameSync(tmp, stateFile);
};

// ------------------------------------------------------------------ build
let building = false;
let again = false;
let composed = { at: 0, files: new Set() };
function build() {
  if (building) {
    again = true;
    return;
  }
  building = true;
  writeState({ state: "building" });
  try {
    const { written } = composeTemplate(dir);
    composed = { at: Date.now(), files: new Set(written) };
  } catch (e) {
    building = false;
    writeState({ state: "error", error: `The page composition is invalid: ${e.message}` });
    if (again) {
      again = false;
      build();
    }
    return;
  }
  const child = spawn(process.execPath, ["build.mjs"], { cwd: dir, stdio: ["ignore", "pipe", "pipe"], env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" } });
  let out = "";
  child.stdout.on("data", (c) => (out += c));
  child.stderr.on("data", (c) => (out += c));
  const timer = setTimeout(() => child.kill("SIGKILL"), 120_000);
  child.on("close", (code) => {
    clearTimeout(timer);
    building = false;
    if (code === 0) writeState({ state: "ready", buildId: state.buildId + 1, error: null, builtAt: new Date().toISOString(), notFound: [] });
    else writeState({ state: "error", error: `The template's build failed (exit ${code ?? "killed"}): ${out.trim().split("\n").slice(-6).join("\n").slice(0, 1500)}` });
    if (again) {
      again = false;
      build();
    }
  });
}

// --------------------------------------------------------------- serving
const server = http.createServer((req, res) => {
  // No Cross-Origin-Resource-Policy: the dashboard shows this page in a
  // sandboxed iframe, whose origin is opaque, so "same-origin" would block the
  // template's own CSS, images and scripts. Isolation comes from the sandbox and CSP.
  const headers = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", "Content-Security-Policy": CSP };
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { ...headers, Allow: "GET, HEAD" }).end("Preview is read-only.");
    return;
  }
  let path;
  try {
    path = decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname);
  } catch {
    res.writeHead(400, headers).end();
    return;
  }
  let file = normalize(join(dist, path));
  if (file !== dist && !file.startsWith(dist + "/")) {
    res.writeHead(403, headers).end();
    return;
  }
  if (!existsSync(dist)) {
    res.writeHead(503, { ...headers, "Content-Type": "text/plain; charset=utf-8", "Retry-After": "1" }).end(state.state === "error" ? state.error : "Building the preview…");
    return;
  }
  if (existsSync(file) && statSync(file).isDirectory()) file = join(file, "index.html");
  if (!existsSync(file)) {
    // Reported to the dashboard as a missing asset (browsers ask for /favicon.ico on their own).
    if (path !== "/favicon.ico" && state.notFound.length < 50 && !state.notFound.includes(path)) writeState({ notFound: [...state.notFound, path] });
    res.writeHead(404, { ...headers, "Content-Type": "text/plain; charset=utf-8" }).end("Not found in this template.");
    return;
  }
  res.writeHead(200, { ...headers, "Content-Type": TYPES[extname(file).toLowerCase()] ?? "application/octet-stream" });
  if (req.method === "HEAD") return res.end();
  createReadStream(file).pipe(res);
});

server.on("error", (e) => {
  writeState({ state: "error", error: `The preview server could not start: ${e.message}` });
  process.exit(1);
});

server.listen(port, "127.0.0.1", () => {
  build();
  // Rebuild after changes to the template's sources. The whole folder is
  // watched (not single files): editors save by writing a temporary file and
  // renaming it over the old one, which a per-file watch would stop seeing.
  const SOURCES = /^(site\.config\.json|content|components|layouts|pages|assets|composition)(\/|\\|$)/;
  let timer;
  watch(dir, { recursive: true }, (_event, name) => {
    const n = String(name ?? "");
    if (!SOURCES.test(n) || n.endsWith(".tmp")) return;
    // Layouts this host just composed itself are not a new change.
    if (composed.files.has(n.split("\\").join("/")) && Date.now() - composed.at < 2000) return;
    clearTimeout(timer);
    timer = setTimeout(build, 250);
  });
});

// ---------------------------------------------------------------- lifetime
const stop = () => {
  writeState({ state: "stopped" });
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
if (heartbeat) {
  setInterval(() => {
    try {
      if (Date.now() - statSync(heartbeat).mtimeMs > idleMs) stop();
    } catch {
      stop(); // heartbeat file removed: the dashboard let go of this preview
    }
  }, Math.min(30_000, Math.max(1000, idleMs / 4))).unref();
}
