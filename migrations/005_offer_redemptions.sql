CREATE TABLE IF NOT EXISTS offer_redemptions (
  id UUID PRIMARY KEY,
  offer_id UUID NOT NULL REFERENCES offers(id) ON DELETE CASCADE,
  customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  wallet_object_id TEXT NOT NULL REFERENCES offer_objects(wallet_object_id) ON DELETE CASCADE,
  redeemed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  notes TEXT,
  UNIQUE (offer_id, customer_id)
);

CREATE INDEX IF NOT EXISTS offer_redemptions_offer_id_idx
  ON offer_redemptions (offer_id, redeemed_at DESC);

CREATE INDEX IF NOT EXISTS offer_redemptions_customer_id_idx
  ON offer_redemptions (customer_id, redeemed_at DESC);
