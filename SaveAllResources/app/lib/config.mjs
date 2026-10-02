import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

const DEFAULTS = {
  host: 'localhost',
  port: 4100,
  publicOrigin: null, // defaults to http://<host>:<port>
  dataDir: 'data',
  extensionId: null, // defaults to extension/dist/extension-id.txt
  uploadTokenTtlMs: 2 * 3600_000,
  launchCodeTtlMs: 10 * 60_000,
  maxUploadBytes: 600_000_000,
  verification: {
    enabled: true,
    headless: true,
    pageTimeoutMs: 30_000,
    maxPages: 50,
  },
};

/**
 * Configuration sources (later wins): defaults, app/config.json, environment.
 * Secrets (SAR_APP_API_TOKEN, SAR_UPLOAD_TOKEN_SECRET) come from the environment; when absent
 * they are generated once and stored in <dataDir>/secrets.json (local development only).
 */
export function loadConfig(overrides = {}) {
  const file = process.env.SAR_APP_CONFIG || join(ROOT, 'app/config.json');
  const fromFile = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  const env = {};
  if (process.env.PORT) env.port = Number(process.env.PORT);
  if (process.env.SAR_HOST) env.host = process.env.SAR_HOST;
  if (process.env.SAR_PUBLIC_ORIGIN) env.publicOrigin = process.env.SAR_PUBLIC_ORIGIN;
  if (process.env.SAR_DATA_DIR) env.dataDir = process.env.SAR_DATA_DIR;
  if (process.env.SAR_EXTENSION_ID) env.extensionId = process.env.SAR_EXTENSION_ID;
  const cfg = { ...DEFAULTS, ...fromFile, ...env, ...overrides, verification: { ...DEFAULTS.verification, ...fromFile.verification, ...overrides.verification } };
  cfg.dataDir = resolve(ROOT, cfg.dataDir);
  cfg.publicOrigin = (cfg.publicOrigin || `http://${cfg.host}:${cfg.port}`).replace(/\/$/, '');
  if (!cfg.extensionId) {
    const idFile = join(ROOT, 'extension/dist/extension-id.txt');
    cfg.extensionId = existsSync(idFile) ? readFileSync(idFile, 'utf8').trim() : null;
  }
  mkdirSync(cfg.dataDir, { recursive: true });
  const secretsFile = join(cfg.dataDir, 'secrets.json');
  let secrets = existsSync(secretsFile) ? JSON.parse(readFileSync(secretsFile, 'utf8')) : {};
  if (!process.env.SAR_APP_API_TOKEN && !secrets.appApiToken) secrets.appApiToken = randomBytes(24).toString('base64url');
  if (!process.env.SAR_UPLOAD_TOKEN_SECRET && !secrets.uploadTokenSecret) secrets.uploadTokenSecret = randomBytes(32).toString('base64url');
  mkdirSync(dirname(secretsFile), { recursive: true });
  writeFileSync(secretsFile, JSON.stringify(secrets, null, 2), { mode: 0o600 });
  cfg.appApiToken = overrides.appApiToken || process.env.SAR_APP_API_TOKEN || secrets.appApiToken;
  cfg.uploadTokenSecret = overrides.uploadTokenSecret || process.env.SAR_UPLOAD_TOKEN_SECRET || secrets.uploadTokenSecret;
  return cfg;
}
