import "dotenv/config";
import { z } from "zod";

const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  GOOGLE_WALLET_ISSUER_ID: z.string().min(1),
  GOOGLE_WALLET_CLASS_ID: z.string().min(1),
  GOOGLE_SERVICE_ACCOUNT_EMAIL: z.string().email(),
  GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: z.string().min(1),
  DATABASE_URL: z.string().url().optional(),
  DATABASE_SSL: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
  JWT_SECRET: z.string().min(32).optional(),
  PUBLIC_BASE_URL: z.string().url().optional()
});

export const env = envSchema.parse({
  PORT: process.env.PORT,
  GOOGLE_WALLET_ISSUER_ID: process.env.GOOGLE_WALLET_ISSUER_ID,
  GOOGLE_WALLET_CLASS_ID: process.env.GOOGLE_WALLET_CLASS_ID,
  GOOGLE_SERVICE_ACCOUNT_EMAIL: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
  GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY:
    process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY?.replace(/\\n/g, "\n"),
  DATABASE_URL: process.env.DATABASE_URL,
  DATABASE_SSL: process.env.DATABASE_SSL,
  JWT_SECRET: process.env.JWT_SECRET,
  PUBLIC_BASE_URL: process.env.PUBLIC_BASE_URL
});
