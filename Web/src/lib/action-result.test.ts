import { describe, expect, it, vi } from "vitest";
import { StoreError } from "@/server/store/store";
import { toActionResult } from "./action-result";

describe("toActionResult", () => {
  it("is ok only when the work completed", async () => {
    expect(await toActionResult(() => 7)).toEqual({ ok: true, data: 7 });
  });

  it("passes expected errors through with their field issues", async () => {
    const r = await toActionResult(() => {
      throw new StoreError("invalid", "Check the highlighted fields.", [{ path: "name", message: "Project name is required" }]);
    });
    expect(r).toEqual({ ok: false, message: "Check the highlighted fields.", issues: [{ path: "name", message: "Project name is required" }] });
  });

  it("reports an unexpected failure as not saved, without leaking internals", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const r = await toActionResult(() => {
      throw new Error("SQLITE_BUSY: database is locked at /srv/data/scl.sqlite");
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.message).toMatch(/^Not saved/);
      expect(r.message).not.toContain("SQLITE");
      expect(r.message).not.toContain("/srv");
    }
    expect(log).toHaveBeenCalled();
    log.mockRestore();
  });
});
