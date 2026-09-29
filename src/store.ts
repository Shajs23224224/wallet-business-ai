import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { env } from "./config.js";

export type Business = {
  id: string;
  ownerUserId?: string;
  name: string;
  issuerId: string;
  classId: string;
  programName: string;
  logoUrl: string;
  createdAt: string;
};

export type CustomerRecord = {
  id: string;
  businessId: string;
  name: string;
  points: number;
  createdAt: string;
};

type StoreData = {
  businesses: Business[];
  customers: CustomerRecord[];
};

const storePath = process.env.WALLET_BUSINESS_STORE_PATH ?? "data/store.json";

async function readStore(): Promise<StoreData> {
  try {
    const content = await readFile(storePath, "utf8");
    return JSON.parse(content) as StoreData;
  } catch (error: any) {
    if (error?.code !== "ENOENT") throw error;

    const initial: StoreData = {
      businesses: [
        {
          id: "default",
          name: "Wallet Business AI",
          issuerId: env.GOOGLE_WALLET_ISSUER_ID,
          classId: env.GOOGLE_WALLET_CLASS_ID,
          programName: "Loyalty Program",
          logoUrl:
            "https://farm4.staticflickr.com/3723/11177041115_6e6a3b6f49_o.jpg",
          createdAt: new Date().toISOString()
        }
      ],
      customers: []
    };

    await writeStore(initial);
    return initial;
  }
}

async function writeStore(data: StoreData) {
  await mkdir(dirname(storePath), { recursive: true });
  await writeFile(storePath, JSON.stringify(data, null, 2) + "\n", "utf8");
}

export async function listBusinesses() {
  return (await readStore()).businesses;
}

export async function getBusiness(businessId: string) {
  return (await readStore()).businesses.find((business) => business.id === businessId) ?? null;
}

export async function createBusiness(input: {
  name: string;
  programName?: string;
  logoUrl: string;
}) {
  const data = await readStore();
  const id = randomUUID().replaceAll("-", "").slice(0, 12);
  const business: Business = {
    id,
    name: input.name,
    issuerId: env.GOOGLE_WALLET_ISSUER_ID,
    classId: `${env.GOOGLE_WALLET_ISSUER_ID}.business_${id}`,
    programName: input.programName ?? `${input.name} Loyalty`,
    logoUrl: input.logoUrl,
    createdAt: new Date().toISOString()
  };

  data.businesses.push(business);
  await writeStore(data);
  return business;
}

export async function deleteBusiness(businessId: string) {
  const data = await readStore();
  const before = data.businesses.length;
  data.businesses = data.businesses.filter((business) => business.id !== businessId);

  if (data.businesses.length === before) {
    return false;
  }

  data.customers = data.customers.filter(
    (customer) => customer.businessId !== businessId
  );

  await writeStore(data);
  return true;
}

export async function upsertCustomer(input: {
  businessId: string;
  id: string;
  name: string;
  points: number;
}) {
  const data = await readStore();
  const existing = data.customers.find(
    (customer) =>
      customer.businessId === input.businessId && customer.id === input.id
  );

  if (existing) {
    existing.name = input.name;
    existing.points = input.points;
    await writeStore(data);
    return existing;
  }

  const customer: CustomerRecord = {
    ...input,
    createdAt: new Date().toISOString()
  };

  data.customers.push(customer);
  await writeStore(data);
  return customer;
}

export async function updateCustomerPoints(
  businessId: string,
  customerId: string,
  points: number
) {
  const data = await readStore();
  const customer = data.customers.find(
    (item) => item.businessId === businessId && item.id === customerId
  );

  if (!customer) return null;

  customer.points = points;
  await writeStore(data);
  return customer;
}

export async function getCustomer(businessId: string, customerId: string) {
  return (
    (await readStore()).customers.find(
      (customer) =>
        customer.businessId === businessId && customer.id === customerId
    ) ?? null
  );
}

