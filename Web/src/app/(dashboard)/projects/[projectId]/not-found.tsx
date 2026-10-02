import Link from "next/link";

export default function ProjectNotFound() {
  return (
    <div className="card empty">
      <h1>Project not found</h1>
      <p className="muted">It may have been removed, or the link is wrong.</p>
      <Link className="button primary" href="/projects">
        All projects
      </Link>
    </div>
  );
}
