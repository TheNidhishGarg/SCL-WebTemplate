import type { Evidence } from "@/domain/source-analysis";

// Observed and inferred are always labelled the same way, everywhere.
export function BasisBadge({ basis }: { basis: "observed" | "inferred" | "fact" | "assumption" }) {
  const observed = basis === "observed" || basis === "fact";
  return <span className={`badge ${observed ? "ok" : "warn"}`}>{observed ? (basis === "fact" ? "Fact" : "Observed") : basis === "assumption" ? "Assumption" : "Inferred"}</span>;
}

export function EvidenceList({ items, max = 5 }: { items: Evidence[]; max?: number }) {
  if (items.length === 0) return null;
  return (
    <ul className="small muted" style={{ margin: "0.25rem 0 0", paddingLeft: "1.1rem" }}>
      {items.slice(0, max).map((e, i) => (
        <li key={i} style={{ overflowWrap: "anywhere" }}>
          <code>
            {e.path}
            {e.line !== null && `:${e.line}`}
          </code>
          {e.excerpt && <> · {e.excerpt}</>}
        </li>
      ))}
      {items.length > max && <li>and {items.length - max} more</li>}
    </ul>
  );
}
