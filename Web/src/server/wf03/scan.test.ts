import { strToU8, zipSync } from "fflate";
import { MAX_CAPTURE_BYTES } from "@/domain/reference";
import { describe, expect, it } from "vitest";
import { SourceAnalysis } from "@/domain/source-analysis";
import { ArchiveError, DEFAULT_LIMITS, readArchive } from "./archive";
import { analyzeArchive } from "./scan";

import { GOOGLE_KEY, nextRepo, staticSite } from "./test-fixtures";

describe("static site capture", () => {
  const { analysis: a } = analyzeArchive(staticSite());

  it("strips the shared top folder and inventories every file", () => {
    expect(a.rootPrefix).toBe("studio/");
    expect(a.summary.files).toBe(6);
    expect(a.files.map((f) => f.path)).toContain("css/site.css");
    expect(a.routes.map((r) => r.route)).toEqual(["/", "/about"]);
    expect(() => SourceAnalysis.parse(a)).not.toThrow();
  });

  it("states what cannot be known instead of guessing", () => {
    expect(a.frameworks).toEqual([]);
    expect(a.questions.map((q) => q.key)).toEqual(expect.arrayContaining(["framework-unknown", "missing-assets", "pages-not-captured", "font-licences", "code-ownership", "credentials"]));
    expect(a.linkedButMissing.map((l) => l.href)).toEqual(["/contact"]);
  });

  it("treats identical blocks as observed and similar sections as inferred", () => {
    const nav = a.templateCandidates.find((c) => c.kind === "navigation");
    expect(nav).toMatchObject({ basis: "observed", rationale: "Identical markup on 2 pages.", pages: ["about.html", "index.html"] });
    expect(nav?.files).toEqual(["about.html", "css/site.css", "index.html"]);
    expect(a.templateCandidates.find((c) => c.kind === "layout")?.name).toBe("footer.site-footer");
    const hero = a.templateCandidates.find((c) => c.key === "section:section.dark.hero");
    expect(hero).toMatchObject({ basis: "inferred", pages: ["about.html", "index.html"] });
    // On one page only, in a multi-page site: not offered as reusable.
    expect(a.templateCandidates.some((c) => c.key.includes("team"))).toBe(false);
  });

  it("reads styles as written: tokens, breakpoints, fonts, colours", () => {
    expect(a.styles.customProperties.map((p) => [p.name, p.value])).toEqual([["--brand", "#0a84ff"], ["--space-2", "0.5rem"]]);
    expect(a.styles.breakpoints.map((b) => [b.feature, b.px])).toEqual([["min-width", 768], ["min-width", 1024]]);
    expect(a.styles.fontFaces[0]).toMatchObject({ family: "Inter", weight: "400", src: ["../fonts/inter.woff2"] });
    expect(a.styles.colors.map((c) => c.value)).toEqual(expect.arrayContaining(["#0a84ff", "#111", "rgb(250,250,250)"]));
    expect(a.styles.colors.map((c) => c.value)).not.toContain("#ffffff"); // from a comment
    expect(a.styles.fontFamilies).toEqual([{ family: "Inter", count: 1 }]);
  });

  it("resolves asset references, including from CSS, and lists what is missing", () => {
    expect(a.assets.find((x) => x.path === "images/hero.jpg")?.referencedBy).toEqual(["css/site.css", "index.html"]);
    expect(a.assets.find((x) => x.path === "fonts/inter.woff2")?.referencedBy).toEqual(["css/site.css"]);
    expect(a.missingAssets.map((m) => m.ref)).toEqual(["images/missing.png"]);
    expect(a.dependencies).toEqual([{ name: "gsap", version: "3.12.5", scope: "cdn", path: "https://cdn.jsdelivr.net/npm/gsap@3.12.5/dist/gsap.min.js" }]);
  });

  it("reports risks with evidence, and masks secrets", () => {
    const keys = a.risks.map((r) => r.key);
    expect(keys).toEqual(expect.arrayContaining(["secret:Google API key", "call:eval", "external-scripts-without-sri", "insecure-resources", "blank-without-noopener", "a11y:img-alt", "a11y:labels", "a11y:lang", "a11y:headings", "a11y:reduced-motion", "missing-assets", "license:none", "license:fonts"]));
    const secret = a.risks.find((r) => r.key === "secret:Google API key")!;
    expect(secret.evidence[0]).toMatchObject({ path: "js/app.js", line: 1 });
    expect(JSON.stringify(a)).not.toContain(GOOGLE_KEY);
    const evalRisk = a.risks.find((r) => r.key === "call:eval")!;
    expect(evalRisk.evidence[0].path).toBe("index.html");
    expect(a.risks.find((r) => r.key === "a11y:lang")!.evidence[0].path).toBe("about.html");
    // Ordered by severity.
    expect(a.risks[0].severity).toBe("high");
  });

  it("identifies interaction libraries with the evidence for each", () => {
    const gsap = a.interactions.find((i) => i.name === "GSAP")!;
    expect(gsap.basis).toBe("observed");
    expect(gsap.evidence.map((e) => e.path)).toEqual(expect.arrayContaining(["index.html", "https://cdn.jsdelivr.net/npm/gsap@3.12.5/dist/gsap.min.js"]));
    expect(a.interactions.map((i) => i.name)).toContain("CSS animations and transitions");
    // gsap.min.js is evidence for GSAP only, not for its plugins.
    expect(a.interactions.map((i) => i.name)).not.toContain("GSAP ScrollTrigger");
    expect(gsap.rationale).toBe("Its script file is loaded; its API is called in the code.");
  });
});

describe("Next.js repository", () => {
  const { analysis: a } = analyzeArchive(nextRepo());

  it("reads frameworks from package.json as observed, with versions", () => {
    expect(a.frameworks.find((f) => f.name === "Next.js")).toMatchObject({ version: "15.1.0", basis: "observed" });
    expect(a.frameworks.map((f) => f.name)).toEqual(["Next.js", "React"]);
  });

  it("maps file-system routes, including groups and dynamic segments", () => {
    expect(a.routes).toEqual([
      { route: "/", file: "app/page.tsx", origin: "next_app", dynamic: false },
      { route: "/about", file: "app/(marketing)/about/page.tsx", origin: "next_app", dynamic: false },
      { route: "/blog/[slug]", file: "app/blog/[slug]/page.tsx", origin: "next_app", dynamic: true },
    ]);
    expect(a.questions.map((q) => q.key)).toContain("route-params:/blog/[slug]");
  });

  it("builds the import graph and offers only components that are reused", () => {
    expect(a.components.find((c) => c.name === "Header")?.usedBy).toEqual(["app/(marketing)/about/page.tsx", "app/layout.tsx"]);
    const header = a.templateCandidates.find((c) => c.name === "Header")!;
    expect(header).toMatchObject({ kind: "navigation", basis: "inferred" });
    expect(header.files).toEqual(["components/Header.tsx", "components/header.css"]);
    expect(a.templateCandidates.some((c) => c.name === "Card")).toBe(false);
    expect(a.templateCandidates.find((c) => c.key === "next-layout:app/layout.tsx")).toMatchObject({ kind: "layout", basis: "observed" });
    expect(a.templateCandidates.find((c) => c.key === "route-template:app/blog/[slug]/page.tsx")).toMatchObject({ kind: "page_template", basis: "inferred" });
  });

  it("skips dependency folders and reports that it did", () => {
    expect(a.files.some((f) => f.path.startsWith("node_modules/"))).toBe(false);
    expect(a.skipped).toContainEqual({ path: "node_modules/", reason: expect.stringContaining("not project source") });
  });

  it("finds licences, credentials and motion handling", () => {
    expect(a.licenses).toEqual([
      { path: "LICENSE", identified: "MIT", basis: "inferred" },
      { path: "package.json", identified: "MIT", basis: "observed" },
    ]);
    expect(a.risks.map((r) => r.key)).toEqual(expect.arrayContaining(["env-files", "secret:Stripe live secret key", "deps:unaudited"]));
    expect(a.risks.map((r) => r.key)).not.toContain("license:none");
    expect(a.risks.map((r) => r.key)).not.toContain("deps:no-lockfile");
    expect(a.risks.map((r) => r.key)).not.toContain("a11y:reduced-motion");
    expect(a.interactions.find((i) => i.name === "GSAP")).toMatchObject({ basis: "observed" });
  });
});

describe("reproducibility", () => {
  it("gives the same report and digest for the same archive, and a different digest when one byte changes", () => {
    const bytes = staticSite();
    const one = analyzeArchive(bytes);
    const two = analyzeArchive(bytes);
    expect(two.digest).toBe(one.digest);
    expect(JSON.stringify(two.analysis)).toBe(JSON.stringify(one.analysis));
    const changed = analyzeArchive(zipSync({ ...Object.fromEntries(Object.entries({ "a.html": strToU8("<p>1</p>") })) }));
    const changed2 = analyzeArchive(zipSync({ "a.html": strToU8("<p>2</p>") }));
    expect(changed.digest).not.toBe(changed2.digest);
  });
});

describe("archive safety", () => {
  it("refuses entries that escape the archive", () => {
    const r = readArchive(zipSync({ "../evil.txt": strToU8("x"), "/etc/passwd": strToU8("x"), "ok/a.txt": strToU8("x") }));
    expect(r.files.map((f) => f.path)).toEqual(["a.txt"]);
    expect(r.skipped.map((s) => s.reason)).toEqual(["unsafe path (absolute or contains ..)", "unsafe path (absolute or contains ..)"]);
  });

  it("enforces file and size limits", () => {
    const big = new Uint8Array(2000);
    const r = readArchive(zipSync({ "a.txt": strToU8("x"), "b.bin": big }), { maxFiles: 10, maxFileBytes: 1000, maxTotalBytes: 10_000 });
    expect(r.files.map((f) => f.path)).toEqual(["a.txt"]);
    expect(r.skipped[0]).toMatchObject({ path: "b.bin" });
    expect(() => readArchive(zipSync({ "a.bin": big, "b.bin": big }), { maxFiles: 10, maxFileBytes: 5000, maxTotalBytes: 3000 })).toThrow(ArchiveError);
    const many = Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`f${i}.txt`, strToU8("x")]));
    expect(readArchive(zipSync(many), { maxFiles: 3, maxFileBytes: 100, maxTotalBytes: 1000 }).files).toHaveLength(3);
  });

  it("can list every entry but inflate only selected ones, and allows twice the WF-02 limit when expanded", () => {
    const z = zipSync({ "site/manifest.json": strToU8("{}"), "site/a.html": strToU8("<p>"), "site/../evil": strToU8("x") });
    const r = readArchive(z, undefined, (p) => p === "site/manifest.json");
    expect(r.files.map((f) => f.path)).toEqual(["manifest.json"]);
    expect(r.names.sort()).toEqual(["a.html", "manifest.json"]);
    expect(r.rootPrefix).toBe("site/");
    expect(r.skipped.map((x) => x.reason)).toContain("unsafe path (absolute or contains ..)");
    expect(DEFAULT_LIMITS.maxTotalBytes).toBe(2 * MAX_CAPTURE_BYTES);
  });

  it("rejects something that is not a zip", () => {
    expect(() => readArchive(strToU8("not a zip"))).toThrow(ArchiveError);
  });
});
