import type { Metadata } from "next";
import { metadataFor, Rendered, resolveFor } from "@/site/route";

// The published site: only published snapshots, rendered with the approved brand.
type Props = PageProps<"/site/[projectId]/[[...slug]]">;

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  return metadataFor(await resolveFor(params, "published"), "published");
}

export default async function Page({ params }: Props) {
  return <Rendered r={await resolveFor(params, "published")} />;
}
