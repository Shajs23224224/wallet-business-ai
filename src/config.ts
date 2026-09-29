import { z } from "zod";

const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  GOOGLE_WALLET_ISSUER_ID: z.string().min(1),
  GOOGLE_WALLET_CLASS_ID: z.string().min(1),
  GOOGLE_SERVICE_ACCOUNT_EMAIL: z.string().email(),
  GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: z.string().min(1)
});

export const env = envSchema.parse({
  PORT: process.env.PORT,
  GOOGLE_WALLET_ISSUER_ID: process.env.GOOGLE_WALLET_ISSUER_ID,
  GOOGLE_WALLET_CLASS_ID: process.env.GOOGLE_WALLET_CLASS_ID,
  GOOGLE_SERVICE_ACCOUNT_EMAIL: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
  GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY?.replace(/\\n/g, "\n")
});
