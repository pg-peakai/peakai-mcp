import { z } from "zod";
import { callExtractor, enrichByEmail, enrichByName, getCredits, type ExtractorType } from "./peakai";

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: { type: "object"; properties: Record<string, unknown>; required: string[] };
  run: (args: Record<string, unknown>, ctx: { jwt: string; apiBase: string }) => Promise<unknown>;
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
    async run(args, { jwt, apiBase }) {
      const profile_url = String(args.profile_url ?? "");
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
    "find_din_phone",
    "DIN-based phone lookup (India directors) for a LinkedIn profile.",
    "din_phone",
  ),
  makeExtractorTool(
    "find_din_email",
    "DIN-based email lookup (India directors) for a LinkedIn profile.",
    "din_email",
  ),
  {
    name: "enrich_by_email",
    description:
      "Given an email address, return enriched profile data (name, company, role, LinkedIn, etc.) by reverse-looking up that email.",
    inputSchema: {
      type: "object",
      properties: { email: { type: "string", description: "Email address to enrich" } },
      required: ["email"],
    },
    async run(args, { jwt, apiBase }) {
      const email = String(args.email ?? "").trim();
      if (!email || !email.includes("@")) throw new Error("Provide a valid email address.");
      return await enrichByEmail(apiBase, jwt, email);
    },
  },
  {
    name: "enrich_by_name",
    description:
      "Given a person's name and company (and optionally their role), find and return their profile / contact data.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Full name of the person" },
        company: { type: "string", description: "Their company name" },
        role: { type: "string", description: "Their job title or role (optional but improves accuracy)" },
      },
      required: ["name", "company"],
    },
    async run(args, { jwt, apiBase }) {
      const name = String(args.name ?? "").trim();
      const company = String(args.company ?? "").trim();
      const role = args.role ? String(args.role).trim() : undefined;
      if (!name || !company) throw new Error("Both name and company are required.");
      return await enrichByName(apiBase, jwt, name, company, role);
    },
  },
  {
    name: "check_credits",
    description:
      "Check the current PeakAI credit balance for the authenticated user. Returns individual credits, organisation credits (if applicable), and the effective balance used for lookups.",
    inputSchema: { type: "object", properties: {}, required: [] },
    async run(_args, { jwt, apiBase }) {
      return await getCredits(apiBase, jwt);
    },
  },
];

export const TOOLS_BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));
