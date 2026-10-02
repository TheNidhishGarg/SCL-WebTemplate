import { strToU8, zipSync } from "fflate";
import { z } from "zod";
import type { SourceAnalysis } from "@/domain/source-analysis";
import { ANALYST_FINDINGS_SCHEMA, AnalystFindings, AUTHORIZATION_LABELS, extractionAllowed, type Source } from "@/domain/wf03";
import type { SourceFile } from "./archive";

// The analysis kit: everything an analyst needs to continue the analysis in
// VS Code with Claude Code, and the exact shape to hand results back in.
// The work happens there; this app only checks what comes back.

export function claudeInstructions(source: Source, analysis: SourceAnalysis, digest: string): string {
  const allowed = extractionAllowed(source.authorization.basis);
  return `# WF-03 analysis kit: ${source.label}

You are continuing a source-code analysis for a website project. This folder holds:

- \`source/\`: the source exactly as supplied (archive SHA-256 \`${source.archive.sha256}\`${analysis.rootPrefix ? `, top folder \`${analysis.rootPrefix}\` stripped` : ""}).
- \`analysis.json\`: the automated scan (\`${analysis.schema}\`, analyzer ${analysis.analyzerVersion}, digest \`${digest}\`).
- \`findings.schema.json\`: the JSON Schema your output must match.
- \`findings.example.json\`: a minimal valid example.

## Authority

This source is: **${AUTHORIZATION_LABELS[source.authorization.basis]}**${source.authorization.license ? ` (licence: ${source.authorization.license})` : ""}.
${
  allowed
    ? "Templates you identify may later be extracted into the project workspace, keeping their provenance."
    : "**It is for study only.** Describe what you learn. Do not copy its code, copy, images or fonts into any client work, and do not propose doing so."
}

## Task

Read \`analysis.json\` first: it already lists files, routes, components, styles, assets, dependencies, risks and open questions. Then study \`source/\` and add what the scanner could not determine:

1. Page templates, layout patterns, navigation, reusable sections and components, and interaction behaviour (how things move, when, and what triggers them).
2. Responsive behaviour beyond the breakpoints listed.
3. Security, accessibility, dependency and licensing concerns the scanner missed.
4. Questions that need a person to answer.

## Rules

- **Facts vs assumptions.** A \`fact\` is something you can point to in \`source/\`: cite the file path (relative to \`source/\`) and, where possible, the line. Anything else, including conclusions from facts, is an \`assumption\`. Never present an assumption as a fact.
- **Cite only real files.** Every path is checked against the source on import, and a finding citing a path that does not exist rejects the whole file.
- **Do not invent.** If you cannot tell, add a question instead of a guess. Built or minified code does not reveal original component boundaries; say so rather than reconstructing them.
- **A screenshot or rendering is not source.** Never describe an approximation as extracted code.
- **Templates** you propose must list the source files they are made of.
- Do not modify \`source/\`.

## Output

Write \`findings.json\` in this folder, matching \`findings.schema.json\`, with \`"scanDigest": "${digest}"\`, then import it on the source's page in the dashboard (WF-03 → Import findings).
`;
}

export function buildKit(source: Source, analysis: SourceAnalysis, digest: string, files: SourceFile[]): Uint8Array {
  const example = {
    schema: ANALYST_FINDINGS_SCHEMA,
    scanDigest: digest,
    findings: [
      analysis.files[0]
        ? { basis: "fact", topic: "other", statement: `The source contains ${analysis.files[0].path}.`, evidence: [{ path: analysis.files[0].path, line: null }] }
        : { basis: "assumption", topic: "other", statement: "Example assumption.", evidence: [] },
    ],
    questions: [{ topic: "licensing", text: "Example: who owns the illustrations?" }],
    templates: [],
  };
  const entries: Record<string, Uint8Array> = {
    "CLAUDE.md": strToU8(claudeInstructions(source, analysis, digest)),
    "analysis.json": strToU8(JSON.stringify(analysis, null, 2)),
    "findings.schema.json": strToU8(JSON.stringify(z.toJSONSchema(AnalystFindings, { io: "input" }), null, 2)),
    "findings.example.json": strToU8(JSON.stringify(example, null, 2)),
  };
  for (const f of files) entries[`source/${f.path}`] = f.bytes;
  return zipSync(entries, { level: 6 });
}
