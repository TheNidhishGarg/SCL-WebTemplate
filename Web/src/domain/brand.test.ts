import { describe, expect, it } from "vitest";
import { BrandContent, defaultBrand, listTokens } from "./brand";
import { brandCss, brandIssues, brandVariables, contrastRatio } from "./brand-css";
import { applySuggestions } from "./brand-suggest";

const complete = () => {
  const b = defaultBrand();
  b.typography.heading.family = { value: "Playfair Display", status: "confirmed", note: "Guidelines p.4" };
  b.typography.body.family = { value: "Inter", status: "confirmed", note: "" };
  b.assets.logos = [{ variant: "primary", ref: { kind: "url", url: "https://cdn.example.com/logo.svg" }, background: "light", minWidthPx: 96, status: "confirmed", note: "" }];
  return b;
};
const paths = (b: unknown) => {
  const r = BrandContent.safeParse(b);
  return r.success ? [] : r.error.issues.map((i) => [i.path.join("."), i.message]);
};

describe("validation", () => {
  it("accepts the defaults and a complete brand", () => {
    expect(BrandContent.safeParse(defaultBrand()).success).toBe(true);
    expect(BrandContent.safeParse(complete()).success).toBe(true);
  });

  it("gives actionable errors, at the field", () => {
    const b = complete() as unknown as { colors: { primary: { value: string } }; typography: { baseSize: { value: number } }; layout: { breakpoints: { md: { value: number } } } };
    b.colors.primary.value = "blue";
    b.typography.baseSize.value = 40;
    b.layout.breakpoints.md.value = 600; // below sm (640)
    expect(paths(b)).toEqual(
      expect.arrayContaining([
        ["colors.primary.value", "Use a 6-digit hex colour, e.g. #1A2B3C"],
        ["typography.baseSize.value", "Must be at most 24px"],
        ["layout.breakpoints.md.value", "Must be larger than the sm breakpoint (640px)"],
      ]),
    );
  });

  it("refuses values that could inject CSS", () => {
    const b = complete();
    const raw = JSON.parse(JSON.stringify(b));
    raw.typography.body.family.value = 'Inter"; } body { display:none';
    raw.shape.shadow.md.value = "0 0 1px red; background: url(x)";
    raw.motion.easing.value = "ease; color: red";
    const p = paths(raw).map(([path]) => path);
    expect(p).toEqual(expect.arrayContaining(["typography.body.family.value", "shape.shadow.md.value", "motion.easing.value"]));
  });
});

describe("CSS variables", () => {
  it("export exactly the saved values, name for name", () => {
    const b = complete();
    b.colors.primary.value = "#7a1fa2";
    const vars = brandVariables(b);
    expect(vars["--scl-color-primary"]).toBe("#7a1fa2");
    expect(vars["--scl-font-heading"]).toBe('"Playfair Display", sans-serif');
    expect(vars["--scl-font-size-base"]).toBe("1rem");
    expect(vars["--scl-font-size-lg"]).toBe("1.25rem");
    expect(vars["--scl-space-4"]).toBe("16px");
    const css = brandCss(b, { selector: '[data-scl-brand="acme"]', header: "test" });
    const main = css.slice(0, css.indexOf("@media"));
    const parsed = Object.fromEntries([...main.matchAll(/(--scl-[a-z0-9-]+): ([^;]+);/g)].map((m) => [m[1], m[2]]));
    expect(parsed).toEqual({ ...vars, "--scl-motion-enabled": "1" });
    expect(css).toContain('[data-scl-brand="acme"] {');
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\) \{\n {2}\[data-scl-brand="acme"\] \{\n {4}--scl-duration-fast: 1ms;/);
  });

  it("emit nothing for missing values and say so", () => {
    const b = defaultBrand(); // heading/body families missing
    expect(brandVariables(b)["--scl-font-heading"]).toBeUndefined();
    expect(brandCss(b, { selector: ":root", header: "x" })).toContain("Missing (no variable emitted): typography.heading.family, typography.body.family, typography.mono.family");
  });
});

describe("accessibility checks", () => {
  it("computes WCAG contrast", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBe(21);
    expect(contrastRatio("#777777", "#ffffff")).toBe(4.48);
  });

  it("blocks approval on failing text contrast, with a fix, and warns on the rest", () => {
    const b = complete();
    expect(brandIssues(b).filter((i) => i.level === "error")).toEqual([]);
    b.colors.text.value = "#999999";
    b.colors.warning.value = "#facc15";
    const issues = brandIssues(b);
    const err = issues.find((i) => i.path === "colors.text.value" && i.level === "error")!;
    expect(err.message).toMatch(/^Text on background is 2\.85:1; body text need 4\.5:1\. Darken text or lighten background\.$/);
    expect(issues.find((i) => i.path === "colors.warning.value")?.level).toBe("warning");
  });

  it("requires every required value and a primary logo", () => {
    const issues = brandIssues(defaultBrand()).filter((i) => i.level === "error").map((i) => i.path);
    expect(issues).toEqual(expect.arrayContaining(["typography.heading.family.value", "typography.body.family.value", "assets.logos"]));
    expect(issues).not.toContain("typography.mono.family.value");
  });
});

describe("provenance and suggestions", () => {
  it("lists every value as confirmed, inferred, default or missing", () => {
    const t = listTokens(complete());
    expect(t.find((x) => x.path === "typography.heading.family")).toMatchObject({ status: "confirmed", note: "Guidelines p.4" });
    expect(t.find((x) => x.path === "colors.primary")?.status).toBe("default");
    expect(t.find((x) => x.path === "typography.mono.family")?.status).toBe("missing");
  });

  it("suggests from the client's own material without touching decided values", () => {
    const b = complete();
    b.colors.accent = { value: "#123456", status: "confirmed", note: "" };
    const { content, applied } = applySuggestions(b, {
      logos: [{ assetId: "7c9e6679-7425-40de-944b-e07fc1f90ae7", label: "Logo" }],
      ownedSources: [
        {
          label: "Client site",
          customProperties: [
            { name: "--brand", value: "#0A84FF", path: "css/site.css", line: 1 },
            { name: "--accent", value: "#ff0000", path: "css/site.css", line: 2 },
            { name: "--bg", value: "#fff", path: "css/site.css", line: 3 },
          ],
          fontFamilies: [{ family: "Inter", count: 3 }],
          breakpoints: [
            { px: 768, feature: "min-width", count: 1 },
            { px: 1024, feature: "min-width", count: 1 },
          ],
        },
      ],
    });
    expect(content.colors.primary).toEqual({ value: "#0a84ff", status: "inferred", note: "Client site: --brand (css/site.css:1)" });
    expect(content.colors.background.value).toBe("#ffffff");
    expect(content.colors.accent).toEqual({ value: "#123456", status: "confirmed", note: "" }); // decided: untouched
    expect(content.typography.body.family.status).toBe("confirmed"); // decided: untouched
    expect(content.layout.breakpoints.md).toMatchObject({ value: 768, status: "inferred" });
    expect(content.layout.breakpoints.lg).toMatchObject({ value: 1024, status: "inferred" });
    expect(content.layout.breakpoints.sm.status).toBe("default");
    expect(content.assets.logos).toHaveLength(1); // already had a logo
    expect(applied).toEqual(expect.arrayContaining(["colors.primary", "colors.background"]));
    expect(BrandContent.safeParse(content).success).toBe(true);
  });
});
