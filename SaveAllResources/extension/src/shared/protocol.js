// Messaging protocol between the application page and the automation build of Save All Resources.
// Pure module: bundled into the extension and imported by the app-side client and Node tests.

export const PROTOCOL_VERSION = 1;

export const MESSAGE_TYPES = ['ping', 'startCapture', 'getStatus', 'cancel', 'getResult', 'retryUploads'];

export const TERMINAL_STATUSES = ['completed', 'completed_with_warnings', 'failed', 'cancelled'];

export const ERROR_CODES = {
  UNAUTHORIZED_ORIGIN: 'UNAUTHORIZED_ORIGIN',
  INVALID_MESSAGE: 'INVALID_MESSAGE',
  INVALID_UPLOAD_DESTINATION: 'INVALID_UPLOAD_DESTINATION',
  UNKNOWN_JOB: 'UNKNOWN_JOB',
  DUPLICATE_JOB: 'DUPLICATE_JOB',
  EXTENSION_BUSY: 'EXTENSION_BUSY',
  EXTENSION_UNAVAILABLE: 'EXTENSION_UNAVAILABLE',
  TIMEOUT: 'TIMEOUT',
  INTERNAL: 'INTERNAL',
};

export const OPTION_LIMITS = {
  maxPages: [1, 500, 25],
  maxDepth: [0, 10, 3],
  maxDurationMs: [10_000, 6 * 3600_000, 20 * 60_000],
  maxTotalBytes: [1_000_000, 4_000_000_000, 300_000_000],
  maxResourceBytes: [10_000, 500_000_000, 25_000_000],
  maxMediaBytes: [0, 500_000_000, 8_000_000],
  pageLoadTimeoutMs: [2_000, 180_000, 30_000],
  networkIdleMs: [100, 10_000, 800],
  maxRetries: [0, 5, 1],
  maxScrollSteps: [0, 200, 40],
  scrollDelayMs: [50, 5_000, 250],
  maxScreenshotHeight: [500, 30_000, 8_000],
  maxQueryParams: [0, 20, 3],
  maxQueryVariantsPerPath: [1, 100, 3],
  maxUrlsPerPattern: [1, 1000, 25],
  maxSitemapUrls: [0, 50_000, 2_000],
};

export const BOOLEAN_OPTIONS = {
  useSitemaps: true,
  respectRobots: true,
  hashRoutes: true,
  screenshots: true,
  mobileScreenshots: true,
  includeApiResponses: false,
  beautifyFile: false,
  ignoreNoContentFile: false,
};

export const VIEWPORTS = {
  desktop: { width: 1366, height: 900, deviceScaleFactor: 1, mobile: false },
  mobile: { width: 390, height: 844, deviceScaleFactor: 1, mobile: true },
};

const JOB_ID = /^[A-Za-z0-9_-]{8,64}$/;
const SAFE_SELECTOR = /^[^<>{}]{1,300}$/;

export class ProtocolError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function fail(message, code = ERROR_CODES.INVALID_MESSAGE) {
  throw new ProtocolError(code, message);
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

export function validateJobId(jobId) {
  if (typeof jobId !== 'string' || !JOB_ID.test(jobId)) fail('jobId must match ' + JOB_ID);
  return jobId;
}

export function validateHttpUrl(value, field = 'url') {
  if (typeof value !== 'string' || value.length > 2048) fail(`${field} must be a string up to 2048 characters`);
  let u;
  try {
    u = new URL(value);
  } catch {
    fail(`${field} is not an absolute URL`);
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') fail(`${field} must use http or https`);
  if (u.username || u.password) fail(`${field} must not contain credentials`);
  return u.toString();
}

/** Normalise and bound capture options. Unknown keys are rejected so typos are not silently ignored. */
export function normalizeOptions(raw = {}) {
  if (!isPlainObject(raw)) fail('options must be an object');
  const out = {};
  for (const [key, [min, max, def]] of Object.entries(OPTION_LIMITS)) {
    const v = raw[key];
    if (v === undefined) out[key] = def;
    else if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) fail(`options.${key} must be a number in [${min}, ${max}]`);
    else out[key] = Math.floor(v);
  }
  for (const [key, def] of Object.entries(BOOLEAN_OPTIONS)) {
    const v = raw[key];
    if (v === undefined) out[key] = def;
    else if (typeof v !== 'boolean') fail(`options.${key} must be a boolean`);
    else out[key] = v;
  }
  const allowedOrigins = raw.allowedOrigins ?? [];
  if (!Array.isArray(allowedOrigins) || allowedOrigins.length > 20) fail('options.allowedOrigins must be an array (max 20)');
  out.allowedOrigins = allowedOrigins.map((o, i) => new URL(validateHttpUrl(o, `options.allowedOrigins[${i}]`)).origin);

  const recipes = raw.interactionRecipes ?? [];
  if (!Array.isArray(recipes) || recipes.length > 50) fail('options.interactionRecipes must be an array (max 50)');
  out.interactionRecipes = recipes.map((r, i) => {
    if (!isPlainObject(r)) fail(`interactionRecipes[${i}] must be an object`);
    if (!['click', 'hover', 'focus'].includes(r.action)) fail(`interactionRecipes[${i}].action must be click, hover or focus`);
    if (typeof r.selector !== 'string' || !SAFE_SELECTOR.test(r.selector)) fail(`interactionRecipes[${i}].selector is invalid`);
    const urlPattern = r.urlPattern ?? '';
    if (typeof urlPattern !== 'string' || urlPattern.length > 300) fail(`interactionRecipes[${i}].urlPattern is invalid`);
    try {
      new RegExp(urlPattern);
    } catch {
      fail(`interactionRecipes[${i}].urlPattern is not a valid regular expression`);
    }
    const waitMs = r.waitMs ?? 400;
    if (typeof waitMs !== 'number' || waitMs < 0 || waitMs > 10_000) fail(`interactionRecipes[${i}].waitMs must be 0..10000`);
    return { action: r.action, selector: r.selector, urlPattern, waitMs, revealLinks: r.revealLinks !== false };
  });

  const known = new Set([...Object.keys(OPTION_LIMITS), ...Object.keys(BOOLEAN_OPTIONS), 'allowedOrigins', 'interactionRecipes']);
  for (const key of Object.keys(raw)) if (!known.has(key)) fail(`options.${key} is not a supported option`);
  return out;
}

/**
 * Validate an upload descriptor. The destination origin must be configured in the extension build
 * and the endpoint path must be scoped to the job.
 */
export function validateUpload(upload, jobId, allowedUploadOrigins, now = Date.now()) {
  if (!isPlainObject(upload)) fail('upload must be an object');
  const endpoint = validateHttpUrl(upload.endpoint, 'upload.endpoint');
  const u = new URL(endpoint);
  if (!allowedUploadOrigins.includes(u.origin)) {
    fail(`upload origin ${u.origin} is not configured in the extension`, ERROR_CODES.INVALID_UPLOAD_DESTINATION);
  }
  if (u.search || u.hash) fail('upload.endpoint must not contain query or fragment', ERROR_CODES.INVALID_UPLOAD_DESTINATION);
  if (!u.pathname.split('/').includes(jobId)) fail('upload.endpoint must be scoped to the job id', ERROR_CODES.INVALID_UPLOAD_DESTINATION);
  if (typeof upload.token !== 'string' || upload.token.length < 16 || upload.token.length > 4096 || /\s/.test(upload.token)) {
    fail('upload.token is invalid');
  }
  const expiresAt = upload.expiresAt;
  if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt)) fail('upload.expiresAt must be a timestamp (ms)');
  if (expiresAt <= now) fail('upload token has expired', ERROR_CODES.INVALID_UPLOAD_DESTINATION);
  return { endpoint: endpoint.replace(/\/$/, ''), token: upload.token, expiresAt };
}

export function validateSenderOrigin(sender, allowedAppOrigins) {
  const origin = sender?.origin || (sender?.url ? new URL(sender.url).origin : null);
  if (!origin || !allowedAppOrigins.includes(origin)) {
    throw new ProtocolError(ERROR_CODES.UNAUTHORIZED_ORIGIN, `origin ${origin || '(unknown)'} is not allowed to control captures`);
  }
  return origin;
}

/** Validate an incoming message (after the sender has been validated). */
export function validateMessage(msg, { allowedUploadOrigins = [], now = Date.now() } = {}) {
  if (!isPlainObject(msg)) fail('message must be an object');
  if (msg.v !== PROTOCOL_VERSION) fail(`unsupported protocol version ${msg.v}`);
  if (!MESSAGE_TYPES.includes(msg.type)) fail(`unknown message type ${msg.type}`);
  if (JSON.stringify(msg).length > 64_000) fail('message too large');
  switch (msg.type) {
    case 'ping':
      return { v: 1, type: 'ping' };
    case 'startCapture': {
      const jobId = validateJobId(msg.jobId);
      return {
        v: 1,
        type: 'startCapture',
        jobId,
        url: validateHttpUrl(msg.url),
        options: normalizeOptions(msg.options ?? {}),
        upload: validateUpload(msg.upload, jobId, allowedUploadOrigins, now),
      };
    }
    default:
      return { v: 1, type: msg.type, jobId: validateJobId(msg.jobId) };
  }
}

export function okResponse(data = {}) {
  return { ok: true, ...data };
}

export function errorResponse(err) {
  return {
    ok: false,
    error: { code: err?.code || ERROR_CODES.INTERNAL, message: String(err?.message || err) },
  };
}
