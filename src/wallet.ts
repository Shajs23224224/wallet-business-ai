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

export type LoyaltyCustomer = {
  id: string;
  name: string;
  points?: number;
};

function getObjectId(business: Business, customerId: string) {
  return `${business.issuerId}.${business.id}_${customerId}`;
}

export async function ensureLoyaltyClass(business: Business) {
  try {
    return await walletobjects.loyaltyclass.get({ resourceId: business.classId });
  } catch (error: any) {
    if (error?.code !== 404) throw error;
  }

  return walletobjects.loyaltyclass.insert({
    requestBody: {
      id: business.classId,
      issuerName: business.name,
      programName: business.programName,
      programLogo: {
        sourceUri: {
          uri: business.logoUrl
        },
        contentDescription: {
          defaultValue: {
            language: "es-CO",
            value: `${business.name} loyalty program logo`
          }
        }
      },
      reviewStatus: "UNDER_REVIEW"
    }
  });
}

export function buildLoyaltyObject(
  business: Business,
  customer: LoyaltyCustomer
) {
  const objectId = getObjectId(business, customer.id);

  return {
    id: objectId,
    classId: business.classId,
    state: "ACTIVE",
    accountId: customer.id,
    accountName: customer.name,
    barcode: {
      type: "QR_CODE",
      value: customer.id
    },
    loyaltyPoints: {
      label: "Puntos",
      balance: {
        int: customer.points ?? 0
      }
    }
  };
}

export async function ensureLoyaltyObject(
  business: Business,
  customer: LoyaltyCustomer
) {
  const objectId = getObjectId(business, customer.id);

  try {
    const existing = await walletobjects.loyaltyobject.get({
      resourceId: objectId
    });
    return existing.data;
  } catch (error: any) {
    if (error?.code !== 404) throw error;
  }

  const result = await walletobjects.loyaltyobject.insert({
    requestBody: buildLoyaltyObject(business, customer)
  });

  return result.data;
}

export async function updateLoyaltyPoints(
  business: Business,
  customerId: string,
  points: number
) {
  const objectId = getObjectId(business, customerId);

  const result = await walletobjects.loyaltyobject.patch({
    resourceId: objectId,
    requestBody: {
      loyaltyPoints: {
        label: "Puntos",
        balance: {
          int: points
        }
      }
    }
  });

  return result.data;
}

export async function getLoyaltyObject(
  business: Business,
  customerId: string
) {
  const objectId = getObjectId(business, customerId);
  const result = await walletobjects.loyaltyobject.get({
    resourceId: objectId
  });
  return result.data;
}

export function createAddToWalletUrl(
  business: Business,
  customer: LoyaltyCustomer
) {
  const object = buildLoyaltyObject(business, customer);

  const token = jwt.sign(
    {
      iss: env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      aud: "google",
      typ: "savetowallet",
      iat: Math.floor(Date.now() / 1000),
      payload: {
        loyaltyObjects: [
          {
            id: object.id,
            classId: object.classId
          }
        ]
      }
    },
    env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY,
    { algorithm: "RS256" }
  );

  return `https://pay.google.com/gp/v/save/${token}`;
}
