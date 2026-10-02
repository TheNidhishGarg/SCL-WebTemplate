import Link from "next/link";
import { requireDashboardAccess } from "@/server/access";
import "./dashboard.css";

// Project data changes on every action; nothing here may be prerendered.
export const dynamic = "force-dynamic";

export default function DashboardLayout({ children }: LayoutProps<"/">) {
  let denied: string | null = null;
  try {
    requireDashboardAccess();
  } catch (e) {
    // By name, not instanceof: see src/server/http.ts.
    if ((e as Error)?.name !== "AccessDeniedError") throw e;
    denied = (e as Error).message;
  }

  return (
    <>
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <header className="topbar">
        <Link href="/projects">SCL Web</Link>
        <span className="muted small">WF-01 Client brief</span>
      </header>
      <main id="main" className="shell">
        {denied ? (
          <div className="card empty" role="alert">
            <h1>Dashboard unavailable</h1>
            <p className="muted">{denied}</p>
          </div>
        ) : (
          children
        )}
      </main>
    </>
  );
}
