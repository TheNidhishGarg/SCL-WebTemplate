import { emptyDraft, type ClientBriefDraft } from "./client-brief";

// Test-only data. A brief that passes full validation, for tests to vary.
export const completeConventionalDraft = (): ClientBriefDraft => ({
  ...emptyDraft(),
  deliveryMode: "conventional",
  websiteUrl: "https://anais.example.com",
  industry: "Wedding planning",
  summary: "Editorial portfolio site for a wedding studio.",
  audiences: [{ name: "Couples", description: "Planning a wedding in the next 12 months" }],
  objectives: [{ statement: "30 qualified enquiries a month", priority: "primary" }],
  requiredPages: [
    { slug: "home", title: "Home", purpose: "Introduce the studio" },
    { slug: "contact", title: "Contact", purpose: "Capture enquiries" },
  ],
  desiredActions: [{ kind: "lead_form", description: "Enquiry form" }],
  referenceUrls: [{ url: "https://example.com/journal", note: "" }],
});
