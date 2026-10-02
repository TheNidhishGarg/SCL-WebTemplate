import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

// WF-01 persistence: Node's built-in SQLite, so local development needs no
// database server and no extra dependency. The SQL is kept portable (text ids,
// ISO timestamps, JSON in text columns, CHECK constraints) so the same schema
// moves to Postgres when a hosted database is chosen - see docs/wf-01.md.
//
// Migrations are append-only. Never edit one that has shipped; add the next.
const MIGRATIONS: string[] = [
  `
  create table projects (
    id text primary key,
    slug text not null unique,
    name text not null,
    client_name text not null,
    dashboard_client_id text,
    status text not null check (status in ('active', 'archived')),
    created_at text not null,
    updated_at text not null
  );

  create table client_briefs (
    id text primary key,
    project_id text not null references projects(id) on delete cascade,
    version integer not null check (version >= 1),
    status text not null check (status in ('draft', 'pending_approval', 'approved', 'superseded')),
    draft text not null,
    content text,
    created_at text not null,
    updated_at text not null,
    approved_at text,
    unique (project_id, version),
    check ((status = 'approved') = (approved_at is not null) or status = 'superseded'),
    check (status = 'draft' or content is not null)
  );
  -- At most one editable draft and one current approved brief per project.
  create unique index client_briefs_one_draft on client_briefs(project_id) where status = 'draft';
  create unique index client_briefs_one_approved on client_briefs(project_id) where status = 'approved';

  create table assets (
    id text primary key,
    project_id text not null references projects(id) on delete cascade,
    kind text not null check (kind in ('logo', 'font', 'brand_guidelines', 'photography', 'video', 'other')),
    label text not null,
    notes text not null,
    source_type text not null check (source_type in ('url', 'upload')),
    url text,
    storage_key text,
    filename text,
    mime_type text,
    size_bytes integer,
    sha256 text,
    created_at text not null,
    check ((source_type = 'url') = (url is not null)),
    check ((source_type = 'upload') = (storage_key is not null and filename is not null
      and mime_type is not null and size_bytes is not null and sha256 is not null))
  );
  create index assets_project on assets(project_id, created_at);

  create table activity (
    id text primary key,
    project_id text not null references projects(id) on delete cascade,
    kind text not null,
    summary text not null,
    created_at text not null
  );
  create index activity_recent on activity(created_at desc);
  create index activity_project on activity(project_id, created_at desc);
  `,
  // WF-02 reference library.
  `
  create table reference_sources (
    id text primary key,
    project_id text not null references projects(id) on delete cascade,
    url text not null,
    host text not null,
    label text not null,
    page_type text not null,
    target_pages text not null,
    attribution text not null,
    origin text not null check (origin in ('brief', 'user')),
    brief_version integer,
    manual_reason text,
    created_at text not null,
    updated_at text not null,
    unique (project_id, url),
    check ((origin = 'brief') = (brief_version is not null))
  );

  -- Append-only: an attempt is a record of what happened, so it is never edited.
  create table reference_attempts (
    id text primary key,
    reference_id text not null references reference_sources(id) on delete cascade,
    method text not null check (method in ('url_check', 'manual_capture')),
    recorded_by text not null check (recorded_by in ('system', 'user')),
    outcome text not null check (outcome in ('reachable', 'captured', 'redirect_loop', 'access_restricted', 'not_found',
      'rate_limited', 'server_error', 'http_error', 'unreachable', 'blocked_by_policy', 'capture_failed')),
    http_status integer,
    final_url text,
    redirect_chain text not null,
    page_title text,
    content_type text,
    detail text not null,
    inferences text not null,
    created_at text not null,
    check (method = 'manual_capture' or recorded_by = 'system')
  );
  create index reference_attempts_ref on reference_attempts(reference_id, created_at desc);

  create table reference_captures (
    id text primary key,
    reference_id text not null references reference_sources(id) on delete cascade,
    kind text not null check (kind in ('archive', 'screenshot', 'other')),
    tool text not null,
    source_url text not null,
    captured_on text not null,
    notes text not null,
    storage_key text not null,
    filename text not null,
    mime_type text not null,
    size_bytes integer not null check (size_bytes > 0),
    sha256 text not null,
    created_at text not null
  );
  create index reference_captures_ref on reference_captures(reference_id, created_at);

  create table reference_observations (
    id text primary key,
    reference_id text not null references reference_sources(id) on delete cascade,
    aspect text not null check (aspect in ('section', 'interaction', 'layout', 'visual_style', 'content_pattern', 'other')),
    basis text not null check (basis in ('observed', 'inferred')),
    text text not null,
    capture_id text references reference_captures(id) on delete set null,
    created_at text not null,
    updated_at text not null
  );
  create index reference_observations_ref on reference_observations(reference_id, created_at);
  `,
  // WF-03 source analysis and template extraction.
  `
  create table wf03_sources (
    id text primary key,
    project_id text not null references projects(id) on delete cascade,
    label text not null,
    origin text not null check (origin in ('upload', 'reference_capture')),
    origin_url text not null,
    origin_ref text not null,
    reference_id text,
    capture_id text,
    auth_basis text not null check (auth_basis in ('client_owned', 'licensed', 'written_permission', 'study_only')),
    auth_note text not null,
    auth_license text not null,
    storage_key text not null,
    filename text not null,
    size_bytes integer not null,
    sha256 text not null,
    created_at text not null,
    updated_at text not null,
    unique (project_id, sha256),
    check (auth_basis = 'study_only' or auth_note <> ''),
    check ((origin = 'reference_capture') = (capture_id is not null))
  );

  -- One row per run. The result is the scanner's report, byte for byte; the
  -- digest lets anyone confirm a later run reproduced it.
  create table wf03_scans (
    id text primary key,
    source_id text not null references wf03_sources(id) on delete cascade,
    analyzer_version text not null,
    input_sha256 text not null,
    digest text not null,
    result text not null,
    created_at text not null
  );
  create index wf03_scans_source on wf03_scans(source_id, created_at desc);

  create table wf03_templates (
    id text primary key,
    project_id text not null references projects(id) on delete cascade,
    source_id text not null references wf03_sources(id) on delete cascade,
    scan_id text not null references wf03_scans(id),
    candidate_key text,
    kind text not null check (kind in ('page_template', 'layout', 'navigation', 'section', 'component', 'interaction')),
    name text not null,
    slug text not null,
    description text not null,
    basis text not null check (basis in ('observed', 'inferred')),
    rationale text not null,
    origin text not null check (origin in ('scanner', 'person', 'analysis_kit')),
    files text not null,
    pages text not null,
    evidence text not null,
    extraction_status text not null check (extraction_status in ('not_extracted', 'extracted')),
    workspace_path text,
    extracted_at text,
    build_status text not null check (build_status in ('not_applicable', 'not_verified', 'passed', 'failed')),
    build_note text not null,
    build_recorded_at text,
    created_at text not null,
    updated_at text not null,
    unique (project_id, slug),
    check ((extraction_status = 'extracted') = (workspace_path is not null and extracted_at is not null))
  );
  create unique index wf03_templates_candidate on wf03_templates(source_id, candidate_key) where candidate_key is not null;

  create table wf03_findings (
    id text primary key,
    source_id text not null references wf03_sources(id) on delete cascade,
    basis text not null check (basis in ('fact', 'assumption')),
    topic text not null,
    statement text not null,
    evidence text not null,
    origin text not null check (origin in ('person', 'analysis_kit')),
    created_at text not null
  );

  create table wf03_questions (
    id text primary key,
    source_id text not null references wf03_sources(id) on delete cascade,
    key text,
    topic text not null,
    text text not null,
    origin text not null check (origin in ('analyzer', 'person', 'analysis_kit')),
    status text not null check (status in ('open', 'resolved')),
    answer text not null,
    created_at text not null,
    resolved_at text,
    check ((status = 'resolved') = (resolved_at is not null and answer <> ''))
  );
  create unique index wf03_questions_key on wf03_questions(source_id, key) where key is not null;
  `,
  // WF-04 brand configurations. Several brands per project; each versioned
  // like the brief: one editable draft, one approved, the rest superseded.
  `
  create table brands (
    id text primary key,
    project_id text not null references projects(id) on delete cascade,
    key text not null,
    name text not null,
    created_at text not null,
    updated_at text not null,
    unique (project_id, key)
  );
  create table brand_versions (
    id text primary key,
    brand_id text not null references brands(id) on delete cascade,
    version integer not null check (version >= 1),
    status text not null check (status in ('draft', 'approved', 'superseded')),
    content text not null,
    created_at text not null,
    updated_at text not null,
    approved_at text,
    unique (brand_id, version),
    check ((status = 'approved') = (approved_at is not null) or status = 'superseded')
  );
  create unique index brand_versions_one_draft on brand_versions(brand_id) where status = 'draft';
  create unique index brand_versions_one_approved on brand_versions(brand_id) where status = 'approved';
  `,
  // WF-05 content: site settings, pages (with a frozen published snapshot)
  // and reusable blocks.
  `
  create table sites (
    project_id text primary key references projects(id) on delete cascade,
    site_name text not null,
    base_url text not null,
    brand_id text references brands(id) on delete set null,
    locale text not null,
    updated_at text not null
  );
  create table pages (
    id text primary key,
    project_id text not null references projects(id) on delete cascade,
    slug text not null,
    position integer not null,
    content text not null,
    status text not null check (status in ('draft', 'in_review', 'approved', 'published')),
    origin text not null check (origin in ('generated', 'person')),
    revision integer not null check (revision >= 1),
    published_content text,
    published_revision integer,
    published_at text,
    created_at text not null,
    updated_at text not null,
    unique (project_id, slug),
    check ((published_content is null) = (published_at is null))
  );
  create table content_blocks (
    id text primary key,
    project_id text not null references projects(id) on delete cascade,
    name text not null,
    section text not null,
    created_at text not null,
    updated_at text not null
  );
  `,
  // WF-06 cinematic journeys, versioned like brands.
  `
  create table journeys (
    id text primary key,
    project_id text not null references projects(id) on delete cascade,
    key text not null,
    name text not null,
    created_at text not null,
    updated_at text not null,
    unique (project_id, key)
  );
  create table journey_versions (
    id text primary key,
    journey_id text not null references journeys(id) on delete cascade,
    version integer not null check (version >= 1),
    status text not null check (status in ('draft', 'approved', 'superseded')),
    content text not null,
    created_at text not null,
    updated_at text not null,
    approved_at text,
    unique (journey_id, version),
    check ((status = 'approved') = (approved_at is not null) or status = 'superseded')
  );
  create unique index journey_versions_one_draft on journey_versions(journey_id) where status = 'draft';
  create unique index journey_versions_one_approved on journey_versions(journey_id) where status = 'approved';
  `,
  // WF-07 production: one production per approved journey version.
  `
  create table productions (
    id text primary key,
    project_id text not null references projects(id) on delete cascade,
    journey_id text not null references journeys(id) on delete cascade,
    journey_version integer not null,
    manifest text not null,
    created_at text not null,
    unique (journey_id, journey_version)
  );
  create table production_shots (
    production_id text not null references productions(id) on delete cascade,
    slot_id text not null,
    scene_id text not null,
    blocked_reason text,
    approved_take_id text,
    primary key (production_id, slot_id),
    check (blocked_reason is null or approved_take_id is null)
  );
  create table production_prompts (
    id text primary key,
    production_id text not null references productions(id) on delete cascade,
    slot_id text not null,
    version integer not null,
    positive text not null,
    negative text not null,
    note text not null,
    created_at text not null,
    unique (production_id, slot_id, version)
  );
  create table production_jobs (
    id text primary key,
    production_id text not null references productions(id) on delete cascade,
    slot_id text not null,
    provider text not null check (provider in ('runway', 'veo')),
    model text not null,
    prompt_version integer not null,
    request text not null,
    idempotency_key text not null,
    status text not null check (status in ('queued', 'generating', 'completed', 'failed', 'canceled')),
    provider_job_id text,
    attempts integer not null,
    error_code text,
    error_message text,
    retryable integer not null default 0,
    take_id text,
    created_at text not null,
    updated_at text not null,
    completed_at text,
    check ((status = 'completed') = (take_id is not null))
  );
  -- Duplicate control: one active job per shot and provider.
  create unique index production_jobs_one_active on production_jobs(production_id, slot_id, provider) where status in ('queued', 'generating');
  create table production_takes (
    id text primary key,
    production_id text not null references productions(id) on delete cascade,
    slot_id text not null,
    job_id text,
    source text not null check (source in ('provider', 'manual_upload')),
    provider text not null,
    model text,
    prompt_version integer,
    tool text not null,
    storage_key text not null,
    filename text not null,
    mime_type text not null,
    size_bytes integer not null check (size_bytes > 0),
    sha256 text not null,
    container text not null,
    duration_seconds real,
    width integer,
    height integer,
    checks text not null,
    review text not null check (review in ('review_required', 'approved', 'superseded', 'rejected')),
    review_note text not null,
    confirmations text not null,
    reviewed_at text,
    created_at text not null
  );
  `,
  // 8: WF-08 journey releases. A release is a frozen, validated journey bundle
  // (scl.wf-08.journey-bundle/v1); the site plays the newest one not withdrawn.
  `
  create table journey_releases (
    id text primary key,
    project_id text not null references projects(id) on delete cascade,
    journey_id text not null references journeys(id) on delete cascade,
    number integer not null,
    journey_version integer not null,
    production_id text references productions(id) on delete set null,
    bundle text not null,
    created_at text not null,
    withdrawn_at text,
    unique (journey_id, number)
  );
  `,
  // 9: SaveAllResources capture jobs (WF-02). The extension uploads page
  // packages for one job with a short-lived token; only its hash is stored,
  // and it is revoked when the job ends.
  `
  create table sar_capture_jobs (
    id text primary key,
    project_id text not null references projects(id) on delete cascade,
    reference_id text not null references reference_sources(id) on delete cascade,
    url text not null,
    options text not null,
    status text not null check (status in ('awaiting_extension', 'capturing', 'completed', 'completed_with_warnings', 'failed', 'cancelled')),
    token_hash text,
    token_expires_at integer not null,
    cancel_requested integer not null default 0,
    progress text,
    error text,
    warnings text not null default '[]',
    capture_id text,
    source_id text,
    created_at text not null,
    updated_at text not null
  );
  create index sar_capture_jobs_project on sar_capture_jobs (project_id, created_at);
  create table sar_capture_pages (
    job_id text not null references sar_capture_jobs(id) on delete cascade,
    page_id text not null,
    storage_key text not null,
    size_bytes integer not null,
    sha256 text not null,
    received_at text not null,
    primary key (job_id, page_id)
  );
  `,
  // 10: website-template generation jobs: URL -> SaveAllResources (separate
  // process) -> website-template.zip -> WF-02 -> WF-03 -> WF-04/WF-05 gates.
  // run_lock is set while SaveAllResources runs; it is unique, so at most one
  // run exists at a time (the program owns a fixed port).
  `
  create table template_jobs (
    id text primary key,
    project_id text not null references projects(id) on delete cascade,
    source_url text not null,
    authority text not null check (authority in ('study_only', 'client_owned')),
    authorized_by text not null default '',
    options text not null,
    status text not null check (status in ('queued', 'running', 'waiting', 'completed', 'blocked', 'failed', 'cancelled')),
    stage text not null,
    stages text not null,
    progress text,
    run_lock text unique,
    sar_job_id text,
    pid integer,
    cancel_requested integer not null default 0,
    sar_output_sha256 text,
    artifact_key text,
    artifact_filename text,
    artifact_bytes integer,
    artifact_sha256 text,
    reference_id text,
    capture_id text,
    source_id text,
    scan_id text,
    scan_digest text,
    brand_id text,
    pages_generated integer not null default 0,
    error_code text,
    error_message text,
    created_at text not null,
    started_at text,
    completed_at text,
    cancelled_at text,
    updated_at text not null
  );
  create index template_jobs_project on template_jobs (project_id, created_at);
  `,
  // 11: live previews of generated templates (local development). One row per
  // template job: the preview process (pid, port) and when the dashboard last
  // looked at it, so abandoned processes can be found and stopped after a restart.
  `
  create table template_previews (
    job_id text primary key references template_jobs(id) on delete cascade,
    project_id text not null references projects(id) on delete cascade,
    pid integer,
    port integer unique,
    status text not null check (status in ('stopped', 'running')),
    started_at text,
    last_seen_at text,
    error text,
    updated_at text not null
  );
  `,
];

export function openDatabase(file: string): DatabaseSync {
  if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec("pragma journal_mode = wal; pragma foreign_keys = on; pragma busy_timeout = 5000;");
  migrate(db);
  return db;
}

function migrate(db: DatabaseSync) {
  db.exec("create table if not exists schema_migrations (version integer primary key, applied_at text not null)");
  const row = db.prepare("select coalesce(max(version), 0) as v from schema_migrations").get() as { v: number };
  for (let i = row.v; i < MIGRATIONS.length; i++) {
    db.exec("begin immediate");
    try {
      db.exec(MIGRATIONS[i]);
      db.prepare("insert into schema_migrations (version, applied_at) values (?, ?)").run(i + 1, new Date().toISOString());
      db.exec("commit");
    } catch (e) {
      db.exec("rollback");
      throw new Error(`Migration ${i + 1} failed: ${(e as Error).message}`);
    }
  }
}

export function transaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec("begin immediate");
  try {
    const result = fn();
    db.exec("commit");
    return result;
  } catch (e) {
    db.exec("rollback");
    throw e;
  }
}
