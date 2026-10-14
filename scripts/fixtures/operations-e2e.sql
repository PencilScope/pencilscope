PRAGMA foreign_keys = ON;

INSERT INTO users (id, email, display_name, role, status, created_at, updated_at) VALUES
  ('e2e-system-admin', 'system-admin@e2e.invalid', 'E2E System Admin', 'admin', 'active', datetime('now'), datetime('now')),
  ('e2e-finance', 'finance@e2e.invalid', 'E2E Finance', 'student', 'active', datetime('now'), datetime('now')),
  ('e2e-support', 'support@e2e.invalid', 'E2E Support', 'student', 'active', datetime('now'), datetime('now')),
  ('e2e-auditor', 'auditor@e2e.invalid', 'E2E Auditor', 'student', 'active', datetime('now'), datetime('now')),
  ('e2e-learner-a', 'learner-a@e2e.invalid', 'E2E Learner A', 'student', 'active', datetime('now'), datetime('now')),
  ('e2e-learner-b', 'learner-b@e2e.invalid', 'E2E Learner B', 'student', 'active', datetime('now'), datetime('now'));

INSERT INTO platform_roles (user_id, role, granted_by, granted_at) VALUES
  ('e2e-system-admin', 'system_admin', 'e2e-system-admin', datetime('now')),
  ('e2e-finance', 'finance', 'e2e-system-admin', datetime('now')),
  ('e2e-support', 'support', 'e2e-system-admin', datetime('now')),
  ('e2e-auditor', 'auditor', 'e2e-system-admin', datetime('now'));

INSERT INTO orders
  (id, student_user_id, course_id, course_offering_id, stripe_checkout_session_id,
   stripe_payment_intent_id, amount_cents, currency, status, created_at, updated_at)
VALUES
  ('e2e-order-a', 'e2e-learner-a', 'course-maths-5', 'offering-course-maths-5',
   'cs_e2e_order_a', 'pi_e2e_order_a', 10000, 'SGD', 'paid',
   datetime('now', '-10 days'), datetime('now', '-10 days'));

INSERT INTO enrolments
  (id, course_id, student_user_id, order_id, status, enrolled_at)
VALUES
  ('e2e-enrolment-a', 'course-maths-5', 'e2e-learner-a', 'e2e-order-a', 'active', datetime('now', '-10 days'));

INSERT INTO enrolment_offerings
  (id, enrolment_id, course_offering_id, student_user_id, order_id, status, enrolled_at)
VALUES
  ('e2e-enrolment-offering-a', 'e2e-enrolment-a', 'offering-course-maths-5',
   'e2e-learner-a', 'e2e-order-a', 'active', datetime('now', '-10 days'));

INSERT INTO creator_earnings
  (id, order_id, course_id, course_offering_id, creator_user_id, currency,
   gross_cents, processing_fee_cents, platform_fee_cents, payable_cents,
   status, completion_at, review_ends_at, created_at, updated_at)
VALUES
  ('e2e-earning-a', 'e2e-order-a', 'course-maths-5', 'offering-course-maths-5',
   'tutor-tan', 'SGD', 10000, 300, 1050, 8650, 'held',
   datetime('now', '-8 days'), datetime('now', '-1 day'),
   datetime('now', '-10 days'), datetime('now'));

INSERT INTO payment_transactions
  (id, order_id, provider, provider_transaction_id, transaction_type,
   amount_cents, currency, status, metadata_json, occurred_at, created_at)
VALUES
  ('e2e-payment-a', 'e2e-order-a', 'stripe', 'pi_e2e_order_a', 'payment',
   10000, 'SGD', 'paid', '{}', datetime('now', '-10 days'), datetime('now', '-10 days'));

INSERT INTO payment_lifecycle_events
  (id, order_id, event_type, status, title, detail, provider_event_id,
   metadata_json, occurred_at, created_at)
VALUES
  ('e2e-payment-confirmed-a', 'e2e-order-a', 'payment_confirmed', 'paid',
   'Payment confirmed', 'Your payment was received securely.', 'pi_e2e_order_a',
   '{}', datetime('now', '-10 days'), datetime('now', '-10 days')),
  ('e2e-enrolment-created-a', 'e2e-order-a', 'enrolment_created', 'active',
   'Access granted', 'Your enrolment or booking is available.', NULL,
   '{}', datetime('now', '-10 days'), datetime('now', '-10 days'));

INSERT INTO learner_payment_cases
  (id, order_id, opened_by_user_id, case_type, status, amount_cents, reason,
   opened_at, updated_at)
VALUES
  ('e2e-payment-case-a', 'e2e-order-a', 'e2e-learner-a', 'service_issue',
   'open', 10000, 'The scheduled course service needs an operations review.',
   datetime('now', '-1 day'), datetime('now', '-1 day'));

INSERT INTO user_sessions
  (id, user_id, created_at, last_seen_at, expires_at, user_agent)
VALUES
  ('e2e-active-session', 'e2e-learner-a', datetime('now', '-5 minutes'),
   datetime('now'), datetime('now', '+1 day'), 'PencilScope E2E');
