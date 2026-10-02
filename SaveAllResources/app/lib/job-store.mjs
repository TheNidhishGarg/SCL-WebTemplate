import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

export const SERVER_STATUSES = [
  'awaiting_extension',
  'capturing',
  'packaging',
  'templatising',
  'verifying',
  'completed',
  'completed_with_warnings',
  'failed',
  'cancelled',
];
export const TERMINAL = ['completed', 'completed_with_warnings', 'failed', 'cancelled'];

export function newJobId() {
  return 'job_' + new Date().toISOString().slice(0, 10).replace(/-/g, '') + '_' + randomBytes(6).toString('hex');
}

export class JobStore {
  constructor(dataDir) {
    this.root = join(dataDir, 'jobs');
    mkdirSync(this.root, { recursive: true });
  }

  dir(jobId) {
    if (!/^[A-Za-z0-9_-]{8,64}$/.test(jobId)) throw new Error('invalid job id');
    return join(this.root, jobId);
  }

  exists(jobId) {
    try {
      return existsSync(join(this.dir(jobId), 'job.json'));
    } catch {
      return false;
    }
  }

  get(jobId) {
    if (!this.exists(jobId)) return null;
    return JSON.parse(readFileSync(join(this.dir(jobId), 'job.json'), 'utf8'));
  }

  /** Atomic write (temp file + rename) so a crash never leaves a truncated job.json. */
  save(job) {
    job.updatedAt = Date.now();
    const dir = this.dir(job.jobId);
    mkdirSync(dir, { recursive: true });
    const tmp = join(dir, `job.json.${process.pid}.tmp`);
    writeFileSync(tmp, JSON.stringify(job, null, 2));
    renameSync(tmp, join(dir, 'job.json'));
    return job;
  }

  update(jobId, fn) {
    const job = this.get(jobId);
    if (!job) throw new Error(`unknown job ${jobId}`);
    fn(job);
    return this.save(job);
  }

  list() {
    return readdirSync(this.root)
      .filter((id) => this.exists(id))
      .map((id) => this.get(id));
  }
}
