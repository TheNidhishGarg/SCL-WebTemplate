import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkReferenceUrl, DEFAULT_POLICY, isPublicAddress, type CheckPolicy } from "./reference-check";

// A real HTTP server on loopback. The default policy refuses loopback, so the
// behaviour tests use a policy that allows exactly this server - and separate
// tests prove the default policy refuses it.

let server: http.Server;
let base: string;
let policy: CheckPolicy;

const routes: Record<string, (req: http.IncomingMessage, res: http.ServerResponse) => void> = {
  "/ok": (_q, r) => r.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end("<html><head><title> Studio &amp; Co &#8211; Work </title></head><body>x</body></html>"),
  "/no-title": (_q, r) => r.writeHead(200, { "content-type": "text/html" }).end("<p>hi</p>"),
  "/pdf": (_q, r) => r.writeHead(200, { "content-type": "application/pdf" }).end("%PDF"),
  "/hop1": (_q, r) => r.writeHead(301, { location: "/hop2" }).end(),
  "/hop2": (_q, r) => r.writeHead(302, { location: "/ok" }).end(),
  "/loop": (_q, r) => r.writeHead(302, { location: "/loop" }).end(),
  "/private": (_q, r) => r.writeHead(200, { "content-type": "text/html" }).end("<title>Members</title>"),
  "/members": (_q, r) => r.writeHead(302, { location: "/account/login?next=/members" }).end(),
  "/account/login": (_q, r) => r.writeHead(200, { "content-type": "text/html" }).end('<title>Sign in</title><form><input type="password" name="p"></form>'),
  "/denied": (_q, r) => r.writeHead(403, { "content-type": "text/html" }).end("<title>Forbidden</title>"),
  "/auth": (_q, r) => r.writeHead(401).end(),
  "/gone": (_q, r) => r.writeHead(404).end(),
  "/busy": (_q, r) => r.writeHead(429).end(),
  "/broken": (_q, r) => r.writeHead(500).end(),
  "/challenge": (_q, r) => r.writeHead(200, { "content-type": "text/html" }).end("<title>Just a moment...</title>"),
  "/to-internal": (_q, r) => r.writeHead(302, { location: "http://10.0.0.1/admin" }).end(),
  "/to-ftp": (_q, r) => r.writeHead(302, { location: "ftp://example.com/x" }).end(),
  "/slow": () => {
    /* never answers */
  },
  "/big": (_q, r) => {
    r.writeHead(200, { "content-type": "text/html" });
    r.write("<title>Big</title>");
    const chunk = "x".repeat(64 * 1024);
    // Far beyond the read cap; the check must stop reading, not buffer it all.
    for (let i = 0; i < 200; i++) r.write(chunk);
    r.end();
  },
};

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://x").pathname;
    (routes[path] ?? ((_q, r) => r.writeHead(404).end()))(req, res);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  base = `http://127.0.0.1:${port}`;
  policy = { ...DEFAULT_POLICY, timeoutMs: 500, isAllowedAddress: (ip) => ip === "127.0.0.1", allowedPorts: [port] };
});
afterAll(() => {
  server.closeAllConnections();
  server.close();
});

describe("checkReferenceUrl", () => {
  it("records a reachable page and its decoded title", async () => {
    const r = await checkReferenceUrl(`${base}/ok`, policy);
    expect(r).toMatchObject({ outcome: "reachable", httpStatus: 200, pageTitle: "Studio & Co – Work", contentType: "text/html", redirectChain: [] });
    expect(r.inferences).toEqual([]);
  });

  it("says when there is no title rather than inventing one", async () => {
    const r = await checkReferenceUrl(`${base}/no-title`, policy);
    expect(r.pageTitle).toBeNull();
    expect(r.detail).toContain("no page title found");
  });

  it("records non-HTML content without reading it", async () => {
    expect(await checkReferenceUrl(`${base}/pdf`, policy)).toMatchObject({ outcome: "reachable", contentType: "application/pdf", pageTitle: null });
  });

  it("follows redirects and records every hop", async () => {
    const r = await checkReferenceUrl(`${base}/hop1`, policy);
    expect(r.outcome).toBe("reachable");
    expect(r.finalUrl).toBe(`${base}/ok`);
    expect(r.redirectChain).toEqual([
      { url: `${base}/hop1`, status: 301 },
      { url: `${base}/hop2`, status: 302 },
    ]);
  });

  it("stops a redirect loop", async () => {
    const r = await checkReferenceUrl(`${base}/loop`, policy);
    expect(r.outcome).toBe("redirect_loop");
    expect(r.redirectChain).toHaveLength(DEFAULT_POLICY.maxRedirects + 1);
  });

  it("reports a sign-in wall as an inference, not as the reference's content", async () => {
    const r = await checkReferenceUrl(`${base}/members`, policy);
    expect(r.outcome).toBe("reachable");
    expect(r.finalUrl).toBe(`${base}/account/login?next=/members`);
    expect(r.inferences.join(" ")).toMatch(/sign-in page/);
    expect(r.inferences.join(" ")).toMatch(/password field/);
  });

  it("flags a bot-check page as an inference", async () => {
    const r = await checkReferenceUrl(`${base}/challenge`, policy);
    expect(r.inferences.join(" ")).toMatch(/bot-protection/);
  });

  it.each([
    ["/denied", "access_restricted", 403],
    ["/auth", "access_restricted", 401],
    ["/gone", "not_found", 404],
    ["/busy", "rate_limited", 429],
    ["/broken", "server_error", 500],
  ])("maps %s to %s", async (path, outcome, status) => {
    expect(await checkReferenceUrl(`${base}${path}`, policy)).toMatchObject({ outcome, httpStatus: status });
  });

  it("refuses to follow a redirect into a private network, and records how it got there", async () => {
    const r = await checkReferenceUrl(`${base}/to-internal`, policy);
    expect(r.outcome).toBe("blocked_by_policy");
    expect(r.redirectChain).toEqual([{ url: `${base}/to-internal`, status: 302 }]);
    expect(r.detail).toContain("10.0.0.1");
  });

  it("refuses a redirect to a non-web scheme", async () => {
    expect((await checkReferenceUrl(`${base}/to-ftp`, policy)).outcome).toBe("http_error");
  });

  it("gives up on a site that does not answer", async () => {
    const r = await checkReferenceUrl(`${base}/slow`, policy);
    expect(r.outcome).toBe("unreachable");
    expect(r.detail).toContain("did not respond in time");
  });

  it("reads only the start of a very large page", async () => {
    const r = await checkReferenceUrl(`${base}/big`, policy);
    expect(r).toMatchObject({ outcome: "reachable", pageTitle: "Big" });
  });
});

describe("default policy", () => {
  it("refuses loopback, private and metadata addresses, by literal and by name", async () => {
    for (const url of [
      "http://127.0.0.1/",
      "http://10.1.2.3/",
      "http://192.168.0.10/",
      "http://169.254.169.254/latest/meta-data/",
      "http://[::1]/",
      "http://[::ffff:127.0.0.1]/",
      "http://localhost/",
    ]) {
      const r = await checkReferenceUrl(url);
      expect(r.outcome, url).toBe("blocked_by_policy");
    }
  });

  it("refuses non-standard ports", async () => {
    const r = await checkReferenceUrl("http://example.com:8080/");
    expect(r.outcome).toBe("blocked_by_policy");
    expect(r.detail).toContain("port 8080");
  });

  it("classifies addresses", () => {
    expect(isPublicAddress("93.184.216.34")).toBe(true);
    expect(isPublicAddress("2606:2800:220:1:248:1893:25c8:1946")).toBe(true);
    for (const ip of ["10.0.0.1", "172.20.1.1", "100.64.0.1", "fd00::1", "fe80::1", "::ffff:192.168.1.1", "0.0.0.0", "not-an-ip"]) {
      expect(isPublicAddress(ip), ip).toBe(false);
    }
  });
});
