import express from "express";
import { z } from "zod";
import { env } from "./config.js";
import {
  createAddToWalletUrl,
  ensureLoyaltyClass,
  ensureLoyaltyObject
} from "./wallet.js";

const app = express();
app.use(express.json());
app.use(express.static("public"));

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "wallet-business-ai" });
});

app.post("/api/wallet/loyalty/class", async (_req, res) => {
  try {
    const result = await ensureLoyaltyClass();
    res.status(200).json({ ok: true, data: result.data });
  } catch (error) {
    console.error(error);
    res.status(502).json({
      ok: false,
      error: "Unable to create or retrieve loyalty class"
    });
  }
});

const customerSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]+$/).max(64),
  name: z.string().min(1).max(120),
  points: z.number().int().nonnegative().optional()
});

app.post("/api/wallet/loyalty", async (req, res) => {
  const parsed = customerSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ ok: false, error: parsed.error.flatten() });
    return;
  }

  try {
    const data = await ensureLoyaltyObject(parsed.data);
    const addToWalletUrl = createAddToWalletUrl(parsed.data);

    res.status(201).json({
      ok: true,
      data,
      addToWalletUrl
    });
  } catch (error) {
    console.error(error);
    res.status(502).json({
      ok: false,
      error: "Unable to create or retrieve loyalty pass"
    });
  }
});

app.listen(env.PORT, () => {
  console.log(`Wallet Business AI API listening on port ${env.PORT}`);
});
