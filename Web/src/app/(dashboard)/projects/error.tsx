"use client";

// Shown when a page fails to load its data (for example the database cannot
// be opened). Production hides the server message, so point at the logs.
export default function ProjectsError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="card empty" role="alert">
      <h1>Could not load projects</h1>
      <p className="muted">
        The project data could not be read.
        {error.digest ? ` Reference ${error.digest} in the server log.` : " Check the server log for details."}
      </p>
      <button type="button" className="button primary" onClick={reset}>
        Try again
      </button>
    </div>
  );
}
