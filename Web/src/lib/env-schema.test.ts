import { describe, expect, it } from "vitest";
import { parseEnv } from "./env-schema";

const LONG = "x".repeat(32);

describe("parseEnv", () => {
  it("starts with no integrations configured", () => {
    const r = parseEnv({});
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.env.APP_BASE_URL).toBe("http://localhost:3000");
      expect(Object.values(r.env.integrations).every((v) => v === false)).toBe(true);
    }
  });

  it("treats empty placeholders as unset", () => {
    expect(parseEnv({ MUX_TOKEN_ID: "", MUX_TOKEN_SECRET: " ", MUX_WEBHOOK_SECRET: "" }).ok).toBe(true);
  });

  it("enables an integration only when its whole group is set", () => {
    const r = parseEnv({ MUX_TOKEN_ID: "id", MUX_TOKEN_SECRET: LONG, MUX_WEBHOOK_SECRET: LONG });
    expect(r.ok && r.env.integrations.mux).toBe(true);
  });

  it("fails on a partially configured group and names the missing variables", () => {
    const r = parseEnv({ MUX_TOKEN_ID: "id" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join("\n")).toMatch(/mux: .*MUX_TOKEN_SECRET, MUX_WEBHOOK_SECRET/);
  });

  it("never echoes a secret value in an error", () => {
    const r = parseEnv({ RUNWAYML_API_SECRET: "short-secret" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join("\n")).not.toContain("short-secret");
  });

  it("requires an https APP_BASE_URL in production", () => {
    expect(parseEnv({ NODE_ENV: "production" }).ok).toBe(false);
    expect(parseEnv({ NODE_ENV: "production", APP_BASE_URL: "http://example.com" }).ok).toBe(false);
    expect(parseEnv({ NODE_ENV: "production", APP_BASE_URL: "https://example.com" }).ok).toBe(true);
  });

  it("rejects a non-https provider URL", () => {
    const r = parseEnv({ NEXT_PUBLIC_POSTHOG_KEY: "phc_x", NEXT_PUBLIC_POSTHOG_HOST: "http://eu.posthog.com" });
    expect(r.ok).toBe(false);
  });
});
