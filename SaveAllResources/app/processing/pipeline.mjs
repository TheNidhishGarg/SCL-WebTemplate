// Processing pipeline (runs in a worker thread):
// Packaging -> Templatising -> Verifying -> export ZIP.
// Each stage is isolated: if templating or verification fails, the raw capture and everything
// produced so far is still exported, with the error recorded.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { packageCapture } from './package.mjs';
import { exportPackage } from './export.mjs';

export async function processJob({ jobDir, job, mode = 'full', verification = {}, onStage = () => {} }) {
  const workDir = join(jobDir, 'work');
  rmSync(workDir, { recursive: true, force: true });
  const outDir = join(workDir, 'website-template');
  mkdirSync(outDir, { recursive: true });
  const errors = [];
  const stages = {};
  const time = async (name, fn) => {
    const t = Date.now();
    try {
      const r = await fn();
      stages[name] = { status: 'ok', durationMs: Date.now() - t };
      return r;
    } catch (e) {
      stages[name] = { status: 'failed', durationMs: Date.now() - t, error: e.message };
      errors.push(`${name}: ${e.message}`);
      console.error(`[pipeline] ${name} failed`, e);
      return null;
    }
  };

  onStage('packaging', { stages });
  const packaged = await time('packaging', () => packageCapture({ jobDir, job, outDir }));
  if (!packaged) {
    return { status: 'failed', errors, stages, exportFile: null };
  }
  const { manifest } = packaged;

  let templ = null;
  let verify = null;
  if (mode === 'full') {
    onStage('templatising', { stages });
    const { templatiseSite } = await import('./templatise.mjs');
    templ = await time('templatising', () => templatiseSite({ outDir, manifest, job }));

    if (templ && verification.enabled !== false) {
      onStage('verifying', { stages });
      const { verifyTemplate } = await import('./verify.mjs');
      verify = await time('verifying', () => verifyTemplate({ outDir, manifest, templ, job, options: verification }));
    } else if (templ) {
      stages.verifying = { status: 'skipped', reason: 'verification disabled in configuration' };
    }
  }

  manifest.processing = { stages, errors, mode };
  const { buildReports } = await import('./report.mjs');
  const report = await time('reporting', () => buildReports({ outDir, manifest, templ, verify, job, errors, stages }));

  const exportFile = join(jobDir, `${job.jobId}-website-template.zip`);
  await time('export', () => exportPackage({ outDir, exportFile }));
  writeFileSync(join(jobDir, 'processing.json'), JSON.stringify({ stages, errors }, null, 2));

  let status;
  if (mode !== 'full') status = 'cancelled';
  else if (!templ) status = 'failed';
  else if (errors.length || report?.summary?.hasWarnings) status = 'completed_with_warnings';
  else status = 'completed';
  return { status, errors, stages, exportFile: stages.export?.status === 'ok' ? exportFile : null, summary: report?.summary || null };
}
