import express from "express";
import { z } from "zod";
import { env } from "./config.js";
import {
  createAddToWalletUrl,
  ensureLoyaltyClass,
  ensureLoyaltyObject,
  getLoyaltyObject,
  updateLoyaltyPoints
} from "./wallet.js";

const app = express();
app.use(express.json());
app.use(express.static("public"));

function googleApiError(error: unknown) {
  const candidate = error as {
    code?: number;
    response?: {
      data?: {
        error?: {
          code?: number;
          status?: string;
          message?: string;
        };
      };
    };
  };

  return {
    code: candidate.code ?? candidate.response?.data?.error?.code ?? null,
    status: candidate.response?.data?.error?.status ?? null,
    message: candidate.response?.data?.error?.message ?? null
  };
}

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "wallet-business-ai" });
});

app.post("/api/wallet/loyalty/class", async (_req, res) => {
  try {
    const result = await ensureLoyaltyClass();
    res.status(200).json({ ok: true, data: result.data });
  } catch (error) {
    const apiError = googleApiError(error);
    console.error("Google Wallet class error:", apiError);
    res.status(502).json({
      ok: false,
      error: "Unable to create or retrieve loyalty class",
      google: apiError
    });
  }
});

const customerSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]+$/).max(64),
  name: z.string().min(1).max(120),
  points: z.number().int().nonnegative().optional()
});

const customerIdSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]+$/).max(64)
});

const pointsUpdateSchema = z.object({
  points: z.number().int().nonnegative()
});

app.get("/api/wallet/loyalty/:id", async (req, res) => {
  const parsed = customerIdSchema.safeParse({ id: req.params.id });
  if (!parsed.success) {
    res.status(400).json({ ok: false, error: parsed.error.flatten() });
    return;
  }

  try {
    const data = await getLoyaltyObject(parsed.data.id);
    res.status(200).json({ ok: true, data });
  } catch (error) {
    const apiError = googleApiError(error);
    console.error("Google Wallet object get error:", apiError);
    res.status(502).json({
      ok: false,
      error: "Unable to retrieve loyalty pass",
      google: apiError
    });
  }
});

app.patch("/api/wallet/loyalty/:id/points", async (req, res) => {
  const idParsed = customerIdSchema.safeParse({ id: req.params.id });
  const bodyParsed = pointsUpdateSchema.safeParse(req.body);

  if (!idParsed.success || !bodyParsed.success) {
    res.status(400).json({
      ok: false,
      error: {
        id: idParsed.success ? undefined : idParsed.error.flatten(),
        body: bodyParsed.success ? undefined : bodyParsed.error.flatten()
      }
    });
    return;
  }

  try {
    const data = await updateLoyaltyPoints(
      idParsed.data.id,
      bodyParsed.data.points
    );
    res.status(200).json({ ok: true, data });
  } catch (error) {
    const apiError = googleApiError(error);
    console.error("Google Wallet points update error:", apiError);
    res.status(502).json({
      ok: false,
      error: "Unable to update loyalty points",
      google: apiError
    });
  }
});

app.post("/api/wallet/loyalty", async (req, res) => {
  const parsed = customerSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ ok: false, error: parsed.error.flatten() });
    return;
  }

  try {
    await ensureLoyaltyClass();
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
