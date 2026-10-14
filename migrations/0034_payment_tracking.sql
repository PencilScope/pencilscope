PRAGMA foreign_keys = ON;

CREATE TABLE payment_lifecycle_events (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL CHECK (event_type IN (
    'payment_confirmed', 'enrolment_created', 'delivery_completed',
    'review_started', 'payout_eligible', 'payout_batched',
    'payout_processing', 'payout_paid', 'payout_failed',
    'issue_opened', 'refund_recorded', 'dispute_opened',
    'dispute_resolved', 'adjustment_recorded'
  )),
  status TEXT NOT NULL,
  title TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  actor_user_id TEXT REFERENCES users(id),
  provider_event_id TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  occurred_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(order_id, event_type, provider_event_id)
);
CREATE INDEX payment_lifecycle_order_idx ON payment_lifecycle_events(order_id, occurred_at, id);

CREATE TABLE creator_payout_batches (
  id TEXT PRIMARY KEY,
  creator_user_id TEXT NOT NULL REFERENCES users(id),
  currency TEXT NOT NULL,
  gross_cents INTEGER NOT NULL DEFAULT 0 CHECK (gross_cents >= 0),
  deduction_cents INTEGER NOT NULL DEFAULT 0 CHECK (deduction_cents >= 0),
  amount_cents INTEGER NOT NULL CHECK (amount_cents >= 0),
  earning_count INTEGER NOT NULL DEFAULT 0 CHECK (earning_count >= 0),
  status TEXT NOT NULL CHECK (status IN ('scheduled', 'processing', 'paid', 'failed', 'held', 'reversed')),
  period_starts_at TEXT NOT NULL,
  period_ends_at TEXT NOT NULL,
  scheduled_for TEXT NOT NULL,
  provider TEXT NOT NULL DEFAULT 'stripe',
  provider_transfer_id TEXT UNIQUE,
  failure_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  paid_at TEXT
);
CREATE INDEX creator_payout_batches_creator_idx ON creator_payout_batches(creator_user_id, status, scheduled_for);

CREATE TABLE creator_payout_batch_items (
  payout_batch_id TEXT NOT NULL REFERENCES creator_payout_batches(id) ON DELETE CASCADE,
  creator_earning_id TEXT NOT NULL UNIQUE REFERENCES creator_earnings(id),
  order_id TEXT NOT NULL REFERENCES orders(id),
  gross_cents INTEGER NOT NULL CHECK (gross_cents >= 0),
  deduction_cents INTEGER NOT NULL CHECK (deduction_cents >= 0),
  amount_cents INTEGER NOT NULL CHECK (amount_cents >= 0),
  created_at TEXT NOT NULL,
  PRIMARY KEY (payout_batch_id, creator_earning_id)
);
CREATE INDEX creator_payout_batch_items_order_idx ON creator_payout_batch_items(order_id, payout_batch_id);

INSERT OR IGNORE INTO payment_lifecycle_events
  (id, order_id, event_type, status, title, detail, provider_event_id, metadata_json, occurred_at, created_at)
SELECT 'payment-confirmed-' || o.id, o.id, 'payment_confirmed', o.status,
  'Payment confirmed', 'Your payment was received securely.',
  COALESCE(o.stripe_payment_intent_id, o.stripe_checkout_session_id), '{}', o.created_at, datetime('now')
FROM orders o WHERE o.status IN ('paid', 'refunded');

INSERT OR IGNORE INTO payment_lifecycle_events
  (id, order_id, event_type, status, title, detail, provider_event_id, metadata_json, occurred_at, created_at)
SELECT 'enrolment-created-' || o.id, o.id, 'enrolment_created', e.status,
  'Access granted', 'Your enrolment or booking is available.', NULL, '{}', e.enrolled_at, datetime('now')
FROM orders o JOIN enrolments e ON e.order_id = o.id;

INSERT OR IGNORE INTO payment_lifecycle_events
  (id, order_id, event_type, status, title, detail, provider_event_id, metadata_json, occurred_at, created_at)
SELECT 'refund-recorded-' || pt.id, pt.order_id, 'refund_recorded', pt.status,
  'Refund recorded', 'A refund was recorded for this payment.', pt.provider_transaction_id,
  json_object('amountCents', pt.amount_cents, 'currency', pt.currency), pt.occurred_at, datetime('now')
FROM payment_transactions pt WHERE pt.transaction_type = 'refund';
