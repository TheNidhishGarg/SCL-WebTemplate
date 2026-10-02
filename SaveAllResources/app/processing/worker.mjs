// Worker-thread entry: runs the processing pipeline for one job and reports stages to the server.
import { parentPort, workerData } from 'node:worker_threads';
import { JobStore } from '../lib/job-store.mjs';
import { processJob } from './pipeline.mjs';

const { jobId, mode, dataDir, verification } = workerData;
const store = new JobStore(dataDir);
const job = store.get(jobId);

const post = (status, processing = {}, final = false) => parentPort.postMessage({ type: 'stage', status, processing, final });

try {
  const result = await processJob({
    jobDir: store.dir(jobId),
    job,
    mode,
    verification,
    onStage: (stage, info) => post(stage, { currentStage: stage, ...info }),
  });
  store.update(jobId, (j) => {
    j.exportFile = result.exportFile;
    j.summary = result.summary;
    j.errors.push(...result.errors);
  });
  post(result.status, { currentStage: null, stages: result.stages, finishedAt: Date.now() }, true);
} catch (e) {
  store.update(jobId, (j) => j.errors.push(`processing failed: ${e.message}`));
  post('failed', { currentStage: null, finishedAt: Date.now() }, true);
}
