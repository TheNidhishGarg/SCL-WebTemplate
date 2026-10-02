import type { Metadata } from "next";
import { metadataFor, Rendered, resolveFor } from "@/site/route";

// Preview: the latest content of every page, rendered with the approved brand
// (or the latest brand draft if none is approved). Never indexed.
type Props = PageProps<"/preview/[projectId]/[[...slug]]">;

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  return metadataFor(await resolveFor(params, "preview"), "preview");
}

export default async function Page({ params }: Props) {
  return <Rendered r={await resolveFor(params, "preview")} />;
}
