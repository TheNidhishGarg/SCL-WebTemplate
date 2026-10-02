import "server-only";

// ?version=approved (default) | latest | <number>
export function versionParam(url: string): "approved" | "latest" | number {
  const v = new URL(url).searchParams.get("version") ?? "approved";
  if (v === "approved" || v === "latest") return v;
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : "approved";
}
