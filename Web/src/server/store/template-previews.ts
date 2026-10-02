import type { DatabaseSync } from "node:sqlite";
import { now, type Row } from "./errors";

// Registry of live preview processes (migration 11). Rows only; the process
// management is src/server/preview/preview-manager.ts.

export type PreviewRow = { jobId: string; projectId: string; pid: number | null; port: number | null; status: "stopped" | "running"; startedAt: string | null; lastSeenAt: string | null; error: string | null };

const toRow = (r: Row): PreviewRow => ({
  jobId: String(r.job_id),
  projectId: String(r.project_id),
  pid: r.pid == null ? null : Number(r.pid),
  port: r.port == null ? null : Number(r.port),
  status: r.status as PreviewRow["status"],
  startedAt: (r.started_at as string | null) ?? null,
  lastSeenAt: (r.last_seen_at as string | null) ?? null,
  error: (r.error as string | null) ?? null,
});

export function createTemplatePreviewStore(db: DatabaseSync) {
  return {
    get: (jobId: string): PreviewRow | null => {
      const r = db.prepare("select * from template_previews where job_id = ?").get(jobId) as Row | undefined;
      return r ? toRow(r) : null;
    },
    running: (): PreviewRow[] => (db.prepare("select * from template_previews where status = 'running'").all() as Row[]).map(toRow),
    usedPorts: (): Set<number> => new Set((db.prepare("select port from template_previews where port is not null").all() as Row[]).map((r) => Number(r.port))),
    markRunning(jobId: string, projectId: string, pid: number, port: number) {
      const at = now();
      db.prepare(
        "insert into template_previews (job_id, project_id, pid, port, status, started_at, last_seen_at, error, updated_at) values (?, ?, ?, ?, 'running', ?, ?, null, ?) on conflict (job_id) do update set pid = excluded.pid, port = excluded.port, status = 'running', started_at = excluded.started_at, last_seen_at = excluded.last_seen_at, error = null, updated_at = excluded.updated_at",
      ).run(jobId, projectId, pid, port, at, at, at);
    },
    markStopped(jobId: string, error: string | null = null) {
      db.prepare("update template_previews set status = 'stopped', pid = null, port = null, error = ?, updated_at = ? where job_id = ?").run(error, now(), jobId);
    },
    touch(jobId: string) {
      db.prepare("update template_previews set last_seen_at = ?, updated_at = ? where job_id = ?").run(now(), now(), jobId);
    },
  };
}

export type TemplatePreviewStore = ReturnType<typeof createTemplatePreviewStore>;
