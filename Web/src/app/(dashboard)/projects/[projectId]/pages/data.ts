import "server-only";
import type { PickerData } from "@/components/content/section-fields";
import { SECTION_LABELS } from "@/domain/content";
import type { Store } from "@/server/store";

const IMAGE = /\.(png|jpe?g|webp|gif|avif|svg)$/i;

// What the editors need to offer: pages and their sections as link targets,
// register images, and the brief's desired actions.
export function pickerData(store: Store, projectId: string): PickerData {
  const detail = store.getProject(projectId)!;
  return {
    pages: store.content.pages(projectId).map((p) => ({
      id: p.id,
      title: p.content.title,
      sections: p.content.sections.map((s, i) => ({ id: s.id, label: `${i + 1}. ${SECTION_LABELS[s.type]}${"heading" in s && s.heading ? `: ${s.heading.slice(0, 40)}` : ""}` })),
    })),
    images: detail.assets.filter((a) => a.source.type === "upload" && IMAGE.test(a.source.file.filename)).map((a) => ({ id: a.id, label: a.label })),
    actionKinds: [...new Set(detail.approved?.content?.desiredActions.map((a) => a.kind) ?? [])],
  };
}
