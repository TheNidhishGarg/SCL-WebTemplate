import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Browser } from "@playwright/test";

// TEST FIXTURE MEDIA. Encodes a short, real, playable MP4 in the browser
// (WebCodecs + Mediabunny) so the journey runtime can be tested with actual
// playback. Every frame is stamped "TEST FIXTURE"; it is uploaded through
// WF-07 as "E2E test fixture" and is never production footage.
export async function makeFixtureVideo(browser: Browser, { seconds, width = 320, height = 180, label }: { seconds: number; width?: number; height?: number; label: string }): Promise<Buffer> {
  const page = await browser.newPage();
  const lib = readFileSync(join(process.cwd(), "node_modules/mediabunny/dist/bundles/mediabunny.min.mjs"), "utf8");
  // localhost is a secure context, which WebCodecs requires; nothing is served from the network.
  await page.route("http://localhost:9/**", (route) =>
    route.request().url().endsWith(".mjs")
      ? route.fulfill({ contentType: "text/javascript", body: lib })
      : route.fulfill({ contentType: "text/html", body: "<!doctype html><canvas></canvas>" }),
  );
  await page.goto("http://localhost:9/");
  const bytes = await page.evaluate(
    async ({ seconds, width, height, label }) => {
      const mb = await import("http://localhost:9/mediabunny.mjs" as string);
      const canvas = document.querySelector("canvas")!;
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d")!;
      const codec = (await mb.canEncodeVideo("avc", { width, height })) ? "avc" : "vp9";
      const output = new mb.Output({ format: new mb.Mp4OutputFormat({ fastStart: "in-memory" }), target: new mb.BufferTarget() });
      const source = new mb.CanvasSource(canvas, { codec, bitrate: 200_000, keyFrameInterval: 1 });
      const fps = 10;
      output.addVideoTrack(source, { frameRate: fps });
      await output.start();
      for (let i = 0; i < seconds * fps; i++) {
        ctx.fillStyle = `hsl(${(i * 4) % 360} 40% 30%)`;
        ctx.fillRect(0, 0, width, height);
        ctx.fillStyle = "#fff";
        ctx.font = `bold ${Math.round(height / 9)}px sans-serif`;
        ctx.fillText("TEST FIXTURE", 10, height / 3);
        ctx.fillText(`${label} · ${(i / fps).toFixed(1)}s`, 10, height / 2);
        await source.add(i / fps, 1 / fps);
      }
      await output.finalize();
      return Array.from(new Uint8Array(output.target.buffer as ArrayBuffer));
    },
    { seconds, width, height, label },
  );
  await page.close();
  return Buffer.from(bytes);
}
