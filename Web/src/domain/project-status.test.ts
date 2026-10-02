import { describe, expect, it } from "vitest";
import { emptyDraft, type ClientBrief } from "./client-brief";
import type { Project } from "./project";
import { summariseProject } from "./project-status";
import { completeConventionalDraft } from "./test-fixtures";

const project: Project = {
  id: "7c9e6679-7425-40de-944b-e07fc1f90ae7" as Project["id"],
  slug: "p",
  name: "P",
  clientName: "C",
  dashboardClientId: null,
  status: "active",
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
};
const approved = (): ClientBrief => {
  const draft = completeConventionalDraft();
  return {
    id: "0f8fad5b-d9cb-469f-a165-70867728950e" as ClientBrief["id"],
    projectId: project.id,
    version: 1,
    status: "approved",
    draft,
    content: {
      ...draft,
      deliveryMode: "conventional",
      websiteUrl: null,
      cinematic: null,
      referenceUrls: [],
      constraints: { locales: ["en-IN"], launchDate: null, items: [] },
    },
    createdAt: project.createdAt,
    updatedAt: project.createdAt,
    approvedAt: project.createdAt,
  };
};
const labels = (s: ReturnType<typeof summariseProject>) => s.nextActions.map((a) => a.label);

describe("summariseProject: WF-02 actions", () => {
  it("points an approved website brief at the reference library until it has references", () => {
    const s = summariseProject(project, approved(), 1, [{ kind: "logo" }], { total: 0, failed: 0 });
    expect(s.nextActions).toContainEqual({ label: expect.stringMatching(/^Start WF-02/), href: `/projects/${project.id}/references` });
    const t = summariseProject(project, approved(), 1, [{ kind: "logo" }], { total: 3, failed: 0 });
    expect(labels(t).some((l) => l.startsWith("Start WF-02"))).toBe(false);
  });

  it("surfaces failed acquisitions with a link to them, before approval too", () => {
    const draft: ClientBrief = { ...approved(), status: "draft", draft: emptyDraft(), content: null, approvedAt: null };
    const s = summariseProject(project, draft, null, [], { total: 2, failed: 1 });
    expect(s.nextActions).toContainEqual({
      label: "1 reference failed acquisition: recover or record manually",
      href: `/projects/${project.id}/references?status=failed`,
    });
  });
});
