import type { Metadata } from "next";
import "./globals.css";

// Root layout only. The dashboard and the published visitor site will each get
// their own route group and layout; brand fonts and tokens come from WF-04, so
// none are hard-coded here.
export const metadata: Metadata = {
  title: "SCL Web",
  description: "Website and cinematic journey production system",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en">
      {/* Browser extensions (Grammarly, password managers) add attributes to <body> before hydration; ignore those, one level deep only. */}
      <body suppressHydrationWarning>{children}</body>
    </html>
  );
}
