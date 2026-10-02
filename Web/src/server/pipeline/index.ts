import "server-only";
import { isAbsolute, join } from "node:path";
import { createLocalRunner, resolveSarHome } from "@/server/integrations/sar-runner";
import { getEnv } from "@/server/env";
import { getStore } from "@/server/store";
import { createTemplatePipeline, type TemplatePipeline } from "./template-pipeline";

// One pipeline per server process, on globalThis so dev hot reloads reuse it
// (and the processes it is watching). Recovery runs once, on first use.
const g = globalThis as typeof globalThis & { __sclTemplatePipeline?: TemplatePipeline };

export function getTemplatePipeline(): TemplatePipeline {
  if (g.__sclTemplatePipeline) return g.__sclTemplatePipeline;
  const env = getEnv();
  const dataDir = isAbsolute(env.SCL_DATA_DIR) ? env.SCL_DATA_DIR : join(/*turbopackIgnore: true*/ process.cwd(), env.SCL_DATA_DIR);
  const runner = createLocalRunner({ home: resolveSarHome(env), runsDir: join(dataDir, "sar-runs") });
  const pipeline = createTemplatePipeline({
    store: getStore(),
    runner,
    defaults: { maxPages: env.SAR_MAX_PAGES, maxDepth: env.SAR_MAX_DEPTH, maxMinutes: env.SAR_MAX_MINUTES },
  });
  g.__sclTemplatePipeline = pipeline;
  pipeline.recover();
  return pipeline;
}
