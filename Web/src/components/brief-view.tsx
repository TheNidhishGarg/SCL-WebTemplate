import { DESIRED_ACTION_LABELS, type ClientBriefContent } from "@/domain/client-brief";
import { DELIVERY_MODE_LABELS } from "@/domain/project";

// Read-only rendering of an approved brief: exactly the content that was
// frozen at approval and that the handoff serves.
export function BriefView({ content }: { content: ClientBriefContent }) {
  return (
    <div className="card">
      <dl className="kv">
        <dt>Deliverable</dt>
        <dd>{DELIVERY_MODE_LABELS[content.deliveryMode]}</dd>
        <dt>Industry</dt>
        <dd>{content.industry}</dd>
        <dt>Current website</dt>
        <dd>{content.websiteUrl ?? "None"}</dd>
        <dt>Summary</dt>
        <dd style={{ whiteSpace: "pre-wrap" }}>{content.summary}</dd>
        <dt>Target audiences</dt>
        <dd>
          <ul>
            {content.audiences.map((a, i) => (
              <li key={i}>
                <strong>{a.name}</strong> – {a.description}
              </li>
            ))}
          </ul>
        </dd>
        <dt>Business objectives</dt>
        <dd>
          <ul>
            {content.objectives.map((o, i) => (
              <li key={i}>
                {o.statement} <span className="muted small">({o.priority})</span>
              </li>
            ))}
          </ul>
        </dd>
        {content.requiredPages.length > 0 && (
          <>
            <dt>Required pages</dt>
            <dd>
              <ul>
                {content.requiredPages.map((p) => (
                  <li key={p.slug}>
                    <strong>{p.title}</strong> <code>/{p.slug}</code> – {p.purpose}
                  </li>
                ))}
              </ul>
            </dd>
          </>
        )}
        <dt>Desired actions</dt>
        <dd>
          <ul>
            {content.desiredActions.map((a, i) => (
              <li key={i}>
                {DESIRED_ACTION_LABELS[a.kind]}: {a.description}
              </li>
            ))}
          </ul>
        </dd>
        <dt>Reference websites</dt>
        <dd>
          {content.referenceUrls.length === 0 ? (
            "None"
          ) : (
            <ul>
              {content.referenceUrls.map((r, i) => (
                <li key={i}>
                  {r.url}
                  {r.note && <span className="muted"> – {r.note}</span>}
                </li>
              ))}
            </ul>
          )}
        </dd>
        {content.cinematic && (
          <>
            <dt>Cinematic journey</dt>
            <dd>
              <p style={{ margin: 0, whiteSpace: "pre-wrap" }}>{content.cinematic.intent}</p>
              <span className="muted small">
                Target runtime {content.cinematic.targetRuntimeSeconds}s ·{" "}
                {content.cinematic.branching ? "branching" : "single path"}
              </span>
            </dd>
          </>
        )}
        <dt>Languages</dt>
        <dd>{content.constraints.locales.join(", ")}</dd>
        <dt>Launch date</dt>
        <dd>{content.constraints.launchDate ?? "Not set"}</dd>
        {content.constraints.items.length > 0 && (
          <>
            <dt>Constraints</dt>
            <dd>
              <ul>
                {content.constraints.items.map((c, i) => (
                  <li key={i}>
                    <span className="muted">{c.category}:</span> {c.detail}
                  </li>
                ))}
              </ul>
            </dd>
          </>
        )}
      </dl>
    </div>
  );
}
