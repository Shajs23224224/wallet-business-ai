import jwt from "jsonwebtoken";
import { google } from "googleapis";
import { env } from "./config.js";

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

export async function ensureLoyaltyClass() {
  const classId = env.GOOGLE_WALLET_CLASS_ID;

  try {
    return await walletobjects.loyaltyclass.get({ resourceId: classId });
  } catch (error: any) {
    if (error?.code !== 404) throw error;
  }

  return walletobjects.loyaltyclass.insert({
    requestBody: {
      id: classId,
      issuerName: "Wallet Business AI",
      programName: "Loyalty Program",
      programLogo: {
        sourceUri: {
          uri: "https://developers.google.com/static/wallet/images/generic-loyalty-card.png"
        }
      },
      reviewStatus: "UNDER_REVIEW"
    }
  });
}

export function buildLoyaltyObject(customer: LoyaltyCustomer) {
  const objectId = `${env.GOOGLE_WALLET_ISSUER_ID}.${customer.id}`;

  return {
    id: objectId,
    classId: env.GOOGLE_WALLET_CLASS_ID,
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

export async function ensureLoyaltyObject(customer: LoyaltyCustomer) {
  const objectId = `${env.GOOGLE_WALLET_ISSUER_ID}.${customer.id}`;

  try {
    const existing = await walletobjects.loyaltyobject.get({
      resourceId: objectId
    });
    return existing.data;
  } catch (error: any) {
    if (error?.code !== 404) throw error;
  }

  const result = await walletobjects.loyaltyobject.insert({
    requestBody: buildLoyaltyObject(customer)
  });

  return result.data;
}

export function createAddToWalletUrl(customer: LoyaltyCustomer) {
  const object = buildLoyaltyObject(customer);

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
