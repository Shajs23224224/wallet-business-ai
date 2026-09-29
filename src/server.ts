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
import {
  createBusiness,
  deleteBusiness,
  getBusiness,
  listBusinesses,
  updateCustomerPoints,
  upsertCustomer
} from "./store.js";

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

async function requireBusiness(businessId: string) {
  return getBusiness(businessId);
}

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "wallet-business-ai" });
});

const businessSchema = z.object({
  name: z.string().trim().min(2).max(120),
  programName: z.string().trim().min(2).max(120).optional(),
  logoUrl: z.string().url().startsWith("https://")
});

app.get("/api/businesses", async (_req, res) => {
  res.json({ ok: true, data: await listBusinesses() });
});

app.post("/api/businesses", async (req, res) => {
  const parsed = businessSchema.safeParse(req.body);

  if (!parsed.success) {
    res.status(400).json({ ok: false, error: parsed.error.flatten() });
    return;
  }

  let business: Awaited<ReturnType<typeof createBusiness>> | null = null;

  try {
    business = await createBusiness(parsed.data);
    const walletClass = await ensureLoyaltyClass(business);

    res.status(201).json({
      ok: true,
      data: {
        business,
        walletClass: walletClass.data
      }
    });
  } catch (error) {
    if (business) {
      await deleteBusiness(business.id).catch(() => undefined);
    }
    const apiError = googleApiError(error);
    console.error("Google Wallet business creation error:", apiError);
    res.status(502).json({
      ok: false,
      error: "Unable to create business loyalty program",
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

async function issueLoyaltyPass(
  businessId: string,
  input: z.infer<typeof customerSchema>
) {
  const business = await requireBusiness(businessId);

  if (!business) {
    throw Object.assign(new Error("Business not found"), {
      statusCode: 404
    });
  }

  const customer = {
    id: input.id,
    name: input.name,
    points: input.points ?? 0
  };

  await ensureLoyaltyClass(business);
  const data = await ensureLoyaltyObject(business, customer);
  const addToWalletUrl = createAddToWalletUrl(business, customer);
  const storedCustomer = await upsertCustomer({
    businessId: business.id,
    ...customer
  });

  return {
    business,
    customer: storedCustomer,
    data,
    addToWalletUrl
  };
}

app.post("/api/wallet/business/:businessId/loyalty/class", async (req, res) => {
  const business = await requireBusiness(req.params.businessId);

  if (!business) {
    res.status(404).json({ ok: false, error: "Business not found" });
    return;
  }

  try {
    const result = await ensureLoyaltyClass(business);
    res.status(200).json({ ok: true, data: result.data });
  } catch (error) {
    const apiError = googleApiError(error);
    console.error("Google Wallet business class error:", apiError);
    res.status(502).json({
      ok: false,
      error: "Unable to create or retrieve business loyalty class",
      google: apiError
    });
  }
});

app.post("/api/wallet/business/:businessId/loyalty", async (req, res) => {
  const parsed = customerSchema.safeParse(req.body);

  if (!parsed.success) {
    res.status(400).json({ ok: false, error: parsed.error.flatten() });
    return;
  }

  try {
    const result = await issueLoyaltyPass(req.params.businessId, parsed.data);

    res.status(201).json({
      ok: true,
      business: result.business,
      customer: result.customer,
      data: result.data,
      addToWalletUrl: result.addToWalletUrl
    });
  } catch (error: any) {
    if (error?.statusCode === 404) {
      res.status(404).json({ ok: false, error: "Business not found" });
      return;
    }

    const apiError = googleApiError(error);
    console.error("Google Wallet business pass error:", apiError);
    res.status(502).json({
      ok: false,
      error: "Unable to create or retrieve loyalty pass",
      google: apiError
    });
  }
});

app.get("/api/wallet/business/:businessId/loyalty/:id", async (req, res) => {
  const idParsed = customerIdSchema.safeParse({ id: req.params.id });

  if (!idParsed.success) {
    res.status(400).json({ ok: false, error: idParsed.error.flatten() });
    return;
  }

  const business = await requireBusiness(req.params.businessId);

  if (!business) {
    res.status(404).json({ ok: false, error: "Business not found" });
    return;
  }

  try {
    const data = await getLoyaltyObject(business, idParsed.data.id);
    res.status(200).json({ ok: true, data });
  } catch (error) {
    const apiError = googleApiError(error);
    console.error("Google Wallet business object get error:", apiError);
    res.status(502).json({
      ok: false,
      error: "Unable to retrieve loyalty pass",
      google: apiError
    });
  }
});

app.patch("/api/wallet/business/:businessId/loyalty/:id/points", async (req, res) => {
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

  const business = await requireBusiness(req.params.businessId);

  if (!business) {
    res.status(404).json({ ok: false, error: "Business not found" });
    return;
  }

  try {
    const data = await updateLoyaltyPoints(
      business,
      idParsed.data.id,
      bodyParsed.data.points
    );

    await updateCustomerPoints(
      business.id,
      idParsed.data.id,
      bodyParsed.data.points
    );

    res.status(200).json({ ok: true, data });
  } catch (error) {
    const apiError = googleApiError(error);
    console.error("Google Wallet business points update error:", apiError);
    res.status(502).json({
      ok: false,
      error: "Unable to update loyalty points",
      google: apiError
    });
  }
});

/* Backward-compatible default-business routes. */
app.post("/api/wallet/loyalty/class", async (_req, res) => {
  const business = await requireBusiness("default");

  if (!business) {
    res.status(500).json({ ok: false, error: "Default business is not configured" });
    return;
  }

  try {
    const result = await ensureLoyaltyClass(business);
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

app.post("/api/wallet/loyalty", async (req, res) => {
  const parsed = customerSchema.safeParse(req.body);

  if (!parsed.success) {
    res.status(400).json({ ok: false, error: parsed.error.flatten() });
    return;
  }

  try {
    const result = await issueLoyaltyPass("default", parsed.data);

    res.status(201).json({
      ok: true,
      data: result.data,
      addToWalletUrl: result.addToWalletUrl
    });
  } catch (error) {
    const apiError = googleApiError(error);
    console.error("Google Wallet pass error:", apiError);
    res.status(502).json({
      ok: false,
      error: "Unable to create or retrieve loyalty pass",
      google: apiError
    });
  }
});

app.get("/api/wallet/loyalty/:id", async (req, res) => {
  const parsed = customerIdSchema.safeParse({ id: req.params.id });

  if (!parsed.success) {
    res.status(400).json({ ok: false, error: parsed.error.flatten() });
    return;
  }

  const business = await requireBusiness("default");

  if (!business) {
    res.status(500).json({ ok: false, error: "Default business is not configured" });
    return;
  }

  try {
    const data = await getLoyaltyObject(business, parsed.data.id);
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

  const business = await requireBusiness("default");

  if (!business) {
    res.status(500).json({ ok: false, error: "Default business is not configured" });
    return;
  }

  try {
    const data = await updateLoyaltyPoints(
      business,
      idParsed.data.id,
      bodyParsed.data.points
    );

    await updateCustomerPoints(
      business.id,
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

app.listen(env.PORT, () => {
  console.log(`Wallet Business AI API listening on port ${env.PORT}`);
});
