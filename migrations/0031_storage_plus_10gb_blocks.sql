PRAGMA foreign_keys = ON;

-- Preserve the old Stripe catalogue entry and register the new entitlement as a
-- separate immutable plan. Stripe product and price ids are populated lazily by
-- the API or supplied through STRIPE_STORAGE_PRICE_ID.
ALTER TABLE creator_storage_billing_config ADD COLUMN block_bytes INTEGER CHECK (block_bytes > 0);
ALTER TABLE creator_storage_billing_config ADD COLUMN unit_amount_cents INTEGER CHECK (unit_amount_cents > 0);
ALTER TABLE creator_storage_billing_config ADD COLUMN currency TEXT;

UPDATE creator_storage_billing_config
SET block_bytes = 5000000000,
    unit_amount_cents = 500,
    currency = 'SGD'
WHERE plan_key = 'storage-plus-5gb';

INSERT OR IGNORE INTO creator_storage_billing_config
  (plan_key, stripe_product_id, stripe_price_id, block_bytes, unit_amount_cents, currency, created_at, updated_at)
VALUES
  ('storage-plus-10gb-v1', NULL, NULL, 10000000000, 500, 'SGD',
   '2026-10-12T00:00:00.000Z', '2026-10-12T00:00:00.000Z');
