PRAGMA foreign_keys = ON;

CREATE TABLE offering_settlement_policies (
  course_offering_id TEXT PRIMARY KEY REFERENCES course_offerings(id) ON DELETE CASCADE,
  creator_user_id TEXT NOT NULL REFERENCES users(id),
  platform_fee_bps INTEGER NOT NULL DEFAULT 1000 CHECK (platform_fee_bps BETWEEN 0 AND 10000),
  review_window_days INTEGER NOT NULL DEFAULT 7 CHECK (review_window_days BETWEEN 0 AND 90),
  reserve_bps INTEGER NOT NULL DEFAULT 0 CHECK (reserve_bps BETWEEN 0 AND 10000),
  meeting_billing_mode TEXT NOT NULL DEFAULT 'creator_owned'
    CHECK (meeting_billing_mode IN ('creator_owned', 'platform_metered')),
  meeting_rate_micros INTEGER NOT NULL DEFAULT 4000 CHECK (meeting_rate_micros >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE meeting_usage_records (
  id TEXT PRIMARY KEY,
  course_session_id TEXT NOT NULL REFERENCES course_sessions(id) ON DELETE CASCADE,
  course_offering_id TEXT NOT NULL REFERENCES course_offerings(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  provider_event_id TEXT NOT NULL,
  participant_minutes INTEGER NOT NULL CHECK (participant_minutes >= 0),
  rate_micros INTEGER NOT NULL CHECK (rate_micros >= 0),
  amount_cents INTEGER NOT NULL CHECK (amount_cents >= 0),
  status TEXT NOT NULL DEFAULT 'finalized' CHECK (status IN ('pending', 'finalized', 'void')),
  observed_at TEXT NOT NULL,
  finalized_at TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(provider, provider_event_id)
);
CREATE INDEX meeting_usage_offering_idx ON meeting_usage_records(course_offering_id, status, observed_at);
CREATE INDEX meeting_usage_session_idx ON meeting_usage_records(course_session_id, status, observed_at);

CREATE TABLE learner_payment_cases (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  opened_by_user_id TEXT REFERENCES users(id),
  case_type TEXT NOT NULL CHECK (case_type IN ('service_issue', 'refund_request', 'payment_dispute')),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'reviewing', 'resolved', 'rejected', 'refunded', 'cancelled')),
  amount_cents INTEGER NOT NULL DEFAULT 0 CHECK (amount_cents >= 0),
  reason TEXT NOT NULL,
  provider_case_id TEXT UNIQUE,
  resolution_note TEXT,
  opened_at TEXT NOT NULL,
  resolved_at TEXT,
  updated_at TEXT NOT NULL
);
CREATE INDEX learner_payment_cases_order_idx ON learner_payment_cases(order_id, status, opened_at);

CREATE TABLE creator_earnings (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL UNIQUE REFERENCES orders(id) ON DELETE CASCADE,
  course_id TEXT NOT NULL REFERENCES courses(id),
  course_offering_id TEXT NOT NULL REFERENCES course_offerings(id),
  creator_user_id TEXT NOT NULL REFERENCES users(id),
  currency TEXT NOT NULL,
  gross_cents INTEGER NOT NULL CHECK (gross_cents >= 0),
  processing_fee_cents INTEGER NOT NULL DEFAULT 0 CHECK (processing_fee_cents >= 0),
  platform_fee_cents INTEGER NOT NULL DEFAULT 0 CHECK (platform_fee_cents >= 0),
  meeting_usage_fee_cents INTEGER NOT NULL DEFAULT 0 CHECK (meeting_usage_fee_cents >= 0),
  refund_cents INTEGER NOT NULL DEFAULT 0 CHECK (refund_cents >= 0),
  dispute_hold_cents INTEGER NOT NULL DEFAULT 0 CHECK (dispute_hold_cents >= 0),
  reserve_cents INTEGER NOT NULL DEFAULT 0 CHECK (reserve_cents >= 0),
  payable_cents INTEGER NOT NULL DEFAULT 0 CHECK (payable_cents >= 0),
  status TEXT NOT NULL DEFAULT 'pending_course' CHECK (status IN (
    'pending_course', 'pending_usage', 'review_period', 'held', 'eligible',
    'payout_setup_required', 'transferring', 'transferred', 'paid',
    'zero_balance', 'reversal_required', 'reversed'
  )),
  completion_at TEXT,
  review_ends_at TEXT,
  stripe_transfer_id TEXT UNIQUE,
  transferred_at TEXT,
  paid_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX creator_earnings_creator_idx ON creator_earnings(creator_user_id, status, updated_at);
CREATE INDEX creator_earnings_offering_idx ON creator_earnings(course_offering_id, status, updated_at);

CREATE TABLE settlement_transfers (
  id TEXT PRIMARY KEY,
  creator_user_id TEXT NOT NULL REFERENCES users(id),
  currency TEXT NOT NULL,
  amount_cents INTEGER NOT NULL CHECK (amount_cents >= 0),
  provider TEXT NOT NULL DEFAULT 'stripe',
  provider_transfer_id TEXT UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('processing', 'transferred', 'failed', 'reversed')),
  earning_ids_json TEXT NOT NULL DEFAULT '[]',
  error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX settlement_transfers_creator_idx ON settlement_transfers(creator_user_id, status, created_at);

INSERT OR IGNORE INTO offering_settlement_policies
  (course_offering_id, creator_user_id, platform_fee_bps, review_window_days,
   reserve_bps, meeting_billing_mode, meeting_rate_micros, created_at, updated_at)
SELECT o.id, c.tutor_id, 1000, 7, 0,
  CASE WHEN EXISTS (
    SELECT 1 FROM course_sessions s
    WHERE s.course_offering_id = o.id AND s.delivery_mode = 'live_online'
      AND LOWER(COALESCE(s.meeting_provider, '')) IN ('daily', 'twilio', 'pencilscope')
  ) THEN 'platform_metered' ELSE 'creator_owned' END,
  4000, datetime('now'), datetime('now')
FROM course_offerings o JOIN courses c ON c.id = o.course_id
WHERE c.tutor_id IS NOT NULL;

INSERT OR IGNORE INTO creator_earnings
  (id, order_id, course_id, course_offering_id, creator_user_id, currency,
   gross_cents, platform_fee_cents, reserve_cents, payable_cents, status,
   created_at, updated_at)
SELECT 'earning-' || ord.id, ord.id, ord.course_id, ord.course_offering_id,
  p.creator_user_id, ord.currency, ord.amount_cents,
  CAST((ord.amount_cents * p.platform_fee_bps + 9999) / 10000 AS INTEGER),
  CAST((ord.amount_cents * p.reserve_bps + 9999) / 10000 AS INTEGER),
  MAX(0, ord.amount_cents
    - CAST((ord.amount_cents * p.platform_fee_bps + 9999) / 10000 AS INTEGER)
    - CAST((ord.amount_cents * p.reserve_bps + 9999) / 10000 AS INTEGER)),
  'pending_course', datetime('now'), datetime('now')
FROM orders ord
JOIN offering_settlement_policies p ON p.course_offering_id = ord.course_offering_id
WHERE ord.status = 'paid' AND ord.course_offering_id IS NOT NULL;
