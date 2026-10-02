import { z } from "zod";

// Environment validation, kept free of Next.js and server-only imports so it
// can be unit-tested. Application code reads env through src/server/env.ts.
//
// Every external provider is an all-or-nothing group: leave the whole group
// unset and the integration is simply off (local development never blocks on a
// provider that is not configured yet); set part of a group and startup fails,
// because a half-configured integration fails later, at a worse moment.
//
// Providers whose access method is still unverified (SaveMyResources, SCL CMS,
// Flow) have no variables here on purpose: none are added until their access
// method is confirmed.

// The origin the SaveAllResources extension uploads to: exactly an origin
// (no path), https except on localhost - the extension enforces the same.
const uploadOrigin = z.url({ protocol: /^https?$/ }).refine((v) => {
  const u = new URL(v);
  return v.replace(/\/$/, "") === u.origin && (u.protocol === "https:" || u.hostname === "localhost" || u.hostname === "127.0.0.1");
}, "an origin like https://web.example.com (https unless localhost), no path");

const secret = z.string().min(16, "looks too short to be a real credential");
const httpsUrl = z.url({ protocol: /^https$/ });

export const INTEGRATIONS = {
  supabase: {
    NEXT_PUBLIC_SUPABASE_URL: httpsUrl,
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: z.string().min(1),
    SUPABASE_SECRET_KEY: secret,
  },
  // The existing n8n instance (SCL-workflows). Token sent as x-scl-token.
  n8n: {
    N8N_WEBHOOK_BASE_URL: httpsUrl,
    N8N_WEBHOOK_TOKEN: secret,
  },
  mux: {
    MUX_TOKEN_ID: z.string().min(1),
    MUX_TOKEN_SECRET: secret,
    MUX_WEBHOOK_SECRET: secret,
  },
  posthog: {
    NEXT_PUBLIC_POSTHOG_KEY: z.string().min(1),
    NEXT_PUBLIC_POSTHOG_HOST: httpsUrl,
  },
  runway: {
    RUNWAYML_API_SECRET: secret,
  },
  // Veo through the Gemini API. Flow itself is a UI and is used manually.
  veo: {
    GEMINI_API_KEY: secret,
  },
  // The SaveAllResources automation build, installed in the capturing
  // person's Chrome (built from its own repository with this Web origin).
  // The extension id is public; uploads are authorised per job, not by it.
  saveAllResources: {
    SAR_EXTENSION_ID: z.string().regex(/^[a-p]{32}$/, "a Chrome extension id: 32 letters a-p"),
    SAR_UPLOAD_ORIGIN: uploadOrigin,
  },
} as const satisfies Record<string, Record<string, z.ZodType<string>>>;

export type IntegrationName = keyof typeof INTEGRATIONS;

const core = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  APP_BASE_URL: z.url({ protocol: /^https?$/ }).default("http://localhost:3000"),
  // Where the WF-01 SQLite database and uploaded files live. Relative paths
  // resolve against the app directory.
  SCL_DATA_DIR: z.string().min(1).default(".data"),
  // The dashboard has no sign-in yet. Outside development it refuses to serve
  // unless this is explicitly "true" - for a private network only.
  DASHBOARD_ALLOW_UNAUTHENTICATED: z.enum(["true", "false"]).default("false").transform((v) => v === "true"),
  // SaveAllResources installation used to generate website templates from a
  // URL (docs/save-all-resources.md). Optional: without it the feature is off.
  // In development, a sibling ../SaveAllResources checkout is used if present.
  SAR_HOME: z.string().min(1).optional(),
  // Defaults for a generation; the form can lower them.
  SAR_MAX_PAGES: z.coerce.number().int().min(1).max(500).default(10),
  SAR_MAX_DEPTH: z.coerce.number().int().min(0).max(10).default(3),
  SAR_MAX_MINUTES: z.coerce.number().int().min(1).max(360).default(15),
  // Live template previews (docs/template-preview.md). "local": preview
  // processes on this machine, shown to a browser on this machine. "remote":
  // isolated preview servers (not available yet). Default: local in
  // development, off otherwise.
  PREVIEW_MODE: z.enum(["local", "remote", "off"]).optional(),
  PREVIEW_PORT_MIN: z.coerce.number().int().min(1024).max(65535).default(4310),
  PREVIEW_PORT_MAX: z.coerce.number().int().min(1024).max(65535).default(4399),
  PREVIEW_MAX_RUNNING: z.coerce.number().int().min(1).max(20).default(3),
  PREVIEW_IDLE_MINUTES: z.coerce.number().int().min(1).max(24 * 60).default(30),
});

export type ParsedEnv = z.infer<typeof core> & {
  integrations: Record<IntegrationName, boolean>;
  values: Record<string, string>;
};

export type EnvResult = { ok: true; env: ParsedEnv } | { ok: false; errors: string[] };

export function parseEnv(source: Record<string, string | undefined>): EnvResult {
  // Treat KEY= (empty) as unset, which is how .env.example placeholders are copied.
  const read = (key: string) => {
    const v = source[key];
    return v === undefined || v.trim() === "" ? undefined : v.trim();
  };

  const errors: string[] = [];
  const coreResult = core.safeParse({
    NODE_ENV: read("NODE_ENV"),
    APP_BASE_URL: read("APP_BASE_URL"),
    SCL_DATA_DIR: read("SCL_DATA_DIR"),
    DASHBOARD_ALLOW_UNAUTHENTICATED: read("DASHBOARD_ALLOW_UNAUTHENTICATED"),
    SAR_HOME: read("SAR_HOME"),
    SAR_MAX_PAGES: read("SAR_MAX_PAGES"),
    SAR_MAX_DEPTH: read("SAR_MAX_DEPTH"),
    SAR_MAX_MINUTES: read("SAR_MAX_MINUTES"),
    PREVIEW_MODE: read("PREVIEW_MODE"),
    PREVIEW_PORT_MIN: read("PREVIEW_PORT_MIN"),
    PREVIEW_PORT_MAX: read("PREVIEW_PORT_MAX"),
    PREVIEW_MAX_RUNNING: read("PREVIEW_MAX_RUNNING"),
    PREVIEW_IDLE_MINUTES: read("PREVIEW_IDLE_MINUTES"),
  });
  if (!coreResult.success) {
    for (const issue of coreResult.error.issues) errors.push(`${issue.path.join(".")}: ${issue.message}`);
  }
  if (coreResult.success && coreResult.data.NODE_ENV === "production" && !read("APP_BASE_URL")?.startsWith("https://")) {
    errors.push("APP_BASE_URL: must be set to an https URL in production");
  }
  // Serverless filesystems are ephemeral: records written there would vanish
  // between requests while the UI reported success. Refuse instead.
  if (read("VERCEL")) {
    errors.push("VERCEL: the local SQLite store cannot persist on Vercel; configure a hosted database first (docs/wf-01.md)");
  }

  const integrations = {} as Record<IntegrationName, boolean>;
  const values: Record<string, string> = {};
  for (const [name, vars] of Object.entries(INTEGRATIONS) as [IntegrationName, Record<string, z.ZodType<string>>][]) {
    const keys = Object.keys(vars);
    const present = keys.filter((k) => read(k) !== undefined);
    integrations[name] = present.length === keys.length;
    if (present.length === 0) continue;
    if (present.length < keys.length) {
      const missing = keys.filter((k) => !present.includes(k));
      errors.push(`${name}: partially configured; also set ${missing.join(", ")} or unset the group`);
      continue;
    }
    for (const key of keys) {
      // Messages name the variable, never its value.
      const r = vars[key].safeParse(read(key));
      if (r.success) values[key] = r.data;
      else errors.push(`${key}: ${r.error.issues[0]?.message ?? "invalid"}`);
    }
  }

  if (errors.length || !coreResult.success) return { ok: false, errors };
  return { ok: true, env: { ...coreResult.data, integrations, values } };
}
