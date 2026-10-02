"use client";

import { publishJourneyAction, withdrawJourneyAction } from "@/app/(dashboard)/projects/experience-actions";
import { useAction } from "../use-action";

export function PublishJourneyButtons({ projectId, journeyId, ready, live }: { projectId: string; journeyId: string; ready: boolean; live: boolean }) {
  const pub = useAction(publishJourneyAction);
  const wd = useAction(withdrawJourneyAction);
  const failed = [pub.result, wd.result].find((r) => r && !r.ok);
  return (
    <div>
      {failed && !failed.ok && (
        <div className="alert error small" role="alert">
          {failed.message}
          {failed.issues.length > 0 && (
            <ul>
              {failed.issues.map((i, n) => (
                <li key={n}>{i.message}</li>
              ))}
            </ul>
          )}
        </div>
      )}
      {pub.result?.ok && (
        <p className="alert success small" role="status">
          Release {pub.result.data} is live.
        </p>
      )}
      {wd.result?.ok && (
        <p className="alert success small" role="status">
          Withdrawn. Visitors are sent to the conventional pages.
        </p>
      )}
      <div className="actions">
        <button type="button" className="button primary" disabled={!ready || pub.pending} onClick={() => pub.run(projectId, journeyId)}>
          {pub.pending ? "Publishing…" : "Publish to the website"}
        </button>
        {live && (
          <button type="button" className="button danger" disabled={wd.pending} onClick={() => wd.run(projectId, journeyId)}>
            Withdraw from the website
          </button>
        )}
      </div>
    </div>
  );
}
