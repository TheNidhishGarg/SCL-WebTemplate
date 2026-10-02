export default function Loading() {
  return (
    <div aria-busy="true" aria-live="polite">
      <span className="visually-hidden">Loading…</span>
      <div className="skeleton" style={{ height: "2.2rem", width: "14rem", marginBottom: "2rem" }} />
      <div className="skeleton" style={{ height: "5rem", marginBottom: "1rem" }} />
      <div className="skeleton" style={{ height: "16rem" }} />
    </div>
  );
}
