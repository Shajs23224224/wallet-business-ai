import { randomUUID } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { query } from "../db.js";
import { authRequired, loginUser, registerUser } from "../auth.js";
import { createAddToWalletUrl, ensureLoyaltyClass, ensureLoyaltyObject, getLoyaltyObject, updateLoyaltyPoints } from "../wallet.js";
import type { Business } from "../store.js";

const router = Router();
const businessSchema = z.object({
  name: z.string().trim().min(2).max(120),
  programName: z.string().trim().min(2).max(120).optional(),
  logoUrl: z.string().url().startsWith("https://")
});
const customerSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]+$/).max(64),
  name: z.string().trim().min(1).max(120),
  points: z.number().int().nonnegative().default(0)
});
const pointsSchema = z.object({ points: z.number().int().nonnegative() });

function googleApiError(error: unknown) {
  const candidate = error as { code?: number; response?: { data?: { error?: { code?: number; status?: string; message?: string } } } };
  return {
    code: candidate.code ?? candidate.response?.data?.error?.code ?? null,
    status: candidate.response?.data?.error?.status ?? null,
    message: candidate.response?.data?.error?.message ?? null
  };
}

async function ownedBusiness(userId: string, businessId: string) {
  const result = await query<Business>(
    "SELECT id::text, owner_user_id::text as \"ownerUserId\", name, program_name as \"programName\", logo_url as \"logoUrl\", issuer_id as \"issuerId\", class_id as \"classId\", created_at as \"createdAt\" FROM businesses WHERE id = $1 AND owner_user_id = $2",
    [businessId, userId]
  );
  return result.rows[0] ?? null;
}

router.post("/auth/register", async (req, res) => {
  try {
    const result = await registerUser(req.body);
    res.status(201).json({ ok: true, data: result });
  } catch (error: any) {
    if (error?.message === "EMAIL_ALREADY_REGISTERED") {
      res.status(409).json({ ok: false, error: "Email already registered" });
      return;
    }
    if (error?.name === "ZodError") {
      res.status(400).json({ ok: false, error: error.flatten() });
      return;
    }
    console.error(error);
    res.status(500).json({ ok: false, error: "Unable to register user" });
  }
});

router.post("/auth/login", async (req, res) => {
  try {
    const result = await loginUser(req.body);
    res.status(200).json({ ok: true, data: result });
  } catch (error: any) {
    if (error?.message === "INVALID_CREDENTIALS") {
      res.status(401).json({ ok: false, error: "Invalid email or password" });
      return;
    }
    if (error?.name === "ZodError") {
      res.status(400).json({ ok: false, error: error.flatten() });
      return;
    }
    console.error(error);
    res.status(500).json({ ok: false, error: "Unable to login" });
  }
});

router.use(authRequired);

router.get("/auth/me", async (_req, res) => {
  const userId = res.locals.userId as string;
  const result = await query<{ id: string; email: string; created_at: string }>("SELECT id, email, created_at FROM users WHERE id = $1", [userId]);
  if (!result.rows[0]) {
    res.status(401).json({ ok: false, error: "User not found" });
    return;
  }
  res.json({ ok: true, data: result.rows[0] });
});

router.get("/businesses", async (_req, res) => {
  const userId = res.locals.userId as string;
  const result = await query<Business>(
    "SELECT id::text, owner_user_id::text as \"ownerUserId\", name, program_name as \"programName\", logo_url as \"logoUrl\", issuer_id as \"issuerId\", class_id as \"classId\", created_at as \"createdAt\" FROM businesses WHERE owner_user_id = $1 ORDER BY created_at DESC",
    [userId]
  );
  res.json({ ok: true, data: result.rows });
});

router.post("/businesses", async (req, res) => {
  const parsed = businessSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ ok: false, error: parsed.error.flatten() });
    return;
  }

  const userId = res.locals.userId as string;
  const id = randomUUID();
  const issuerId = process.env.GOOGLE_WALLET_ISSUER_ID ?? "";
  const classId = issuerId + ".business_" + id.replaceAll("-", "").slice(0, 12);
  if (!issuerId) {
    res.status(500).json({ ok: false, error: "Google Wallet issuer is not configured" });
    return;
  }

  const business: Business = {
    id, ownerUserId: userId, name: parsed.data.name,
    programName: parsed.data.programName ?? parsed.data.name + " Loyalty",
    logoUrl: parsed.data.logoUrl, issuerId, classId, createdAt: new Date().toISOString()
  };

  await query(
    "INSERT INTO businesses (id, owner_user_id, name, program_name, logo_url, issuer_id, class_id) VALUES ($1, $2, $3, $4, $5, $6, $7)",
    [business.id, userId, business.name, business.programName, business.logoUrl, business.issuerId, business.classId]
  );

  try {
    const walletClass = await ensureLoyaltyClass(business);
    res.status(201).json({ ok: true, data: { business, walletClass: walletClass.data } });
  } catch (error) {
    await query("DELETE FROM businesses WHERE id = $1 AND owner_user_id = $2", [business.id, userId]);
    const api = googleApiError(error);
    console.error("Google Wallet business creation error:", api);
    res.status(502).json({ ok: false, error: "Unable to create business loyalty program", google: api });
  }
});

router.post("/businesses/:businessId/loyalty", async (req, res) => {
  const parsed = customerSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ ok: false, error: parsed.error.flatten() });
    return;
  }

  const userId = res.locals.userId as string;
  const business = await ownedBusiness(userId, req.params.businessId);
  if (!business) {
    res.status(404).json({ ok: false, error: "Business not found" });
    return;
  }

  try {
    await ensureLoyaltyClass(business);
    const objectId = business.issuerId + "." + business.id + "_" + parsed.data.id;
    const customer = { id: parsed.data.id, name: parsed.data.name, points: parsed.data.points };
    const data = await ensureLoyaltyObject(business, customer);
    const addToWalletUrl = createAddToWalletUrl(business, customer);

    await query(
      "INSERT INTO customers (id, business_id, external_id, name, points, wallet_object_id) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (business_id, external_id) DO UPDATE SET name = EXCLUDED.name, points = EXCLUDED.points, wallet_object_id = EXCLUDED.wallet_object_id, updated_at = NOW()",
      [randomUUID(), business.id, parsed.data.id, parsed.data.name, parsed.data.points, objectId]
    );

    res.status(201).json({ ok: true, data, addToWalletUrl });
  } catch (error) {
    const api = googleApiError(error);
    console.error("Wallet v1 issue error:", api);
    res.status(502).json({ ok: false, error: "Unable to create loyalty pass", google: api });
  }
});

router.patch("/businesses/:businessId/loyalty/:customerId/points", async (req, res) => {
  const parsed = pointsSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ ok: false, error: parsed.error.flatten() });
    return;
  }

  const userId = res.locals.userId as string;
  const business = await ownedBusiness(userId, req.params.businessId);
  if (!business) {
    res.status(404).json({ ok: false, error: "Business not found" });
    return;
  }

  try {
    const customer = await query<{ external_id: string }>("SELECT external_id FROM customers WHERE business_id = $1 AND external_id = $2", [business.id, req.params.customerId]);
    if (!customer.rows[0]) {
      res.status(404).json({ ok: false, error: "Customer not found" });
      return;
    }

    const data = await updateLoyaltyPoints(business, customer.rows[0].external_id, parsed.data.points);
    await query("UPDATE customers SET points = $1, updated_at = NOW() WHERE business_id = $2 AND external_id = $3", [parsed.data.points, business.id, req.params.customerId]);
    res.json({ ok: true, data });
  } catch (error) {
    const api = googleApiError(error);
    console.error("Wallet v1 points update error:", api);
    res.status(502).json({ ok: false, error: "Unable to update loyalty points", google: api });
  }
});

router.get("/businesses/:businessId/loyalty/:customerId", async (req, res) => {
  const userId = res.locals.userId as string;
  const business = await ownedBusiness(userId, req.params.businessId);
  if (!business) {
    res.status(404).json({ ok: false, error: "Business not found" });
    return;
  }

  try {
    const data = await getLoyaltyObject(business, req.params.customerId);
    res.json({ ok: true, data });
  } catch (error) {
    const api = googleApiError(error);
    console.error("Wallet v1 get error:", api);
    res.status(502).json({ ok: false, error: "Unable to retrieve loyalty pass", google: api });
  }
});

export default router;
