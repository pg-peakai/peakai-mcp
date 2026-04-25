import { z } from "zod";
import { callExtractor, type ExtractorType } from "./peakai";

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: { type: "object"; properties: Record<string, unknown>; required: string[] };
  run: (args: { profile_url: string }, ctx: { jwt: string; apiBase: string }) => Promise<unknown>;
}

const linkedinUrl = z.string().url().describe("Full LinkedIn profile URL, e.g. https://www.linkedin.com/in/johndoe");

function makeExtractorTool(
  name: string,
  description: string,
  type: ExtractorType,
): ToolDef {
  return {
    name,
    description,
    inputSchema: {
      type: "object",
      properties: {
        profile_url: {
          type: "string",
          description: "Full LinkedIn profile URL",
        },
      },
      required: ["profile_url"],
    },
    async run({ profile_url }, { jwt, apiBase }) {
      linkedinUrl.parse(profile_url);
      return await callExtractor(apiBase, jwt, type, profile_url);
    },
  };
}

export const TOOLS: ToolDef[] = [
  makeExtractorTool(
    "find_personal_email",
    "Find the personal email address for a LinkedIn profile. Costs 1 credit.",
    "email",
  ),
  makeExtractorTool(
    "find_work_email",
    "Find the work (corporate) email address for a LinkedIn profile.",
    "work_email",
  ),
  makeExtractorTool(
    "find_phone",
    "Find the phone number for a LinkedIn profile.",
    "phone_no",
  ),
  makeExtractorTool(
    "enrich_profile",
    "Return enriched profile data (name, headline, company, location, experience, etc.) for a LinkedIn URL.",
    "profile_enrichment",
  ),
  makeExtractorTool(
    "reverse_lookup",
    "Reverse-lookup a contact from a LinkedIn URL.",
    "reverse_lookup",
  ),
  makeExtractorTool(
    "find_din_phone",
    "DIN-based phone lookup (India directors) for a LinkedIn profile.",
    "din_phone",
  ),
  makeExtractorTool(
    "find_din_email",
    "DIN-based email lookup (India directors) for a LinkedIn profile.",
    "din_email",
  ),
];

export const TOOLS_BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));
