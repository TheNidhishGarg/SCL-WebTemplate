// Facts read from a media file's bytes, so a take's checks rest on what the
// file actually is, not on what a provider or uploader said it was.
//
// MP4/MOV (ISO base media file format): container brand, duration from mvhd,
// track types from hdlr, dimensions from tkhd. PNG/JPEG: dimensions.
// Decoding frames - whether it truly plays, whether text is visible - is not
// possible here; the reviewer confirms those by watching (see review).

export type MediaFacts = {
  container: "mp4" | "mov" | "png" | "jpeg" | "unknown";
  mimeType: string;
  durationSeconds: number | null;
  width: number | null;
  height: number | null;
  hasVideo: boolean;
  hasAudio: boolean;
  problems: string[];
};

const u32 = (b: Uint8Array, o: number) => ((b[o] << 24) >>> 0) + (b[o + 1] << 16) + (b[o + 2] << 8) + b[o + 3];
const u64 = (b: Uint8Array, o: number) => u32(b, o) * 2 ** 32 + u32(b, o + 4);
const str = (b: Uint8Array, o: number, n: number) => String.fromCharCode(...b.subarray(o, o + n));

type Box = { type: string; start: number; body: number; end: number };

function boxes(b: Uint8Array, from: number, to: number): Box[] {
  const out: Box[] = [];
  let o = from;
  while (o + 8 <= to) {
    let size = u32(b, o);
    const type = str(b, o + 4, 4);
    let body = o + 8;
    if (size === 1) {
      if (o + 16 > to) break;
      size = u64(b, o + 8);
      body = o + 16;
    } else if (size === 0) size = to - o;
    if (size < 8 || o + size > to) break; // truncated or corrupt: stop rather than guess
    out.push({ type, start: o, body, end: o + size });
    o += size;
  }
  return out;
}

function probeIsoBmff(b: Uint8Array): MediaFacts {
  const facts: MediaFacts = { container: "unknown", mimeType: "application/octet-stream", durationSeconds: null, width: null, height: null, hasVideo: false, hasAudio: false, problems: [] };
  const top = boxes(b, 0, b.length);
  const ftyp = top.find((x) => x.type === "ftyp");
  if (!ftyp) {
    facts.problems.push("Not an MP4/MOV file (no ftyp box)");
    return facts;
  }
  const brand = str(b, ftyp.body, 4);
  facts.container = brand === "qt  " ? "mov" : "mp4";
  facts.mimeType = facts.container === "mov" ? "video/quicktime" : "video/mp4";
  const moov = top.find((x) => x.type === "moov");
  if (!moov) {
    facts.problems.push("No movie header (moov box): the file is incomplete or not playable");
    return facts;
  }
  const inMoov = boxes(b, moov.body, moov.end);
  const mvhd = inMoov.find((x) => x.type === "mvhd");
  if (mvhd) {
    const v = b[mvhd.body];
    const ts = v === 1 ? u32(b, mvhd.body + 20) : u32(b, mvhd.body + 12);
    const dur = v === 1 ? u64(b, mvhd.body + 24) : u32(b, mvhd.body + 16);
    if (ts > 0) facts.durationSeconds = Math.round((dur / ts) * 1000) / 1000;
  } else facts.problems.push("No duration (mvhd box)");
  for (const trak of inMoov.filter((x) => x.type === "trak")) {
    const inTrak = boxes(b, trak.body, trak.end);
    const mdia = inTrak.find((x) => x.type === "mdia");
    const hdlr = mdia ? boxes(b, mdia.body, mdia.end).find((x) => x.type === "hdlr") : undefined;
    const handler = hdlr ? str(b, hdlr.body + 8, 4) : "";
    if (handler === "soun") facts.hasAudio = true;
    if (handler === "vide") {
      facts.hasVideo = true;
      const tkhd = inTrak.find((x) => x.type === "tkhd");
      if (tkhd) {
        const v = b[tkhd.body];
        const o = tkhd.body + (v === 1 ? 88 : 76); // width/height (16.16 fixed) follow the matrix
        facts.width = u32(b, o) >>> 16;
        facts.height = u32(b, o + 4) >>> 16;
      }
    }
  }
  return facts;
}

function probeImage(b: Uint8Array): MediaFacts | null {
  const base = { durationSeconds: null, hasVideo: false, hasAudio: false, problems: [] as string[] };
  if (b.length >= 24 && b[0] === 0x89 && str(b, 1, 3) === "PNG") {
    return { ...base, container: "png", mimeType: "image/png", width: u32(b, 16), height: u32(b, 20) };
  }
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    let o = 2;
    while (o + 9 < b.length) {
      if (b[o] !== 0xff) break;
      const marker = b[o + 1];
      const len = (b[o + 2] << 8) + b[o + 3];
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { ...base, container: "jpeg", mimeType: "image/jpeg", height: (b[o + 5] << 8) + b[o + 6], width: (b[o + 7] << 8) + b[o + 8] };
      }
      o += 2 + len;
    }
    return { ...base, container: "jpeg", mimeType: "image/jpeg", width: null, height: null, problems: ["JPEG dimensions not found"] };
  }
  return null;
}

export function probeMedia(bytes: Uint8Array): MediaFacts {
  return probeImage(bytes) ?? probeIsoBmff(bytes);
}

// Test and fixture helper: a structurally valid MP4 header (no frames) with
// the given duration and dimensions. Enough for the probe; not a playable film.
export function synthMp4({ durationSeconds, width, height, audio = false, brand = "isom" }: { durationSeconds: number; width: number; height: number; audio?: boolean; brand?: string }): Uint8Array {
  const box = (type: string, ...parts: Uint8Array[]) => {
    const len = 8 + parts.reduce((n, p) => n + p.length, 0);
    const out = new Uint8Array(len);
    const dv = new DataView(out.buffer);
    dv.setUint32(0, len);
    out.set(new TextEncoder().encode(type), 4);
    let o = 8;
    for (const p of parts) {
      out.set(p, o);
      o += p.length;
    }
    return out;
  };
  const bytes = (n: number, fill: (dv: DataView) => void) => {
    const a = new Uint8Array(n);
    fill(new DataView(a.buffer));
    return a;
  };
  const ts = 1000;
  const mvhd = box("mvhd", bytes(100, (d) => (d.setUint32(12, ts), d.setUint32(16, Math.round(durationSeconds * ts)))));
  const tkhd = box("tkhd", bytes(84, (d) => (d.setUint32(76, width << 16), d.setUint32(80, height << 16))));
  const hdlr = (h: string) => box("hdlr", bytes(24, (d) => [...h].forEach((c, i) => d.setUint8(8 + i, c.charCodeAt(0)))));
  const trak = (h: string) => box("trak", tkhd, box("mdia", hdlr(h)));
  const ftyp = box("ftyp", new TextEncoder().encode(brand.padEnd(4).slice(0, 4)), bytes(4, () => {}));
  return new Uint8Array([...ftyp, ...box("moov", mvhd, trak("vide"), ...(audio ? [trak("soun")] : [])), ...box("mdat", bytes(16, () => {}))]);
}
