import { GoogleGenAI } from "@google/genai";
import { z } from "zod";
import { env } from "./config.js";
import type { Business } from "./store.js";

export const aiOfferDraftSchema = z.object({
  title: z.string().trim().min(2).max(60),
  details: z.string().trim().min(2).max(500),
  finePrint: z.string().trim().max(1000).nullable(),
  redemptionChannel: z.enum(["INSTORE", "ONLINE", "BOTH"]),
  code: z.string().trim().min(2).max(64).regex(/^[A-Za-z0-9_-]+$/),
  startsAt: z.string().datetime({ offset: true }).nullable(),
  endsAt: z.string().datetime({ offset: true }).nullable()
});

export type AiOfferDraft = z.infer<typeof aiOfferDraftSchema>;

const offerDraftJsonSchema = {
  type: "object",
  properties: {
    title: {
      type: "string",
      description: "Short commercial title for the offer, maximum 60 characters."
    },
    details: {
      type: "string",
      description: "Customer-facing offer description, maximum 500 characters."
    },
    finePrint: {
      type: ["string", "null"],
      description: "Optional conditions or restrictions. Use null when none are needed."
    },
    redemptionChannel: {
      type: "string",
      enum: ["INSTORE", "ONLINE", "BOTH"],
      description: "Where the coupon can be redeemed."
    },
    code: {
      type: "string",
      description: "Unique-looking coupon code using only ASCII letters, digits, underscore or hyphen."
    },
    startsAt: {
      type: ["string", "null"],
      description: "Start date as an ISO 8601 timestamp with timezone offset. Use null when unspecified."
    },
    endsAt: {
      type: ["string", "null"],
      description: "End date as an ISO 8601 timestamp with timezone offset. Use null when unspecified."
    }
  },
  required: ["title", "details", "finePrint", "redemptionChannel", "code", "startsAt", "endsAt"]
} as const;

function geminiClient() {
  if (!env.GEMINI_API_KEY) {
    throw new Error("GEMINI_NOT_CONFIGURED");
  }

  return new GoogleGenAI({ apiKey: env.GEMINI_API_KEY });
}

function extractJson(text: string) {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) {
      return JSON.parse(trimmed.slice(start, end + 1));
    }
    throw new Error("GEMINI_INVALID_JSON");
  }
}

export async function generateOfferDraft(
  business: Pick<Business, "name" | "programName">,
  prompt: string
): Promise<AiOfferDraft> {
  const client = geminiClient();
  const now = new Date().toISOString();

  const input = [
    "You are the campaign assistant for a small-business Google Wallet coupon SaaS.",
    "Create one practical coupon campaign draft from the user's request.",
    "Return only JSON matching the supplied schema.",
    "Never invent a business identity, legal guarantee, customer data, or discount terms that the user did not request.",
    "Use concise Spanish suitable for Colombian small businesses unless the user clearly requests another language.",
    "If the user does not specify a start or end date, use null.",
    "For relative durations such as '7 days', calculate from the current timestamp.",
    "All timestamps must be ISO 8601 and include a timezone offset.",
    "The coupon code must use only A-Z/a-z, digits, underscore and hyphen.",
    "Current timestamp:",
    now,
    "Business name:",
    business.name,
    "Program name:",
    business.programName,
    "User request:",
    prompt
  ].join("\n");

  const response = await client.models.generateContent({
    model: env.GEMINI_MODEL,
    contents: input,
    config: {
      responseMimeType: "application/json",
      responseSchema: offerDraftJsonSchema
    }
  });

  const text = typeof response.text === "string" ? response.text.trim() : "";
  if (!text) {
    throw new Error("GEMINI_EMPTY_RESPONSE");
  }

  return aiOfferDraftSchema.parse(extractJson(text));
}
