import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkSarInstallation, createLocalRunner, parseSarJob, resolveSarHome, RunnerError, type RunOutcome, type RunProgress } from "./sar-runner";
import { makeStubSarHome } from "./sar-test-stub";

// The runner against a stub SaveAllResources installation (sar-test-stub.ts):
// same command-line interface, no browser.

let dir: string;
let home: string;
let runs: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "scl-sar-runner-"));
  home = makeStubSarHome(join(dir, "sar"));
  runs = join(dir, "runs");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const runner = (over: Partial<Parameters<typeof createLocalRunner>[0]> = {}) => createLocalRunner({ home, runsDir: runs, pollMs: 20, killGraceMs: 500, portInUse: async () => false, ...over });
const opts = { maxPages: 2, maxDepth: 1, maxMinutes: 1 };
let n = 0;
const rid = () => `run_test_${++n}_${Math.random().toString(36).slice(2, 8)}`;

function run(r: ReturnType<typeof runner>, url: string, runId = rid()) {
  const progress: RunProgress[] = [];
  let resolveExit: (o: RunOutcome) => void;
  const exited = new Promise<RunOutcome>((res) => (resolveExit = res));
  const started = r.start({ runId, url, options: opts }, { onProgress: (p) => progress.push(p), onExit: (o) => resolveExit(o) });
  return { runId, started, exited, progress };
}

describe("installation and configuration", () => {
  it("validates SAR_HOME and finds the CLI", () => {
    expect(checkSarInstallation(home)).toMatchObject({ ok: true, cli: join(home, "app", "cli.mjs") });
    expect(checkSarInstallation(null)).toMatchObject({ ok: false, reason: expect.stringMatching(/set SAR_HOME/) });
    expect(checkSarInstallation(join(dir, "nope"))).toMatchObject({ ok: false, reason: expect.stringMatching(/does not point to a folder/) });
    unlinkSync(join(home, "extension", "dist", "extension-id.txt"));
    expect(checkSarInstallation(home)).toMatchObject({ ok: false, reason: expect.stringMatching(/build:extension/) });
    rmSync(join(home, "node_modules"), { recursive: true });
    expect(checkSarInstallation(home)).toMatchObject({ ok: false, reason: expect.stringMatching(/npm ci/) });
    writeFileSync(join(home, "package.json"), JSON.stringify({ name: "something-else" }));
    expect(checkSarInstallation(home)).toMatchObject({ ok: false, reason: expect.stringMatching(/not the SaveAllResources/) });
    unlinkSync(join(home, "app", "cli.mjs"));
    expect(checkSarInstallation(home)).toMatchObject({ ok: false, reason: expect.stringMatching(/no app\/cli\.mjs/) });
  });

  it("uses SAR_HOME when set; a sibling checkout only in development", () => {
    const cwd = join(dir, "Web");
    mkdirSync(cwd);
    makeStubSarHome(join(dir, "SaveAllResources"));
    expect(resolveSarHome({ SAR_HOME: "/opt/sar", NODE_ENV: "production" }, cwd)).toBe("/opt/sar");
    expect(resolveSarHome({ NODE_ENV: "development" }, cwd)).toBe(join(dir, "SaveAllResources"));
    expect(resolveSarHome({ NODE_ENV: "production" }, cwd)).toBeNull();
    expect(resolveSarHome({ NODE_ENV: "test" }, cwd)).toBeNull();
  });

  it("reads progress defensively and never invents numbers", () => {
    expect(parseSarJob({ jobId: "job_1234abcd", status: "capturing", capture: { progress: { discovered: 9, captured: 2, failed: 1, pending: 6 } } })).toEqual({
      sarJobId: "job_1234abcd",
      status: "capturing",
      stage: "capturing",
      pages: { discovered: 9, captured: 2, failed: 1, pending: 6 },
    });
    expect(parseSarJob({ status: "templatising", capture: { progress: { discovered: "9" } } })).toMatchObject({ stage: "templatising", pages: null });
    expect(parseSarJob({ status: "something-new" })).toMatchObject({ stage: null, pages: null });
    expect(parseSarJob(null)).toEqual({ sarJobId: null, status: null, stage: null, pages: null });
    expect(parseSarJob({ jobId: "../../etc", status: "completed" })).toMatchObject({ sarJobId: null, stage: "finishing" });
  });
});

describe("running SaveAllResources", () => {
  it("success: progress stages, then the exact ZIP it wrote", async () => {
    const r = runner();
    const { runId, started, exited, progress } = run(r, "http://ok.test/");
    expect((await started).pid).toBeGreaterThan(0);
    expect(r.isRunning(runId)).toBe(true);
    const o = await exited;
    expect(o.kind).toBe("succeeded");
    if (o.kind !== "succeeded") return;
    const fixture = readFileSync(join(home, "fixture.zip"));
    expect(o.zipSha256).toBe(createHash("sha256").update(fixture).digest("hex"));
    expect(o.zipBytes).toBe(fixture.byteLength);
    expect(o.sarJobId).toMatch(/^job_stub_/);
    expect(progress.map((p) => p.stage)).toContain("capturing");
    expect(progress.at(-1)).toMatchObject({ stage: "finishing", pages: { discovered: 2, captured: 2 } });
    expect(r.isRunning(runId)).toBe(false);
    expect(readFileSync(join(runs, runId, "sar.log"), "utf8")).toMatch(/Status: completed/);
  });

  it("passes the URL as a plain argument with a clean environment (no PORT, no Web secrets)", async () => {
    process.env.PORT = "3000";
    process.env.SAR_EXTENSION_ID = "should-not-leak";
    const r = runner();
    const { runId, exited } = run(r, "http://env.test/");
    await exited;
    const keys = JSON.parse(readFileSync(join(runs, runId, "out", "env.json"), "utf8")) as string[];
    expect(keys).toContain("SAR_DATA_DIR");
    expect(keys).not.toContain("PORT");
    expect(keys).not.toContain("SAR_EXTENSION_ID");
    delete process.env.PORT;
    delete process.env.SAR_EXTENSION_ID;
    await expect(r.start({ runId: rid(), url: "javascript:alert(1)", options: opts }, { onProgress: () => {}, onExit: () => {} })).rejects.toMatchObject({ code: "invalid" });
    await expect(r.start({ runId: "../escape", url: "http://ok.test/", options: opts }, { onProgress: () => {}, onExit: () => {} })).rejects.toBeInstanceOf(RunnerError);
  });

  it("failed exit and missing ZIP are failures, with a reason and no paths", async () => {
    const f = await run(runner(), "http://fail.test/").exited;
    expect(f).toMatchObject({ kind: "failed", code: "sar_failed" });
    expect(f.kind === "failed" && f.message).toMatch(/exit 1.*navigation to the site failed/);
    expect(f.kind === "failed" && f.message).not.toMatch(/\/Users\/|\/tmp\/|scl-sar-runner/);
    expect(await run(runner(), "http://nozip.test/").exited).toMatchObject({ kind: "failed", code: "missing_zip" });
  });

  it("cancels with SaveAllResources' graceful SIGINT and reports only after the process ended", async () => {
    const r = runner();
    const { runId, started, exited } = run(r, "http://slow.test/");
    await started;
    await new Promise((res) => setTimeout(res, 150));
    expect(r.cancel(runId)).toBe(true);
    expect(r.isRunning(runId)).toBe(true); // still stopping
    expect(await exited).toMatchObject({ kind: "cancelled" });
    expect(r.isRunning(runId)).toBe(false);
    expect(r.cancel(runId)).toBe(false);
  });

  it("times out: interrupts, then kills a process that ignores the interrupt", async () => {
    const r = runner({ timeoutMs: () => 200, killGraceMs: 200 });
    const o = await run(r, "http://hang.test/").exited;
    expect(o).toMatchObject({ kind: "failed", code: "timeout" });
  });

  it("runs one SaveAllResources at a time, and refuses when port 4100 is taken outside Web", async () => {
    const r = runner();
    const a = run(r, "http://slow.test/");
    await a.started;
    await expect(r.start({ runId: rid(), url: "http://ok.test/", options: opts }, { onProgress: () => {}, onExit: () => {} })).rejects.toMatchObject({ code: "busy" });
    r.cancel(a.runId);
    await a.exited;
    const blocked = runner({ portInUse: async () => true });
    await expect(blocked.start({ runId: rid(), url: "http://ok.test/", options: opts }, { onProgress: () => {}, onExit: () => {} })).rejects.toMatchObject({ code: "busy", message: expect.stringMatching(/port 4100/) });
  });

  it("after a restart: follows a still-running process, and refuses a dead or foreign pid", async () => {
    const r = runner();
    const runId = rid();
    expect(r.reattach(runId, 999_999, { onProgress: () => {}, onExit: () => {} })).toBe(false);
    // A run started by an earlier Web process: same command line, not our child.
    const out = join(runs, runId, "out");
    mkdirSync(join(runs, runId, "sar-data"), { recursive: true });
    const child = spawn(process.execPath, [join(home, "app", "cli.mjs"), "http://ok.test/", "--max-pages", "2", "--out", out], { env: { ...process.env, SAR_DATA_DIR: join(runs, runId, "sar-data") }, stdio: "ignore" });
    await new Promise((res) => child.once("spawn", res));
    let resolveExit: (o: RunOutcome) => void;
    const exited = new Promise<RunOutcome>((res) => (resolveExit = res));
    expect(r.reattach(runId, child.pid!, { onProgress: () => {}, onExit: (o) => resolveExit(o) })).toBe(true);
    expect(await exited).toMatchObject({ kind: "succeeded" });
    // A live process that is not this run's command is not adopted.
    expect(r.reattach(rid(), process.pid, { onProgress: () => {}, onExit: () => {} })).toBe(false);
  });

  it("cleans up: working data after success, whole run folders after retention", async () => {
    const r = runner();
    const { runId, exited } = run(r, "http://ok.test/");
    await exited;
    r.discardWorkingData(runId);
    expect(existsSync(join(runs, runId, "sar-data"))).toBe(false);
    expect(existsSync(join(runs, runId, "sar.log"))).toBe(true);
    const old = Date.now() / 1000 - 30 * 86400;
    utimesSync(join(runs, runId), old, old);
    expect(r.prune(new Set([runId]), 7 * 86400_000)).toBe(0); // kept on request
    expect(r.prune(new Set(), 7 * 86400_000)).toBe(1);
    expect(existsSync(join(runs, runId))).toBe(false);
  });

  it("is unavailable, with the reason, when the installation is not usable", async () => {
    const r = createLocalRunner({ home: join(dir, "missing"), runsDir: runs });
    expect(r.availability()).toMatchObject({ ok: false });
    await expect(r.start({ runId: rid(), url: "http://ok.test/", options: opts }, { onProgress: () => {}, onExit: () => {} })).rejects.toMatchObject({ code: "unavailable" });
  });
});
