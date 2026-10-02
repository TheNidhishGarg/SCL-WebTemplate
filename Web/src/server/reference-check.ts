import { lookup as dnsLookup, type LookupAddress, type LookupOptions } from "node:dns";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import type { AttemptOutcome } from "@/domain/reference";

// WF-02 URL check: one plain, unauthenticated GET per hop, to record what a
// reference URL actually does - status, redirects, page title - before anyone
// spends time capturing it. It is evidence about the URL, not a capture: the
// page body is read only to find the title and a password field, and is never
// stored.
//
// It fetches addresses users type in, from the server, so it must not become
// a way into the server's own network. Every connection's resolved address is
// checked at connect time (a custom DNS lookup, so a hostname that re-resolves
// between check and connect is still caught), IP literals are checked before
// connecting, redirects are followed by hand and re-checked hop by hop, and
// only ports 80 and 443 are used. It never sends cookies or credentials and
// makes no attempt to get past a sign-in, paywall or bot check.

export type CheckResult = {
  outcome: AttemptOutcome;
  httpStatus: number | null;
  finalUrl: string | null;
  redirectChain: { url: string; status: number }[];
  pageTitle: string | null;
  contentType: string | null;
  detail: string;
  inferences: string[];
};

export type CheckPolicy = {
  isAllowedAddress: (ip: string) => boolean;
  allowedPorts: number[];
  timeoutMs: number;
  maxRedirects: number;
  maxBodyBytes: number;
};

// Private, loopback, link-local (incl. cloud metadata at 169.254.169.254),
// carrier-grade NAT, documentation, benchmarking, multicast and reserved ranges.
const blocked = new net.BlockList();
for (const [net4, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16],
  ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15],
  ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) blocked.addSubnet(net4, prefix, "ipv4");
for (const [net6, prefix] of [
  ["::", 128], ["::1", 128], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8], ["2001:db8::", 32], ["100::", 64], ["64:ff9b::", 96],
] as const) blocked.addSubnet(net6, prefix, "ipv6");

export function isPublicAddress(ip: string): boolean {
  const family = net.isIP(ip);
  if (family === 0) return false;
  // IPv4-mapped IPv6 (::ffff:10.0.0.1) is judged as the IPv4 address it carries.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped) return isPublicAddress(mapped[1]);
  return !blocked.check(ip, family === 4 ? "ipv4" : "ipv6");
}

export const DEFAULT_POLICY: CheckPolicy = {
  isAllowedAddress: isPublicAddress,
  allowedPorts: [80, 443],
  timeoutMs: 10_000, // per hop; a slow site is "unreachable", not a hung request
  maxRedirects: 5,
  maxBodyBytes: 512 * 1024, // enough to find <title> in any real page
};

const USER_AGENT = "SCL-Web-ReferenceCheck/1.0 (one-off check of a URL a user added as a design reference)";

class PolicyError extends Error {}

type Hop = { status: number; location: string | null; contentType: string | null; body: string };

function portOf(u: URL): number {
  return u.port ? Number(u.port) : u.protocol === "https:" ? 443 : 80;
}

function request(url: URL, policy: CheckPolicy): Promise<Hop> {
  return new Promise((resolve, reject) => {
    const host = url.hostname.replace(/^\[|\]$/g, "");
    if (net.isIP(host) && !policy.isAllowedAddress(host)) {
      return reject(new PolicyError(`${host} is a private or internal address`));
    }
    if (!policy.allowedPorts.includes(portOf(url))) {
      return reject(new PolicyError(`port ${portOf(url)} is not checked; only standard web ports are`));
    }

    // Runs at connect time for hostnames: refuse if any resolved address is
    // not public, so a name pointing at an internal service is never reached.
    const lookup = (hostname: string, options: LookupOptions, callback: (...args: never[]) => void) => {
      dnsLookup(hostname, { ...options, all: true }, (err, addresses: LookupAddress[]) => {
        const cb = callback as unknown as (e: Error | null, a?: unknown, f?: number) => void;
        if (err) return cb(err);
        const bad = addresses.find((a) => !policy.isAllowedAddress(a.address));
        if (bad) return cb(new PolicyError(`${hostname} resolves to ${bad.address}, a private or internal address`));
        if (options.all) return cb(null, addresses);
        return cb(null, addresses[0].address, addresses[0].family);
      });
    };

    const lib = url.protocol === "https:" ? https : http;
    const req = lib.request(
      url,
      {
        method: "GET",
        lookup: lookup as never,
        headers: { "User-Agent": USER_AGENT, Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5", "Accept-Encoding": "identity" },
        timeout: policy.timeoutMs,
      },
      (res) => {
        const status = res.statusCode ?? 0;
        const contentType = (res.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase() || null;
        const location = typeof res.headers.location === "string" ? res.headers.location : null;
        const chunks: Buffer[] = [];
        let size = 0;
        const done = () => resolve({ status, location, contentType, body: Buffer.concat(chunks).toString("utf8") });
        if (!contentType?.includes("html") || (status >= 300 && status < 400)) {
          res.resume();
          return done();
        }
        res.on("data", (chunk: Buffer) => {
          if (size >= policy.maxBodyBytes) return;
          chunks.push(chunk);
          size += chunk.length;
          if (size >= policy.maxBodyBytes) {
            res.destroy(); // enough to find the title; the rest is not read
            done();
          }
        });
        res.on("end", done);
        res.on("error", done);
      },
    );
    req.on("timeout", () => req.destroy(Object.assign(new Error("timed out"), { code: "ETIMEDOUT" })));
    req.on("error", reject);
    req.end();
  });
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
function extractTitle(html: string): string | null {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  if (!m) return null;
  const text = m[1]
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z]+);/gi, (all, name) => ENTITIES[name.toLowerCase()] ?? all)
    .replace(/\s+/g, " ")
    .trim();
  return text ? text.slice(0, 300) : null;
}

const SIGN_IN_PATH = /(^|\/)(log-?in|sign-?in|signon|auth|sso|session|account\/login)(\/|$)/i;
const SIGN_IN_HOST = /^(login|auth|accounts|sso|signin)\./i;
const CHALLENGE_TITLE = /(access denied|just a moment|attention required|verify you are human|captcha|are you a robot)/i;

function outcomeForStatus(status: number): AttemptOutcome {
  if (status >= 200 && status < 300) return "reachable";
  if (status === 401 || status === 403 || status === 407 || status === 451) return "access_restricted";
  if (status === 404 || status === 410) return "not_found";
  if (status === 429) return "rate_limited";
  if (status >= 500) return "server_error";
  return "http_error";
}

function describeError(e: unknown): { outcome: AttemptOutcome; detail: string } {
  if (e instanceof PolicyError) return { outcome: "blocked_by_policy", detail: `Not checked: ${e.message}.` };
  const code = (e as { code?: string })?.code ?? "";
  const reason =
    code === "ENOTFOUND" || code === "EAI_AGAIN" ? "the domain name could not be resolved"
    : code === "ECONNREFUSED" ? "the server refused the connection"
    : code === "ECONNRESET" ? "the connection was reset"
    : code === "ETIMEDOUT" ? "the site did not respond in time"
    : code.startsWith("CERT_") || code.includes("SELF_SIGNED") || code.startsWith("ERR_TLS") ? `the TLS certificate was rejected (${code})`
    : `the request failed (${code || (e as Error)?.message || "unknown error"})`;
  return { outcome: "unreachable", detail: `Could not reach the page: ${reason}.` };
}

export async function checkReferenceUrl(rawUrl: string, policy: CheckPolicy = DEFAULT_POLICY): Promise<CheckResult> {
  const redirectChain: { url: string; status: number }[] = [];
  let current: URL;
  try {
    current = new URL(rawUrl);
  } catch {
    return { outcome: "http_error", httpStatus: null, finalUrl: null, redirectChain, pageTitle: null, contentType: null, detail: "Not a valid URL.", inferences: [] };
  }
  const startHost = current.hostname;

  for (let hop = 0; ; hop++) {
    let res: Hop;
    try {
      res = await request(current, policy);
    } catch (e) {
      const { outcome, detail } = describeError(e);
      const via = redirectChain.length ? ` (after ${redirectChain.length} redirect${redirectChain.length > 1 ? "s" : ""}, at ${current.href})` : "";
      return { outcome, httpStatus: null, finalUrl: redirectChain.length ? current.href : null, redirectChain, pageTitle: null, contentType: null, detail: detail + via, inferences: [] };
    }

    if (res.status >= 300 && res.status < 400 && res.location) {
      redirectChain.push({ url: current.href, status: res.status });
      let next: URL;
      try {
        next = new URL(res.location, current);
      } catch {
        return { outcome: "http_error", httpStatus: res.status, finalUrl: current.href, redirectChain, pageTitle: null, contentType: null, detail: `HTTP ${res.status} with an unusable Location header.`, inferences: [] };
      }
      if (next.protocol !== "http:" && next.protocol !== "https:") {
        return { outcome: "http_error", httpStatus: res.status, finalUrl: current.href, redirectChain, pageTitle: null, contentType: null, detail: `Redirected to a non-web address (${next.protocol}).`, inferences: [] };
      }
      if (hop + 1 > policy.maxRedirects) {
        return { outcome: "redirect_loop", httpStatus: res.status, finalUrl: next.href, redirectChain, pageTitle: null, contentType: null, detail: `Stopped after ${policy.maxRedirects} redirects.`, inferences: [] };
      }
      current = next;
      continue;
    }

    const outcome = outcomeForStatus(res.status);
    const isHtml = res.contentType?.includes("html") ?? false;
    const pageTitle = isHtml ? extractTitle(res.body) : null;
    const inferences: string[] = [];
    if (SIGN_IN_PATH.test(current.pathname) || SIGN_IN_HOST.test(current.hostname)) {
      inferences.push("The final URL looks like a sign-in page, so the reference may need an account. What was reached may not be the reference itself.");
    }
    if (isHtml && /<input[^>]+type\s*=\s*["']?password/i.test(res.body)) {
      inferences.push("The page contains a password field; it may be a sign-in wall rather than the content to study.");
    }
    if (pageTitle && CHALLENGE_TITLE.test(pageTitle)) {
      inferences.push(`The page title ("${pageTitle}") suggests a bot-protection or access-denied screen rather than the reference.`);
    }

    const parts = [`HTTP ${res.status}`];
    if (res.contentType) parts.push(res.contentType);
    if (redirectChain.length) parts.push(`${redirectChain.length} redirect${redirectChain.length > 1 ? "s" : ""}`);
    if (current.hostname !== startHost) parts.push(`ended on a different site (${current.hostname})`);
    if (isHtml && !pageTitle && outcome === "reachable") parts.push("no page title found");

    return {
      outcome,
      httpStatus: res.status,
      finalUrl: current.href,
      redirectChain,
      pageTitle,
      contentType: res.contentType,
      detail: parts.join(" · ") + ".",
      inferences,
    };
  }
}
