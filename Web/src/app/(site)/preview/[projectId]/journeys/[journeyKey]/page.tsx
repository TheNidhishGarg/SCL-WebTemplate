import type { Metadata } from "next";
import { journeyMetadata, JourneyRoute } from "@/site/journey-route";

// Preview: the approved journey assembled now, with whatever media is approved
// so far (scenes without it play as title cards). Never indexed.
type Props = PageProps<"/preview/[projectId]/journeys/[journeyKey]">;

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  return journeyMetadata(params, "preview");
}

export default async function Page({ params }: Props) {
  return <JourneyRoute params={params} mode="preview" />;
}
