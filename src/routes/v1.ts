import { randomUUID } from "node:crypto";
import { unlink } from "node:fs/promises";
import { Router } from "express";
import { z } from "zod";
import { query } from "../db.js";
import { authRequired, loginUser, registerUser } from "../auth.js";
import { createAddToWalletUrl, ensureLoyaltyClass, ensureLoyaltyObject, getLoyaltyObject, updateLoyaltyPoints, updateLoyaltyCustomer, updateLoyaltyClass } from "../wallet.js";
import { logoUpload, publicUploadUrl } from "../uploads.js";
import type { Business } from "../store.js";

const router = Router();
const businessSchema = z.object({
  name: z.string().trim().min(2).max(120),
  programName: z.string().trim().min(2).max(120).optional(),
  logoUrl: z.string().url().startsWith("https://").optional()
});

const businessEditSchema = z.object({
  name: z.string().trim().min(2).max(120).optional(),
  programName: z.string().trim().min(2).max(120).optional(),
  logoUrl: z.string().url().startsWith("https://").optional()
}).refine((value) => Object.keys(value).length > 0, {
  message: "At least one business field must be provided"
});
const customerSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]+$/).max(64),
  name: z.string().trim().min(1).max(120),
  points: z.number().int().nonnegative().default(0)
});
const pointsSchema = z.object({ points: z.number().int().nonnegative() });
const customerEditSchema = z.object({
  name: z.string().trim().min(1).max(120),
  points: z.number().int().nonnegative(),
  status: z.enum(["ACTIVE", "INACTIVE"])
});

function uploadLogoMiddleware(req: any, res: any, next: any) {
  logoUpload.single("logo")(req, res, (error: unknown) => {
    if (error) {
      res.status(400).json({
        ok: false,
        error: error instanceof Error ? error.message : "Unable to upload logo"
      });
      return;
    }
    next();
  });
}

function resolveLogoUrl(req: any, file: Express.Multer.File | undefined, fallback?: string) {
  const uploaded = file ? publicUploadUrl(req, file.filename) : undefined;
  const logoUrl = uploaded ?? fallback;

  if (!logoUrl) {
    return { error: "A logo image or HTTPS logo URL is required" };
  }

  try {
    const parsed = new URL(logoUrl);
    if (parsed.protocol !== "https:") {
      return {
        error: "Logo must use HTTPS. For uploaded images, configure PUBLIC_BASE_URL with your public HTTPS domain."
      };
    }
  } catch {
    return { error: "Invalid logo URL" };
  }

  return { logoUrl };
}

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

router.post("/businesses", uploadLogoMiddleware, async (req, res) => {
  const parsed = businessSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ ok: false, error: parsed.error.flatten() });
    return;
  }

  const logo = resolveLogoUrl(req, req.file, parsed.data.logoUrl);
  if (logo.error) {
    if (req.file) await unlink(req.file.path).catch(() => undefined);
    res.status(400).json({ ok: false, error: logo.error });
    return;
  }

  const userId = res.locals.userId as string;
  const id = randomUUID();
  const issuerId = process.env.GOOGLE_WALLET_ISSUER_ID ?? "";
  const classId = issuerId + ".business_" + id.replaceAll("-", "").slice(0, 12);
  if (!issuerId) {
    if (req.file) await unlink(req.file.path).catch(() => undefined);
    res.status(500).json({ ok: false, error: "Google Wallet issuer is not configured" });
    return;
  }

  const business: Business = {
    id,
    ownerUserId: userId,
    name: parsed.data.name,
    programName: parsed.data.programName ?? parsed.data.name + " Loyalty",
    logoUrl: logo.logoUrl,
    issuerId,
    classId,
    createdAt: new Date().toISOString()
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
    if (req.file) await unlink(req.file.path).catch(() => undefined);
    const api = googleApiError(error);
    console.error("Google Wallet business creation error:", api);
    res.status(502).json({ ok: false, error: "Unable to create business loyalty program", google: api });
  }
});

router.patch("/businesses/:businessId", uploadLogoMiddleware, async (req, res) => {
  const parsed = businessEditSchema.safeParse(req.body);
  if (!parsed.success) {
    if (req.file) await unlink(req.file.path).catch(() => undefined);
    res.status(400).json({ ok: false, error: parsed.error.flatten() });
    return;
  }

  const userId = res.locals.userId as string;
  const current = await ownedBusiness(userId, req.params.businessId);
  if (!current) {
    if (req.file) await unlink(req.file.path).catch(() => undefined);
    res.status(404).json({ ok: false, error: "Business not found" });
    return;
  }

  const logo = resolveLogoUrl(req, req.file, parsed.data.logoUrl ?? current.logoUrl);
  if (logo.error) {
    if (req.file) await unlink(req.file.path).catch(() => undefined);
    res.status(400).json({ ok: false, error: logo.error });
    return;
  }

  const updated: Business = {
    ...current,
    name: parsed.data.name ?? current.name,
    programName: parsed.data.programName ?? current.programName,
    logoUrl: logo.logoUrl,
    createdAt: current.createdAt ?? new Date().toISOString()
  };

  try {
    await updateLoyaltyClass(updated);

    const result = await query<Business>(
      "UPDATE businesses SET name = $1, program_name = $2, logo_url = $3 WHERE id = $4 AND owner_user_id = $5 RETURNING id::text, owner_user_id::text as \"ownerUserId\", name, program_name as \"programName\", logo_url as \"logoUrl\", issuer_id as \"issuerId\", class_id as \"classId\", created_at as \"createdAt\"",
      [updated.name, updated.programName, updated.logoUrl, updated.id, userId]
    );

    res.json({ ok: true, data: result.rows[0] ?? updated });
  } catch (error) {
    if (req.file) await unlink(req.file.path).catch(() => undefined);
    const api = googleApiError(error);
    console.error("Google Wallet business update error:", api);
    res.status(502).json({ ok: false, error: "Unable to update business branding", google: api });
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

router.get("/businesses/:businessId/customers", async (req, res) => {
  const userId = res.locals.userId as string;
  const business = await ownedBusiness(userId, req.params.businessId);
  if (!business) {
    res.status(404).json({ ok: false, error: "Business not found" });
    return;
  }

  const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
  const status = typeof req.query.status === "string" ? req.query.status : "ALL";
  const pageRaw = typeof req.query.page === "string" ? req.query.page : "1";
  const pageSizeRaw = typeof req.query.pageSize === "string" ? req.query.pageSize : "25";
  const sort = typeof req.query.sort === "string" ? req.query.sort : "updatedAt";
  const order = typeof req.query.order === "string" ? req.query.order : "desc";

  const page = Number.parseInt(pageRaw, 10);
  const pageSize = Number.parseInt(pageSizeRaw, 10);

  const sortColumns: Record<string, string> = {
    name: "name",
    points: "points",
    updatedAt: "updated_at",
    createdAt: "created_at"
  };

  if (q.length > 120) {
    res.status(400).json({ ok: false, error: "Search query is too long" });
    return;
  }

  if (!["ALL", "ACTIVE", "INACTIVE"].includes(status)) {
    res.status(400).json({ ok: false, error: "Invalid customer status filter" });
    return;
  }

  if (!Number.isInteger(page) || page < 1 || page > 1000000) {
    res.status(400).json({ ok: false, error: "Invalid page" });
    return;
  }

  if (!Number.isInteger(pageSize) || ![25, 50, 100].includes(pageSize)) {
    res.status(400).json({ ok: false, error: "Invalid page size" });
    return;
  }

  if (!Object.prototype.hasOwnProperty.call(sortColumns, sort)) {
    res.status(400).json({ ok: false, error: "Invalid sort field" });
    return;
  }

  if (!["asc", "desc"].includes(order)) {
    res.status(400).json({ ok: false, error: "Invalid sort order" });
    return;
  }

  const offset = (page - 1) * pageSize;
  const sortColumn = sortColumns[sort];
  const sortDirection = order === "asc" ? "ASC" : "DESC";

  const whereParams = [business.id, q, status];

  const countResult = await query<{ total: number }>(
    `SELECT COUNT(*)::int as total
       FROM customers
      WHERE business_id = $1
        AND ($2 = '' OR name ILIKE '%' || $2 || '%' OR external_id ILIKE '%' || $2 || '%')
        AND ($3 = 'ALL' OR status = $3)`,
    whereParams
  );

  const result = await query<{
    id: string;
    name: string;
    points: number;
    status: "ACTIVE" | "INACTIVE";
    walletObjectId: string | null;
    createdAt: string;
    updatedAt: string;
  }>(
    `SELECT external_id as id, name, points, status,
            wallet_object_id as "walletObjectId",
            created_at as "createdAt", updated_at as "updatedAt"
       FROM customers
      WHERE business_id = $1
        AND ($2 = '' OR name ILIKE '%' || $2 || '%' OR external_id ILIKE '%' || $2 || '%')
        AND ($3 = 'ALL' OR status = $3)
      ORDER BY ${sortColumn} ${sortDirection}, external_id ASC
      LIMIT $4 OFFSET $5`,
    [...whereParams, pageSize, offset]
  );

  const totals = await query<{
    totalCustomers: number;
    totalPoints: number;
    totalWalletCards: number;
  }>(
    "SELECT COUNT(*)::int as \"totalCustomers\", COALESCE(SUM(points), 0)::int as \"totalPoints\", COUNT(wallet_object_id)::int as \"totalWalletCards\" FROM customers WHERE business_id = $1",
    [business.id]
  );

  const totalFiltered = countResult.rows[0]?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(totalFiltered / pageSize));

  res.json({
    ok: true,
    data: {
      business,
      stats: totals.rows[0] ?? { totalCustomers: 0, totalPoints: 0, totalWalletCards: 0 },
      customers: result.rows,
      pagination: {
        page,
        pageSize,
        totalItems: totalFiltered,
        totalPages,
        hasPreviousPage: page > 1,
        hasNextPage: page < totalPages
      },
      filters: { q, status },
      sort: { field: sort, order }
    }
  });
});


router.patch("/businesses/:businessId/customers/:customerId", async (req, res) => {
  const parsed = customerEditSchema.safeParse(req.body);
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

  const existing = await query<{
    external_id: string;
    name: string;
    points: number;
    status: "ACTIVE" | "INACTIVE";
  }>(
    "SELECT external_id, name, points, status FROM customers WHERE business_id = $1 AND external_id = $2",
    [business.id, req.params.customerId]
  );

  if (!existing.rows[0]) {
    res.status(404).json({ ok: false, error: "Customer not found" });
    return;
  }

  const next = parsed.data;

  try {
    const data = await updateLoyaltyCustomer(business, req.params.customerId, next);
    await query(
      "UPDATE customers SET name = $1, points = $2, status = $3, updated_at = NOW() WHERE business_id = $4 AND external_id = $5",
      [next.name, next.points, next.status, business.id, req.params.customerId]
    );

    res.json({
      ok: true,
      data: {
        customer: {
          id: req.params.customerId,
          name: next.name,
          points: next.points,
          status: next.status
        },
        walletObject: data
      }
    });
  } catch (error) {
    const api = googleApiError(error);
    console.error("Full customer update error:", api);
    res.status(502).json({ ok: false, error: "Unable to update customer", google: api });
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
    const customer = await query<{ external_id: string; name: string; points: number; status: "ACTIVE" | "INACTIVE" }>(
      "SELECT external_id, name, points, status FROM customers WHERE business_id = $1 AND external_id = $2",
      [business.id, req.params.customerId]
    );
    if (!customer.rows[0]) {
      res.status(404).json({ ok: false, error: "Customer not found" });
      return;
    }

    const addToWalletUrl = createAddToWalletUrl(business, {
      id: customer.rows[0].external_id,
      name: customer.rows[0].name,
      points: customer.rows[0].points,
      status: customer.rows[0].status
    });

    res.json({ ok: true, data, addToWalletUrl });
  } catch (error) {
    const api = googleApiError(error);
    console.error("Wallet v1 get error:", api);
    res.status(502).json({ ok: false, error: "Unable to retrieve loyalty pass", google: api });
  }
});

export default router;
