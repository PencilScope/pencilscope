ALTER TABLE tutor_profiles ADD COLUMN stripe_details_submitted INTEGER NOT NULL DEFAULT 0
  CHECK (stripe_details_submitted IN (0, 1));
ALTER TABLE tutor_profiles ADD COLUMN stripe_charges_enabled INTEGER NOT NULL DEFAULT 0
  CHECK (stripe_charges_enabled IN (0, 1));
ALTER TABLE tutor_profiles ADD COLUMN stripe_payouts_enabled INTEGER NOT NULL DEFAULT 0
  CHECK (stripe_payouts_enabled IN (0, 1));
ALTER TABLE tutor_profiles ADD COLUMN stripe_account_updated_at TEXT;

CREATE INDEX tutor_profiles_payout_ready_idx
  ON tutor_profiles(stripe_payouts_enabled, stripe_account_updated_at);
