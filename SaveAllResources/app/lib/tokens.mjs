// Short-lived, job-scoped HMAC tokens.
// scope "upload": extension -> /api/capture-jobs/:id/*   scope "control": launch page -> status/cancel/export
import { createHmac, timingSafeEqual } from 'node:crypto';

const b64 = (buf) => Buffer.from(buf).toString('base64url');

export function signToken(secret, { jobId, scope, ttlMs }) {
  const payload = b64(JSON.stringify({ jid: jobId, scp: scope, exp: Date.now() + ttlMs }));
  const sig = b64(createHmac('sha256', secret).update(payload).digest());
  return { token: `${payload}.${sig}`, expiresAt: JSON.parse(Buffer.from(payload, 'base64url')).exp };
}

export function verifyToken(secret, token, { jobId, scope }) {
  if (typeof token !== 'string' || !token.includes('.')) return false;
  const [payload, sig] = token.split('.');
  const expected = b64(createHmac('sha256', secret).update(payload).digest());
  const a = Buffer.from(sig || '');
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return false;
  let data;
  try {
    data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return false;
  }
  return data.jid === jobId && data.scp === scope && typeof data.exp === 'number' && data.exp > Date.now();
}

export function bearer(req) {
  const h = req.headers.authorization || '';
  return h.startsWith('Bearer ') ? h.slice(7).trim() : null;
}

export function safeEqual(a, b) {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  return x.length === y.length && timingSafeEqual(x, y);
}
