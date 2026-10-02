import "./site.css";

// Pages built in WF-05 render here, outside the dashboard's layout and styles.
export const dynamic = "force-dynamic";

export default function SiteLayout({ children }: LayoutProps<"/">) {
  return children;
}
