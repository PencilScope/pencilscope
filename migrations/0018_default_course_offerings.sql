PRAGMA foreign_keys = ON;

-- A published course must have one purchasable access package. Reuse the
-- already-synchronised course price so this repair is idempotent and does not
-- create duplicate Stripe products or prices.
INSERT OR IGNORE INTO academic_terms
  (id, academic_year, term_number, title, starts_at, ends_at, created_at)
VALUES
  ('academic-term-legacy', 2000, 0, 'Full course access', NULL, NULL, datetime('now'));

INSERT OR IGNORE INTO course_offerings
  (id, course_id, academic_term_id, title, enrolment_opens_at, enrolment_closes_at,
   access_ends_at, price_cents, currency, pricing_version, stripe_price_id,
   pricing_status, status, offering_type, delivery_mode, starts_at, ends_at,
   timezone, capacity, created_at, updated_at)
SELECT
  'offering-' || c.id,
  c.id,
  'academic-term-legacy',
  'Full course access',
  NULL,
  NULL,
  NULL,
  c.price_cents,
  c.currency,
  c.pricing_version,
  c.stripe_price_id,
  c.pricing_status,
  CASE WHEN c.pricing_status = 'ready' AND c.stripe_price_id IS NOT NULL
    THEN 'published' ELSE 'draft' END,
  CASE WHEN c.delivery_mode IN ('self-paced', 'ai-supported')
    THEN 'self_paced' ELSE 'cohort' END,
  CASE WHEN c.delivery_mode = 'live' THEN 'live_online'
    WHEN c.delivery_mode = 'hybrid' THEN 'hybrid' ELSE 'recorded' END,
  NULL,
  NULL,
  'Asia/Singapore',
  NULL,
  c.created_at,
  datetime('now')
FROM courses c
WHERE c.status = 'published'
  AND NOT EXISTS (SELECT 1 FROM course_offerings o WHERE o.course_id = c.id);

INSERT OR IGNORE INTO course_offering_prices
  (id, course_offering_id, stripe_price_id, amount_cents, currency,
   pricing_version, active, created_at)
SELECT
  'default-offering-price-' || c.id,
  'offering-' || c.id,
  c.stripe_price_id,
  c.price_cents,
  c.currency,
  c.pricing_version,
  1,
  datetime('now')
FROM courses c
JOIN course_offerings o ON o.id = 'offering-' || c.id
WHERE c.stripe_price_id IS NOT NULL;

INSERT OR IGNORE INTO course_offering_modules (course_offering_id, module_id, position)
SELECT 'offering-' || m.course_id, m.id, m.position
FROM course_modules m
JOIN course_offerings o ON o.id = 'offering-' || m.course_id;

INSERT OR IGNORE INTO course_offering_assessments (course_offering_id, assessment_id, position)
SELECT
  'offering-' || a.course_id,
  a.id,
  ROW_NUMBER() OVER (PARTITION BY a.course_id ORDER BY a.created_at, a.id)
FROM assessments a
JOIN course_offerings o ON o.id = 'offering-' || a.course_id
WHERE a.status = 'published';

INSERT OR IGNORE INTO course_offering_materials (course_offering_id, material_id, position)
SELECT
  'offering-' || m.course_id,
  m.id,
  ROW_NUMBER() OVER (PARTITION BY m.course_id ORDER BY m.created_at, m.id)
FROM course_materials m
JOIN course_offerings o ON o.id = 'offering-' || m.course_id
WHERE m.status = 'published';

INSERT OR IGNORE INTO course_offering_flashcard_decks (course_offering_id, deck_id, position)
SELECT
  'offering-' || d.course_id,
  d.id,
  ROW_NUMBER() OVER (PARTITION BY d.course_id ORDER BY d.created_at, d.id)
FROM flashcard_decks d
JOIN course_offerings o ON o.id = 'offering-' || d.course_id
WHERE d.status = 'published';

INSERT OR IGNORE INTO audit_logs
  (id, actor_user_id, action, entity_type, entity_id, metadata_json, created_at)
SELECT
  'audit-default-offering-' || c.id,
  c.tutor_id,
  'course.default_offering_created',
  'course_offering',
  'offering-' || c.id,
  json_object('courseId', c.id, 'source', 'migration'),
  datetime('now')
FROM courses c
JOIN course_offerings o ON o.id = 'offering-' || c.id;
