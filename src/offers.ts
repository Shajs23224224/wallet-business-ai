import jwt from "jsonwebtoken";
import { google } from "googleapis";
import { env } from "./config.js";
import type { Business } from "./store.js";

const auth = new google.auth.GoogleAuth({
  credentials: {
    client_email: env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    private_key: env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY
  },
  scopes: ["https://www.googleapis.com/auth/wallet_object.issuer"]
});

const walletobjects = google.walletobjects({ version: "v1", auth });

export type RedemptionChannel = "INSTORE" | "ONLINE" | "BOTH";

export type OfferRecord = {
  id: string;
  businessId: string;
  title: string;
  details: string;
  finePrint: string | null;
  provider: string;
  redemptionChannel: RedemptionChannel;
  code: string;
  startsAt: string | null;
  endsAt: string | null;
  state: "ACTIVE" | "INACTIVE";
  classId: string;
  createdAt: string;
  updatedAt: string;
};

function classIdFor(offer: Pick<OfferRecord, "id" | "businessId">, issuerId: string) {
  return `${issuerId}.offer_${offer.id.replaceAll("-", "")}`;
}

function objectIdFor(
  offer: Pick<OfferRecord, "id" | "businessId">,
  customerRowId: string,
  issuerId: string
) {
  return `${issuerId}.offer_${offer.id.replaceAll("-", "")}_customer_${customerRowId.replaceAll("-", "")}`;
}

function buildValidity(offer: OfferRecord) {
  if (!offer.startsAt && !offer.endsAt) return undefined;

  return {
    ...(offer.startsAt ? { start: { date: offer.startsAt } } : {}),
    ...(offer.endsAt ? { end: { date: offer.endsAt } } : {})
  };
}

export async function ensureOfferClass(business: Business, offer: OfferRecord) {
  const classId = classIdFor(offer, business.issuerId);

  try {
    return await walletobjects.offerclass.get({ resourceId: classId });
  } catch (error: any) {
    if (error?.code !== 404) throw error;
  }

  return walletobjects.offerclass.insert({
    requestBody: {
      id: classId,
      issuerName: business.name,
      reviewStatus: "UNDER_REVIEW",
      provider: offer.provider.slice(0, 12),
      title: offer.title,
      redemptionChannel: offer.redemptionChannel,
      details: offer.details,
      ...(offer.finePrint ? { finePrint: offer.finePrint } : {})
    }
  });
}

export function buildOfferObject(
  business: Business,
  offer: OfferRecord,
  customer: { rowId: string; externalId: string }
) {
  const objectId = objectIdFor(offer, customer.rowId, business.issuerId);
  const loyaltyObjectId =
    business.id === "default"
      ? `${business.issuerId}.${customer.externalId}`
      : `${business.issuerId}.${business.id}_${customer.externalId}`;

  return {
    id: objectId,
    classId: offer.classId,
    state: offer.state,
    barcode: {
      type: "QR_CODE",
      value: offer.code
    },
    ...(buildValidity(offer) ? { validTimeInterval: buildValidity(offer) } : {}),
    textModulesData: [
      {
        id: "CUSTOMER",
        header: "Cliente",
        body: customer.externalId
      },
      {
        id: "OFFER_CODE",
        header: "Código",
        body: offer.code
      }
    ],
    linkedObjectIds: [loyaltyObjectId]
  };
}

export async function ensureOfferObject(
  business: Business,
  offer: OfferRecord,
  customer: { rowId: string; externalId: string }
) {
  const object = buildOfferObject(business, offer, customer);

  try {
    const existing = await walletobjects.offerobject.get({
      resourceId: object.id
    });
    return existing.data;
  } catch (error: any) {
    if (error?.code !== 404) throw error;
  }

  const result = await walletobjects.offerobject.insert({
    requestBody: object
  });

  return result.data;
}

export function createOfferAddToWalletUrl(
  offer: OfferRecord,
  customer: { rowId: string; externalId: string }
) {
  const objectId = objectIdFor(offer, customer.rowId, env.GOOGLE_WALLET_ISSUER_ID);

  const token = jwt.sign(
    {
      iss: env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      aud: "google",
      typ: "savetowallet",
      iat: Math.floor(Date.now() / 1000),
      payload: {
        offerObjects: [
          {
            id: objectId,
            classId: offer.classId
          }
        ]
      }
    },
    env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY,
    { algorithm: "RS256" }
  );

  return `https://pay.google.com/gp/v/save/${token}`;
}
