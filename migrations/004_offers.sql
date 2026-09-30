CREATE TABLE IF NOT EXISTS offers (
  id UUID PRIMARY KEY,
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  details TEXT NOT NULL,
  fine_print TEXT,
  provider TEXT NOT NULL,
  redemption_channel TEXT NOT NULL CHECK (redemption_channel IN ('INSTORE', 'ONLINE', 'BOTH')),
  code TEXT NOT NULL,
  starts_at TIMESTAMPTZ,
  ends_at TIMESTAMPTZ,
  state TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (state IN ('ACTIVE', 'INACTIVE')),
  class_id TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (ends_at IS NULL OR starts_at IS NULL OR ends_at > starts_at)
);

CREATE TABLE IF NOT EXISTS offer_objects (
  id UUID PRIMARY KEY,
  offer_id UUID NOT NULL REFERENCES offers(id) ON DELETE CASCADE,
  customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  wallet_object_id TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (offer_id, customer_id)
);

CREATE INDEX IF NOT EXISTS offers_business_created_at_idx
  ON offers (business_id, created_at DESC);

CREATE INDEX IF NOT EXISTS offer_objects_offer_id_idx
  ON offer_objects (offer_id);

CREATE INDEX IF NOT EXISTS offer_objects_customer_id_idx
  ON offer_objects (customer_id);
