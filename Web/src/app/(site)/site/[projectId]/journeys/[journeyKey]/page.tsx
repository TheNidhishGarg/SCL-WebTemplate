import type { Metadata } from "next";
import { journeyMetadata, JourneyRoute } from "@/site/journey-route";

// A published WF-08 journey: the newest live release, inside the site.
type Props = PageProps<"/site/[projectId]/journeys/[journeyKey]">;

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  return journeyMetadata(params, "published");
}

export default async function Page({ params }: Props) {
  return <JourneyRoute params={params} mode="published" />;
}
