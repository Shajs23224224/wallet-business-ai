CREATE INDEX IF NOT EXISTS customers_business_updated_at_idx
  ON customers (business_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS customers_business_name_idx
  ON customers (business_id, name);

CREATE INDEX IF NOT EXISTS customers_business_points_idx
  ON customers (business_id, points);
