import { randomUUID } from "node:crypto";
import { unlink } from "node:fs/promises";
import { Router } from "express";
import { z } from "zod";
import { query, withTransaction } from "../db.js";
import { authRequired, loginUser, registerUser } from "../auth.js";
import { createAddToWalletUrl, ensureLoyaltyClass, ensureLoyaltyObject, getLoyaltyObject, updateLoyaltyPoints, updateLoyaltyCustomer, updateLoyaltyClass } from "../wallet.js";
import { logoUpload, publicUploadUrl } from "../uploads.js";
import { completeOfferObject, createOfferAddToWalletUrl, ensureOfferClass, ensureOfferObject, getOfferLifecycleState, syncOfferObject, updateOfferClass, type OfferRecord, type RedemptionChannel } from "../offers.js";
import type { Business } from "../store.js";

const router = Router();

const optionalTrimmedText = (max: number) =>
  z.preprocess(
    (value) => typeof value === "string" && value.trim() === "" ? undefined : value,
    z.string().trim().min(2).max(max).optional()
  );

const optionalHttpsUrl = z.preprocess(
  (value) => typeof value === "string" && value.trim() === "" ? undefined : value,
  z.string().url().startsWith("https://").optional()
);

const businessSchema = z.object({
  name: z.string().trim().min(2).max(120),
  programName: optionalTrimmedText(120),
  logoUrl: optionalHttpsUrl
});

const businessEditSchema = z.object({
  name: z.string().trim().min(2).max(120).optional(),
  programName: optionalTrimmedText(120),
  logoUrl: optionalHttpsUrl
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
      const code = typeof error === "object" && error && "code" in error
        ? String((error as { code?: unknown }).code ?? "")
        : "";

      if (code === "LIMIT_FILE_SIZE") {
        res.status(400).json({
          ok: false,
          error: "El logo supera el tamaño máximo de 5 MB."
        });
        return;
      }

      res.status(400).json({
        ok: false,
        error: error instanceof Error ? error.message : "No se pudo subir el logo."
      });
      return;
    }
    next();
  });
}

function resolveLogoUrl(
  req: any,
  file: Express.Multer.File | undefined,
  fallback?: string
): { logoUrl?: string; error?: string } {
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

const offerCreateSchema = z.object({
  title: z.string().trim().min(2).max(60),
  details: z.string().trim().min(2).max(500),
  finePrint: z.preprocess(
    (value) => typeof value === "string" && value.trim() === "" ? undefined : value,
    z.string().trim().max(1000).optional()
  ),
  redemptionChannel: z.enum(["INSTORE", "ONLINE", "BOTH"]),
  code: z.string().trim().min(2).max(64).regex(/^[A-Za-z0-9_-]+$/),
  startsAt: z.preprocess(
    (value) => typeof value === "string" && value.trim() === "" ? undefined : value,
    z.string().datetime({ local: true }).optional()
  ),
  endsAt: z.preprocess(
    (value) => typeof value === "string" && value.trim() === "" ? undefined : value,
    z.string().datetime({ local: true }).optional()
  )
});

const offerUpdateSchema = z.object({
  title: z.string().trim().min(2).max(60).optional(),
  details: z.string().trim().min(2).max(500).optional(),
  finePrint: z.preprocess(
    (value) => typeof value === "string" && value.trim() === "" ? null : value,
    z.string().trim().max(1000).nullable().optional()
  ),
  redemptionChannel: z.enum(["INSTORE", "ONLINE", "BOTH"]).optional(),
  code: z.string().trim().min(2).max(64).regex(/^[A-Za-z0-9_-]+$/).optional(),
  startsAt: z.preprocess(
    (value) => value === "" ? null : value,
    z.string().datetime({ local: true }).nullable().optional()
  ),
  endsAt: z.preprocess(
    (value) => value === "" ? null : value,
    z.string().datetime({ local: true }).nullable().optional()
  ),
  state: z.enum(["ACTIVE", "INACTIVE"]).optional()
}).refine((value) => Object.keys(value).length > 0, {
  message: "At least one offer field must be provided"
});

function parseOfferDates(input: z.infer<typeof offerCreateSchema>) {
  const startsAt = input.startsAt ? new Date(input.startsAt).toISOString() : null;
  const endsAt = input.endsAt ? new Date(input.endsAt).toISOString() : null;

  if (startsAt && endsAt && new Date(endsAt) <= new Date(startsAt)) {
    throw new Error("OFFER_END_BEFORE_START");
  }

  return { startsAt, endsAt };
}

function normalizeOfferDate(
  value: string | null | undefined,
  current: string | null
) {
  if (value === undefined) return current;
  return value === null ? null : new Date(value).toISOString();
}

router.get("/businesses/:businessId/offers", async (req, res) => {
  const userId = res.locals.userId as string;
  const business = await ownedBusiness(userId, req.params.businessId);
  if (!business) {
    res.status(404).json({ ok: false, error: "Business not found" });
    return;
  }

  const result = await query<OfferRecord & { issuedCount: number }>(
    `SELECT o.id::text, o.business_id::text as "businessId", o.title, o.details,
            o.fine_print as "finePrint", o.provider,
            o.redemption_channel as "redemptionChannel", o.code,
            o.starts_at as "startsAt", o.ends_at as "endsAt",
            o.state, o.class_id as "classId",
            o.created_at as "createdAt", o.updated_at as "updatedAt",
            COUNT(DISTINCT oo.id)::int as "issuedCount",
            COUNT(DISTINCT r.id)::int as "redeemedCount"
       FROM offers o
       LEFT JOIN offer_objects oo ON oo.offer_id = o.id
       LEFT JOIN offer_redemptions r ON r.offer_id = o.id
      WHERE o.business_id = $1
      GROUP BY o.id
      ORDER BY o.created_at DESC`,
    [business.id]
  );

  res.json({
    ok: true,
    data: result.rows.map((offer) => ({
      ...offer,
      lifecycleState: getOfferLifecycleState(offer)
    }))
  });
});

router.post("/businesses/:businessId/offers", async (req, res) => {
  const parsed = offerCreateSchema.safeParse(req.body);
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

  let dates: { startsAt: string | null; endsAt: string | null };
  try {
    dates = parseOfferDates(parsed.data);
  } catch (error) {
    if (error instanceof Error && error.message === "OFFER_END_BEFORE_START") {
      res.status(400).json({ ok: false, error: "La fecha de finalización debe ser posterior a la de inicio." });
      return;
    }
    throw error;
  }

  const id = randomUUID();
  const classId = `${business.issuerId}.offer_${id.replaceAll("-", "")}`;
  const offer: OfferRecord = {
    id,
    businessId: business.id,
    title: parsed.data.title,
    details: parsed.data.details,
    finePrint: parsed.data.finePrint ?? null,
    provider: business.name,
    redemptionChannel: parsed.data.redemptionChannel as RedemptionChannel,
    code: parsed.data.code,
    startsAt: dates.startsAt,
    endsAt: dates.endsAt,
    state: "ACTIVE",
    classId,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  await query(
    `INSERT INTO offers
      (id, business_id, title, details, fine_print, provider, redemption_channel, code, starts_at, ends_at, state, class_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [
      offer.id, offer.businessId, offer.title, offer.details, offer.finePrint, offer.provider,
      offer.redemptionChannel, offer.code, offer.startsAt, offer.endsAt, offer.state, offer.classId
    ]
  );

  try {
    const walletClass = await ensureOfferClass(business, offer);
    res.status(201).json({ ok: true, data: { offer, walletClass: walletClass.data } });
  } catch (error) {
    await query("DELETE FROM offers WHERE id = $1 AND business_id = $2", [offer.id, business.id]);
    const api = googleApiError(error);
    console.error("Google Wallet offer class creation error:", api);
    res.status(502).json({ ok: false, error: "No se pudo crear la campaña de cupón en Google Wallet.", google: api });
  }
});

router.patch("/businesses/:businessId/offers/:offerId", async (req, res) => {
  const parsed = offerUpdateSchema.safeParse(req.body);
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

  const currentResult = await query<OfferRecord>(
    `SELECT id::text, business_id::text as "businessId", title, details,
            fine_print as "finePrint", provider,
            redemption_channel as "redemptionChannel", code,
            starts_at as "startsAt", ends_at as "endsAt",
            state, class_id as "classId",
            created_at as "createdAt", updated_at as "updatedAt"
       FROM offers
      WHERE id = $1 AND business_id = $2`,
    [req.params.offerId, business.id]
  );

  const current = currentResult.rows[0];
  if (!current) {
    res.status(404).json({ ok: false, error: "Offer not found" });
    return;
  }

  const startsAt = normalizeOfferDate(parsed.data.startsAt, current.startsAt);
  const endsAt = normalizeOfferDate(parsed.data.endsAt, current.endsAt);

  if (startsAt && endsAt && new Date(endsAt) <= new Date(startsAt)) {
    res.status(400).json({ ok: false, error: "La fecha de finalización debe ser posterior a la de inicio." });
    return;
  }

  const next: OfferRecord = {
    ...current,
    title: parsed.data.title ?? current.title,
    details: parsed.data.details ?? current.details,
    finePrint: Object.prototype.hasOwnProperty.call(parsed.data, "finePrint")
      ? (parsed.data.finePrint ?? null)
      : current.finePrint,
    redemptionChannel: parsed.data.redemptionChannel ?? current.redemptionChannel,
    code: parsed.data.code ?? current.code,
    startsAt,
    endsAt,
    state: parsed.data.state ?? current.state,
    provider: business.name,
    updatedAt: new Date().toISOString()
  };

  if (next.state === "ACTIVE" && getOfferLifecycleState(next) === "EXPIRED") {
    res.status(409).json({
      ok: false,
      error: "No se puede activar una campaña cuya fecha de finalización ya pasó."
    });
    return;
  }

  await query(
    `UPDATE offers
        SET title = $1,
            details = $2,
            fine_print = $3,
            provider = $4,
            redemption_channel = $5,
            code = $6,
            starts_at = $7,
            ends_at = $8,
            state = $9,
            updated_at = NOW()
      WHERE id = $10 AND business_id = $11`,
    [
      next.title,
      next.details,
      next.finePrint,
      next.provider,
      next.redemptionChannel,
      next.code,
      next.startsAt,
      next.endsAt,
      next.state,
      next.id,
      business.id
    ]
  );

  try {
    await updateOfferClass(business, next);

    const objectResult = await query<{
      rowId: string;
      externalId: string;
      walletObjectId: string;
    }>(
      `SELECT oo.customer_id::text as "rowId",
              c.external_id as "externalId",
              oo.wallet_object_id as "walletObjectId"
         FROM offer_objects oo
         JOIN customers c ON c.id = oo.customer_id
        WHERE oo.offer_id = $1`,
      [next.id]
    );

    for (const object of objectResult.rows) {
      await syncOfferObject(business, next, {
        rowId: object.rowId,
        externalId: object.externalId
      });
    }

    res.json({
      ok: true,
      data: {
        offer: {
          ...next,
          lifecycleState: getOfferLifecycleState(next)
        },
        syncedObjects: objectResult.rows.length
      }
    });
  } catch (error) {
    const api = googleApiError(error);
    console.error("Google Wallet offer update error:", api);
    res.status(502).json({
      ok: false,
      error: "La campaña se guardó, pero no se pudo sincronizar completamente con Google Wallet.",
      google: api
    });
  }
});

router.post("/businesses/:businessId/offers/:offerId/sync", async (req, res) => {
  const userId = res.locals.userId as string;
  const business = await ownedBusiness(userId, req.params.businessId);
  if (!business) {
    res.status(404).json({ ok: false, error: "Business not found" });
    return;
  }

  const offerResult = await query<OfferRecord>(
    `SELECT id::text, business_id::text as "businessId", title, details,
            fine_print as "finePrint", provider,
            redemption_channel as "redemptionChannel", code,
            starts_at as "startsAt", ends_at as "endsAt",
            state, class_id as "classId",
            created_at as "createdAt", updated_at as "updatedAt"
       FROM offers
      WHERE id = $1 AND business_id = $2`,
    [req.params.offerId, business.id]
  );

  const offer = offerResult.rows[0];
  if (!offer) {
    res.status(404).json({ ok: false, error: "Offer not found" });
    return;
  }

  try {
    await updateOfferClass(business, offer);

    const objectResult = await query<{
      rowId: string;
      externalId: string;
    }>(
      `SELECT oo.customer_id::text as "rowId",
              c.external_id as "externalId"
         FROM offer_objects oo
         JOIN customers c ON c.id = oo.customer_id
        WHERE oo.offer_id = $1`,
      [offer.id]
    );

    for (const object of objectResult.rows) {
      await syncOfferObject(business, offer, object);
    }

    res.json({
      ok: true,
      data: {
        offer: {
          ...offer,
          lifecycleState: getOfferLifecycleState(offer)
        },
        syncedObjects: objectResult.rows.length
      }
    });
  } catch (error) {
    const api = googleApiError(error);
    console.error("Google Wallet offer manual sync error:", api);
    res.status(502).json({
      ok: false,
      error: "No se pudo sincronizar la campaña con Google Wallet.",
      google: api
    });
  }
});

router.post("/businesses/:businessId/offers/:offerId/customers/:customerId/redeem", async (req, res) => {
  const parsed = z.object({
    code: z.string().trim().min(2).max(64).regex(/^[A-Za-z0-9_-]+$/),
    notes: z.string().trim().max(500).optional()
  }).safeParse(req.body);

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

  const offerResult = await query<OfferRecord>(
    `SELECT id::text, business_id::text as "businessId", title, details,
            fine_print as "finePrint", provider,
            redemption_channel as "redemptionChannel", code,
            starts_at as "startsAt", ends_at as "endsAt",
            state, class_id as "classId",
            created_at as "createdAt", updated_at as "updatedAt"
       FROM offers
      WHERE id = $1 AND business_id = $2`,
    [req.params.offerId, business.id]
  );

  const offer = offerResult.rows[0];
  if (!offer) {
    res.status(404).json({ ok: false, error: "Offer not found" });
    return;
  }

  const lifecycle = getOfferLifecycleState(offer);
  if (lifecycle !== "ACTIVE") {
    res.status(409).json({
      ok: false,
      error: lifecycle === "INACTIVE"
        ? "La campaña está inactiva."
        : lifecycle === "SCHEDULED"
          ? "La campaña todavía no ha comenzado."
          : "La campaña ya expiró."
    });
    return;
  }

  if (parsed.data.code !== offer.code) {
    res.status(409).json({ ok: false, error: "El código de redención no coincide con la campaña." });
    return;
  }

  const customerResult = await query<{
    id: string;
    externalId: string;
    name: string;
  }>(
    `SELECT id::text, external_id as "externalId", name
       FROM customers
      WHERE business_id = $1 AND external_id = $2`,
    [business.id, req.params.customerId]
  );

  const customer = customerResult.rows[0];
  if (!customer) {
    res.status(404).json({ ok: false, error: "Customer not found" });
    return;
  }

  const objectResult = await query<{
    walletObjectId: string;
  }>(
    `SELECT wallet_object_id as "walletObjectId"
       FROM offer_objects
      WHERE offer_id = $1 AND customer_id = $2`,
    [offer.id, customer.id]
  );

  const walletObject = objectResult.rows[0];
  if (!walletObject) {
    res.status(409).json({ ok: false, error: "El cupón todavía no ha sido emitido para este cliente." });
    return;
  }

  try {
    const redemption = await withTransaction(async (client) => {
      const existing = await client.query(
        "SELECT id FROM offer_redemptions WHERE offer_id = $1 AND customer_id = $2 FOR UPDATE",
        [offer.id, customer.id]
      );

      if (existing.rows[0]) {
        throw new Error("OFFER_ALREADY_REDEEMED");
      }

      const walletResult = await completeOfferObject(walletObject.walletObjectId);

      const inserted = await client.query(
        `INSERT INTO offer_redemptions
          (id, offer_id, customer_id, wallet_object_id, redeemed_at, notes)
         VALUES ($1,$2,$3,$4,NOW(),$5)
         RETURNING id::text, redeemed_at as "redeemedAt", notes`,
        [randomUUID(), offer.id, customer.id, walletObject.walletObjectId, parsed.data.notes ?? null]
      );

      return {
        id: inserted.rows[0].id,
        redeemedAt: inserted.rows[0].redeemedAt,
        notes: inserted.rows[0].notes,
        walletObject: walletResult
      };
    });

    res.status(201).json({
      ok: true,
      data: {
        offer: { id: offer.id, title: offer.title, code: offer.code },
        customer: { id: customer.externalId, name: customer.name },
        redemption
      }
    });
  } catch (error) {
    if (error instanceof Error && error.message === "OFFER_ALREADY_REDEEMED") {
      res.status(409).json({ ok: false, error: "Este cupón ya fue redimido por este cliente." });
      return;
    }

    const candidate = error as { code?: string };
    if (candidate.code === "23505") {
      res.status(409).json({ ok: false, error: "Este cupón ya fue redimido por este cliente." });
      return;
    }

    const api = googleApiError(error);
    console.error("Google Wallet offer redemption error:", api);
    res.status(502).json({
      ok: false,
      error: "No se pudo marcar el cupón como redimido en Google Wallet.",
      google: api
    });
  }
});

router.post("/businesses/:businessId/offer-scans/redeem", async (req, res) => {
  const parsed = z.object({
    value: z.string().trim().min(1).max(300),
    notes: z.string().trim().max(500).optional()
  }).safeParse(req.body);

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

  const scanned = await query<{
    offerId: string;
    offerTitle: string;
    offerCode: string;
    offerState: OfferRecord["state"];
    startsAt: string | null;
    endsAt: string | null;
    customerRowId: string;
    customerId: string;
    customerName: string;
    walletObjectId: string;
  }>(
    `SELECT o.id::text as "offerId",
            o.title as "offerTitle",
            o.code as "offerCode",
            o.state as "offerState",
            o.starts_at as "startsAt",
            o.ends_at as "endsAt",
            c.id::text as "customerRowId",
            c.external_id as "customerId",
            c.name as "customerName",
            oo.wallet_object_id as "walletObjectId"
       FROM offer_objects oo
       JOIN offers o ON o.id = oo.offer_id
       JOIN customers c ON c.id = oo.customer_id
      WHERE oo.wallet_object_id = $1
        AND o.business_id = $2`,
    [parsed.data.value, business.id]
  );

  const scannedOffer = scanned.rows[0];
  if (!scannedOffer) {
    res.status(404).json({
      ok: false,
      error: "QR no reconocido. Actualiza/sincroniza el cupón antes de escanearlo."
    });
    return;
  }

  const lifecycle = getOfferLifecycleState({
    state: scannedOffer.offerState,
    startsAt: scannedOffer.startsAt,
    endsAt: scannedOffer.endsAt
  });

  if (lifecycle !== "ACTIVE") {
    res.status(409).json({
      ok: false,
      error: lifecycle === "INACTIVE"
        ? "La campaña está inactiva."
        : lifecycle === "SCHEDULED"
          ? "La campaña todavía no ha comenzado."
          : "La campaña ya expiró."
    });
    return;
  }

  try {
    const redemption = await withTransaction(async (client) => {
      const existing = await client.query(
        "SELECT id FROM offer_redemptions WHERE offer_id = $1 AND customer_id = $2 FOR UPDATE",
        [scannedOffer.offerId, scannedOffer.customerRowId]
      );

      if (existing.rows[0]) throw new Error("OFFER_ALREADY_REDEEMED");

      const walletResult = await completeOfferObject(scannedOffer.walletObjectId);

      const inserted = await client.query(
        `INSERT INTO offer_redemptions
          (id, offer_id, customer_id, wallet_object_id, redeemed_at, notes)
         VALUES ($1,$2,$3,$4,NOW(),$5)
         RETURNING id::text, redeemed_at as "redeemedAt", notes`,
        [
          randomUUID(),
          scannedOffer.offerId,
          scannedOffer.customerRowId,
          scannedOffer.walletObjectId,
          parsed.data.notes ?? null
        ]
      );

      return {
        id: inserted.rows[0].id,
        redeemedAt: inserted.rows[0].redeemedAt,
        notes: inserted.rows[0].notes,
        walletObject: walletResult
      };
    });

    res.status(201).json({
      ok: true,
      data: {
        offer: {
          id: scannedOffer.offerId,
          title: scannedOffer.offerTitle,
          code: scannedOffer.offerCode
        },
        customer: {
          id: scannedOffer.customerId,
          name: scannedOffer.customerName
        },
        redemption
      }
    });
  } catch (error) {
    if (error instanceof Error && error.message === "OFFER_ALREADY_REDEEMED") {
      res.status(409).json({ ok: false, error: "Este cupón ya fue redimido por este cliente." });
      return;
    }

    const candidate = error as { code?: string };
    if (candidate.code === "23505") {
      res.status(409).json({ ok: false, error: "Este cupón ya fue redimido por este cliente." });
      return;
    }

    const api = googleApiError(error);
    console.error("Google Wallet scanned offer redemption error:", api);
    res.status(502).json({
      ok: false,
      error: "No se pudo completar la redención escaneada.",
      google: api
    });
  }
});

router.get("/businesses/:businessId/offer-redemptions", async (req, res) => {
  const userId = res.locals.userId as string;
  const business = await ownedBusiness(userId, req.params.businessId);
  if (!business) {
    res.status(404).json({ ok: false, error: "Business not found" });
    return;
  }

  const result = await query<{
    id: string;
    offerId: string;
    offerTitle: string;
    customerId: string;
    customerName: string;
    redeemedAt: string;
    notes: string | null;
  }>(
    `SELECT r.id::text,
            r.offer_id::text as "offerId",
            o.title as "offerTitle",
            c.external_id as "customerId",
            c.name as "customerName",
            r.redeemed_at as "redeemedAt",
            r.notes
       FROM offer_redemptions r
       JOIN offers o ON o.id = r.offer_id
       JOIN customers c ON c.id = r.customer_id
      WHERE o.business_id = $1
      ORDER BY r.redeemed_at DESC
      LIMIT 200`,
    [business.id]
  );

  res.json({ ok: true, data: result.rows });
});

router.post("/businesses/:businessId/offers/:offerId/customers/:customerId", async (req, res) => {
  const userId = res.locals.userId as string;
  const business = await ownedBusiness(userId, req.params.businessId);
  if (!business) {
    res.status(404).json({ ok: false, error: "Business not found" });
    return;
  }

  const offerResult = await query<OfferRecord>(
    `SELECT id::text, business_id::text as "businessId", title, details,
            fine_print as "finePrint", provider,
            redemption_channel as "redemptionChannel", code,
            starts_at as "startsAt", ends_at as "endsAt",
            state, class_id as "classId",
            created_at as "createdAt", updated_at as "updatedAt"
       FROM offers
      WHERE id = $1 AND business_id = $2`,
    [req.params.offerId, business.id]
  );

  const offer = offerResult.rows[0];
  if (!offer) {
    res.status(404).json({ ok: false, error: "Offer not found" });
    return;
  }

  const lifecycleState = getOfferLifecycleState(offer);
  if (lifecycleState !== "ACTIVE") {
    const messages: Record<string, string> = {
      INACTIVE: "La campaña de cupón está inactiva.",
      SCHEDULED: "La campaña todavía no ha comenzado.",
      EXPIRED: "La campaña de cupón ya expiró."
    };
    res.status(409).json({
      ok: false,
      error: messages[lifecycleState] ?? "La campaña no está disponible para emisión."
    });
    return;
  }

  const customerResult = await query<{
    id: string;
    externalId: string;
    name: string;
    walletObjectId: string | null;
  }>(
    `SELECT id::text, external_id as "externalId", name, wallet_object_id as "walletObjectId"
       FROM customers
      WHERE business_id = $1 AND external_id = $2`,
    [business.id, req.params.customerId]
  );

  const customer = customerResult.rows[0];
  if (!customer) {
    res.status(404).json({ ok: false, error: "Customer not found" });
    return;
  }

  try {
    await ensureOfferClass(business, offer);
    const walletObject = await ensureOfferObject(business, offer, {
      rowId: customer.id,
      externalId: customer.externalId
    });

    await query(
      `INSERT INTO offer_objects (id, offer_id, customer_id, wallet_object_id)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (offer_id, customer_id)
       DO UPDATE SET wallet_object_id = EXCLUDED.wallet_object_id`,
      [randomUUID(), offer.id, customer.id, walletObject.id]
    );

    const addToWalletUrl = createOfferAddToWalletUrl(offer, {
      rowId: customer.id,
      externalId: customer.externalId
    });

    res.status(201).json({
      ok: true,
      data: {
        offer,
        customer: {
          id: customer.externalId,
          name: customer.name
        },
        walletObject
      },
      addToWalletUrl
    });
  } catch (error) {
    const api = googleApiError(error);
    console.error("Google Wallet offer issuance error:", api);
    res.status(502).json({ ok: false, error: "No se pudo emitir el cupón en Google Wallet.", google: api });
  }
});

router.post("/businesses", uploadLogoMiddleware, async (req, res) => {
  const parsed = businessSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ ok: false, error: parsed.error.flatten() });
    return;
  }

  const file = req.file && req.file.size > 0 ? req.file : undefined;
  if (req.file && req.file.size === 0) {
    await unlink(req.file.path).catch(() => undefined);
  }
  const logo = resolveLogoUrl(req, file, parsed.data.logoUrl);
  if (logo.error || !logo.logoUrl) {
    if (file) await unlink(file.path).catch(() => undefined);
    res.status(400).json({ ok: false, error: logo.error ?? "A logo image or HTTPS logo URL is required" });
    return;
  }

  const userId = res.locals.userId as string;
  const id = randomUUID();
  const issuerId = process.env.GOOGLE_WALLET_ISSUER_ID ?? "";
  const classId = issuerId + ".business_" + id.replaceAll("-", "").slice(0, 12);
  if (!issuerId) {
    if (file) await unlink(file.path).catch(() => undefined);
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
    if (file) await unlink(file.path).catch(() => undefined);
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

  const file = req.file && req.file.size > 0 ? req.file : undefined;
  if (req.file && req.file.size === 0) {
    await unlink(req.file.path).catch(() => undefined);
  }
  const logo = resolveLogoUrl(req, file, parsed.data.logoUrl ?? current.logoUrl);
  if (logo.error || !logo.logoUrl) {
    if (file) await unlink(file.path).catch(() => undefined);
    res.status(400).json({ ok: false, error: logo.error ?? "A logo image or HTTPS logo URL is required" });
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
    if (file) await unlink(file.path).catch(() => undefined);
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
