import type Stripe from "stripe";
import { getCreatorActorById } from "../../../src/lib/auth";
import { json, problem } from "../../../src/lib/http";
import { createStripe } from "../../../src/lib/stripe";
import type { ApiEnvironment } from "./index";

type EarningRow = {
  id: string;
  order_id: string;
  creator_user_id: string;
  currency: string;
  gross_cents: number;
  processing_fee_cents: number;
  platform_fee_cents: number;
  dispute_hold_cents: number;
  refund_cents: number;
  reserve_cents: number;
  status: string;
  created_at?: string;
};

type SettlementPolicy = {
  course_offering_id: string;
  creator_user_id: string;
  review_window_days: number;
  meeting_billing_mode: "creator_owned" | "platform_metered";
  meeting_rate_micros: number;
  completion_at: string | null;
  pending_usage_sessions: number;
};

const TERMINAL_EARNING_STATUSES = ["transferred", "paid", "reversal_required", "reversed"];

function configuredInteger(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

function actorId(request: Request): string | null {
  return request.headers.get("x-pencilscope-user-id")?.trim() || null;
}

function paymentIntentId(value: string | Stripe.PaymentIntent | null): string | null {
  if (typeof value === "string") return value;
  return value?.id ?? null;
}

function internalRequestAuthorized(request: Request, env: ApiEnvironment): boolean {
  const configured = env.MEETING_USAGE_WEBHOOK_SECRET;
  const authorization = request.headers.get("authorization");
  return Boolean(configured && authorization === `Bearer ${configured}`);
}

async function ensurePolicyForOffering(env: ApiEnvironment, offeringId: string): Promise<void> {
  const now = new Date().toISOString();
  const platformFeeBps = configuredInteger(env.PLATFORM_FEE_BPS, 1000, 0, 10000);
  const reviewDays = configuredInteger(env.SETTLEMENT_REVIEW_DAYS, 7, 0, 90);
  const reserveBps = configuredInteger(env.CREATOR_RESERVE_BPS, 0, 0, 10000);
  const meetingRateMicros = configuredInteger(env.PLATFORM_MEETING_RATE_MICROS, 4000, 0, 1_000_000);
  await env.DB.prepare(
    `INSERT OR IGNORE INTO offering_settlement_policies
      (course_offering_id, creator_user_id, platform_fee_bps, platform_fixed_fee_cents,
       planned_meeting_budget_cents, review_window_days, reserve_bps,
       meeting_billing_mode, meeting_rate_micros, created_at, updated_at)
     SELECT o.id, c.tutor_id, COALESCE(NULLIF(o.service_fee_bps, 0), ?),
       o.platform_fixed_fee_cents, o.planned_meeting_cost_cents, ?, ?,
       CASE WHEN EXISTS (
         SELECT 1 FROM course_sessions s
         WHERE s.course_offering_id = o.id AND s.delivery_mode = 'live_online'
           AND LOWER(COALESCE(s.meeting_provider, '')) IN ('daily', 'twilio', 'pencilscope', 'google_meet')
       ) THEN 'platform_metered' ELSE 'creator_owned' END,
       ?, ?, ?
     FROM course_offerings o JOIN courses c ON c.id = o.course_id
     WHERE o.id = ? AND c.tutor_id IS NOT NULL`
  ).bind(
    platformFeeBps,
    reviewDays,
    reserveBps,
    meetingRateMicros,
    now,
    now,
    offeringId
  ).run();
}

export async function ensureCreatorEarningForOrder(env: ApiEnvironment, orderId: string): Promise<void> {
  const order = await env.DB.prepare(
    "SELECT course_offering_id FROM orders WHERE id = ?"
  ).bind(orderId).first<{ course_offering_id: string | null }>();
  if (!order?.course_offering_id) return;
  await ensurePolicyForOffering(env, order.course_offering_id);
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT OR IGNORE INTO creator_earnings
      (id, order_id, course_id, course_offering_id, creator_user_id, currency,
       gross_cents, platform_fee_cents, reserve_cents, payable_cents, status,
       created_at, updated_at)
     SELECT ?, o.id, o.course_id, o.course_offering_id, p.creator_user_id, o.currency,
       o.amount_cents,
       p.platform_fixed_fee_cents
         + CAST((co.creator_price_cents * p.platform_fee_bps + 9999) / 10000 AS INTEGER),
       CAST((o.amount_cents * p.reserve_bps + 9999) / 10000 AS INTEGER),
       MAX(0, o.amount_cents
         - p.platform_fixed_fee_cents
         - CAST((co.creator_price_cents * p.platform_fee_bps + 9999) / 10000 AS INTEGER)
         - CAST((o.amount_cents * p.reserve_bps + 9999) / 10000 AS INTEGER)),
       'pending_course', ?, ?
     FROM orders o JOIN offering_settlement_policies p
       ON p.course_offering_id = o.course_offering_id
     JOIN course_offerings co ON co.id = o.course_offering_id
     WHERE o.id = ? AND o.status = 'paid'`
  ).bind(crypto.randomUUID(), now, now, orderId).run();
}

async function refreshPayable(env: ApiEnvironment, orderId: string): Promise<void> {
  await env.DB.prepare(
    `UPDATE creator_earnings SET payable_cents = MAX(0,
       gross_cents - processing_fee_cents - platform_fee_cents
       - meeting_usage_fee_cents - refund_cents - reserve_cents),
       updated_at = ?
     WHERE order_id = ?`
  ).bind(new Date().toISOString(), orderId).run();
}

async function settlementPolicy(env: ApiEnvironment, offeringId: string): Promise<SettlementPolicy | null> {
  return env.DB.prepare(
    `SELECT p.course_offering_id, p.creator_user_id, p.review_window_days,
       p.meeting_billing_mode, p.meeting_rate_micros,
       COALESCE(
         (SELECT MAX(s.ends_at) FROM course_sessions s
          WHERE s.course_offering_id = p.course_offering_id AND s.status != 'cancelled'),
         o.ends_at, o.access_ends_at
       ) AS completion_at,
       CASE WHEN p.meeting_billing_mode = 'platform_metered' THEN (
         SELECT COUNT(*) FROM course_sessions s
         WHERE s.course_offering_id = p.course_offering_id
           AND s.delivery_mode = 'live_online' AND s.status != 'cancelled'
           AND s.ends_at <= ?
           AND NOT EXISTS (
             SELECT 1 FROM meeting_usage_records mu
             WHERE mu.course_session_id = s.id AND mu.status = 'finalized'
           )
       ) ELSE 0 END AS pending_usage_sessions
     FROM offering_settlement_policies p
     JOIN course_offerings o ON o.id = p.course_offering_id
     WHERE p.course_offering_id = ?`
  ).bind(new Date().toISOString(), offeringId).first<SettlementPolicy>();
}

async function allocateMeetingUsage(env: ApiEnvironment, offeringId: string): Promise<EarningRow[]> {
  const usage = await env.DB.prepare(
    `SELECT COALESCE(SUM(amount_cents), 0) AS total
     FROM meeting_usage_records WHERE course_offering_id = ? AND status = 'finalized'`
  ).bind(offeringId).first<{ total: number }>();
  const result = await env.DB.prepare(
    `SELECT id, order_id, creator_user_id, currency, gross_cents,
       processing_fee_cents, platform_fee_cents, dispute_hold_cents, refund_cents,
       reserve_cents, status
     FROM creator_earnings WHERE course_offering_id = ? ORDER BY created_at, id`
  ).bind(offeringId).all<EarningRow>();
  const earnings = result.results;
  const totalGross = earnings.reduce((sum, earning) => sum + Number(earning.gross_cents), 0);
  const policy = await env.DB.prepare(
    "SELECT planned_meeting_budget_cents FROM offering_settlement_policies WHERE course_offering_id = ?"
  ).bind(offeringId).first<{ planned_meeting_budget_cents: number }>();
  const availableAfterFees = earnings.reduce((sum, earning) => sum + Math.max(0,
    Number(earning.gross_cents) - Number(earning.processing_fee_cents)
      - Number(earning.platform_fee_cents) - Number(earning.refund_cents)
      - Number(earning.reserve_cents)
  ), 0);
  const recordedUsage = Number(usage?.total ?? 0);
  const plannedBudget = Number(policy?.planned_meeting_budget_cents ?? 0);
  const cappedUsage = Math.min(recordedUsage, plannedBudget > 0 ? plannedBudget : recordedUsage, availableAfterFees);
  let remainingUsage = cappedUsage;
  for (let index = 0; index < earnings.length; index += 1) {
    const earning = earnings[index];
    const allocation = index === earnings.length - 1
      ? remainingUsage
      : totalGross > 0
        ? Math.floor(cappedUsage * Number(earning.gross_cents) / totalGross)
        : 0;
    remainingUsage -= allocation;
    await env.DB.prepare(
      `UPDATE creator_earnings SET meeting_usage_fee_cents = ?,
       payable_cents = MAX(0, gross_cents - processing_fee_cents - platform_fee_cents
         - ? - refund_cents - reserve_cents), updated_at = ?
       WHERE id = ?`
    ).bind(allocation, allocation, new Date().toISOString(), earning.id).run();
  }
  return earnings;
}

async function transferEligibleEarning(
  env: ApiEnvironment,
  earning: EarningRow & { payable_cents: number },
  connectedAccountId: string
): Promise<void> {
  if (!env.STRIPE_SECRET_KEY || earning.payable_cents <= 0) return;
  const now = new Date().toISOString();
  const transferRecordId = crypto.randomUUID();
  const payoutBatchId = crypto.randomUUID();
  const periodStartsAt = new Date(Date.now() - 7 * 86_400_000).toISOString();
  const deductions = Math.max(0, Number(earning.gross_cents) - Number(earning.payable_cents));
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO creator_payout_batches
        (id, creator_user_id, currency, gross_cents, deduction_cents, amount_cents,
         earning_count, status, period_starts_at, period_ends_at, scheduled_for,
         created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, 'processing', ?, ?, ?, ?, ?)`
    ).bind(
      payoutBatchId, earning.creator_user_id, earning.currency, earning.gross_cents,
      deductions, earning.payable_cents, periodStartsAt, now, now, now, now
    ),
    env.DB.prepare(
      `INSERT INTO creator_payout_batch_items
        (payout_batch_id, creator_earning_id, order_id, gross_cents,
         deduction_cents, amount_cents, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      payoutBatchId, earning.id, earning.order_id, earning.gross_cents,
      deductions, earning.payable_cents, now
    ),
    env.DB.prepare(
      `INSERT INTO settlement_transfers
        (id, creator_user_id, currency, amount_cents, status, earning_ids_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'processing', ?, ?, ?)`
    ).bind(
      transferRecordId,
      earning.creator_user_id,
      earning.currency,
      earning.payable_cents,
      JSON.stringify([earning.id]),
      now,
      now
    ),
    env.DB.prepare(
      "UPDATE creator_earnings SET status = 'transferring', last_error = NULL, updated_at = ? WHERE id = ? AND status = 'eligible'"
    ).bind(now, earning.id),
    env.DB.prepare(
      `INSERT OR IGNORE INTO payment_lifecycle_events
        (id, order_id, event_type, status, title, detail, provider_event_id,
         metadata_json, occurred_at, created_at)
       VALUES (?, ?, 'payout_batched', 'processing', 'Included in creator payout',
         'The eligible earning is being sent in a creator payout batch.', ?, ?, ?, ?)`
    ).bind(
      `payout-batched-${earning.id}`, earning.order_id, payoutBatchId,
      JSON.stringify({ payoutBatchId, amountCents: earning.payable_cents, currency: earning.currency }),
      now, now
    )
  ]);
  try {
    const stripe = createStripe(env.STRIPE_SECRET_KEY);
    const transfer = await stripe.transfers.create({
      amount: earning.payable_cents,
      currency: earning.currency.toLowerCase(),
      destination: connectedAccountId,
      transfer_group: `order_${earning.order_id}`,
      metadata: { orderId: earning.order_id, earningId: earning.id }
    }, { idempotencyKey: `creator-earning-${earning.id}` });
    const transferredAt = new Date().toISOString();
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE creator_earnings SET status = 'transferred', stripe_transfer_id = ?,
         transferred_at = ?, updated_at = ? WHERE id = ?`
      ).bind(transfer.id, transferredAt, transferredAt, earning.id),
      env.DB.prepare(
        `UPDATE settlement_transfers SET provider_transfer_id = ?, status = 'transferred',
         updated_at = ? WHERE id = ?`
      ).bind(transfer.id, transferredAt, transferRecordId),
      env.DB.prepare(
        `UPDATE creator_payout_batches SET provider_transfer_id = ?, status = 'paid',
         paid_at = ?, updated_at = ? WHERE id = ?`
      ).bind(transfer.id, transferredAt, transferredAt, payoutBatchId),
      env.DB.prepare(
        `INSERT OR IGNORE INTO payment_lifecycle_events
          (id, order_id, event_type, status, title, detail, provider_event_id,
           metadata_json, occurred_at, created_at)
         VALUES (?, ?, 'payout_paid', 'paid', 'Creator payout sent',
           'This earning was included in a creator payout.', ?, ?, ?, ?)`
      ).bind(
        `payout-paid-${earning.id}`, earning.order_id, transfer.id,
        JSON.stringify({ payoutBatchId, amountCents: earning.payable_cents, currency: earning.currency }),
        transferredAt, transferredAt
      ),
      env.DB.prepare(
        `INSERT OR IGNORE INTO payment_transactions
          (id, order_id, provider, provider_transaction_id, transaction_type,
           amount_cents, currency, status, metadata_json, occurred_at, created_at)
         VALUES (?, ?, 'stripe', ?, 'payout', ?, ?, 'transferred', ?, ?, ?)`
      ).bind(
        crypto.randomUUID(),
        earning.order_id,
        transfer.id,
        earning.payable_cents,
        earning.currency,
        JSON.stringify({ connectedAccountId }),
        transferredAt,
        transferredAt
      )
    ]);
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 500) : "Transfer failed";
    const failedAt = new Date().toISOString();
    await env.DB.batch([
      env.DB.prepare(
        "UPDATE creator_earnings SET status = 'eligible', last_error = ?, updated_at = ? WHERE id = ?"
      ).bind(message, failedAt, earning.id),
      env.DB.prepare(
        "UPDATE settlement_transfers SET status = 'failed', error_message = ?, updated_at = ? WHERE id = ?"
      ).bind(message, failedAt, transferRecordId),
      env.DB.prepare(
        "UPDATE creator_payout_batches SET status = 'failed', failure_message = ?, updated_at = ? WHERE id = ?"
      ).bind(message, failedAt, payoutBatchId),
      env.DB.prepare(
        `INSERT OR IGNORE INTO payment_lifecycle_events
          (id, order_id, event_type, status, title, detail, provider_event_id,
           metadata_json, occurred_at, created_at)
         VALUES (?, ?, 'payout_failed', 'failed', 'Creator payout needs attention',
           'The payout could not be completed and will remain available for retry.', ?, ?, ?, ?)`
      ).bind(
        `payout-failed-${payoutBatchId}`, earning.order_id, payoutBatchId,
        JSON.stringify({ payoutBatchId }), failedAt, failedAt
      )
    ]);
  }
}

async function reconcileOffering(
  env: ApiEnvironment,
  offeringId: string,
  executeTransfers: boolean
): Promise<void> {
  await ensurePolicyForOffering(env, offeringId);
  const policy = await settlementPolicy(env, offeringId);
  if (!policy) return;
  await allocateMeetingUsage(env, offeringId);
  const earningsResult = await env.DB.prepare(
    `SELECT id, order_id, creator_user_id, currency, gross_cents, processing_fee_cents,
       platform_fee_cents, meeting_usage_fee_cents, dispute_hold_cents, refund_cents, reserve_cents,
       payable_cents, status, created_at
     FROM creator_earnings WHERE course_offering_id = ? ORDER BY created_at, id`
  ).bind(offeringId).all<EarningRow & { meeting_usage_fee_cents: number; payable_cents: number }>();
  const creatorAccount = await env.DB.prepare(
    `SELECT stripe_account_id, stripe_details_submitted, stripe_payouts_enabled
     FROM tutor_profiles WHERE user_id = ?`
  ).bind(policy.creator_user_id).first<{
    stripe_account_id: string | null;
    stripe_details_submitted: number;
    stripe_payouts_enabled: number;
  }>();
  const now = new Date();
  for (const earning of earningsResult.results) {
    if (TERMINAL_EARNING_STATUSES.includes(earning.status)) continue;
    const completion = policy.completion_at
      ? new Date(policy.completion_at)
      : earning.created_at ? new Date(earning.created_at) : null;
    const reviewEnds = completion
      ? new Date(completion.getTime() + Number(policy.review_window_days) * 86_400_000)
      : null;
    const openCase = await env.DB.prepare(
      `SELECT COUNT(*) AS total FROM learner_payment_cases
       WHERE order_id = ? AND status IN ('open', 'reviewing')`
    ).bind(earning.order_id).first<{ total: number }>();
    const payable = Math.max(
      0,
      Number(earning.gross_cents)
        - Number(earning.processing_fee_cents)
        - Number(earning.platform_fee_cents)
        - Number(earning.meeting_usage_fee_cents)
        - Number(earning.refund_cents)
        - Number(earning.reserve_cents)
    );
    let status = "pending_course";
    if (!completion || completion > now) status = "pending_course";
    else if (Number(policy.pending_usage_sessions) > 0) status = "pending_usage";
    else if (Number(openCase?.total ?? 0) > 0 || Number(earning.dispute_hold_cents ?? 0) > 0) status = "held";
    else if (reviewEnds && reviewEnds > now) status = "review_period";
    else if (payable <= 0) status = "zero_balance";
    else if (executeTransfers && (!creatorAccount?.stripe_account_id
      || !creatorAccount.stripe_details_submitted || !creatorAccount.stripe_payouts_enabled)) {
      status = "payout_setup_required";
    }
    else status = "eligible";
    await env.DB.prepare(
      `UPDATE creator_earnings SET payable_cents = ?, status = ?, completion_at = ?,
       review_ends_at = ?, updated_at = ? WHERE id = ?`
    ).bind(
      payable,
      status,
      completion?.toISOString() ?? null,
      reviewEnds?.toISOString() ?? null,
      new Date().toISOString(),
      earning.id
    ).run();
    if (completion && completion <= now) {
      const milestoneStatements = [
        env.DB.prepare(
          `INSERT OR IGNORE INTO payment_lifecycle_events
            (id, order_id, event_type, status, title, detail, provider_event_id,
             metadata_json, occurred_at, created_at)
           VALUES (?, ?, 'delivery_completed', 'completed', 'Course delivery completed',
             'The course delivery period has ended.', ?, '{}', ?, ?)`
        ).bind(
          `delivery-completed-${earning.id}`, earning.order_id, earning.id,
          completion.toISOString(), new Date().toISOString()
        )
      ];
      if (reviewEnds) {
        milestoneStatements.push(env.DB.prepare(
          `INSERT OR IGNORE INTO payment_lifecycle_events
            (id, order_id, event_type, status, title, detail, provider_event_id,
             metadata_json, occurred_at, created_at)
           VALUES (?, ?, 'review_started', ?, 'Learner review period',
             'The seven-day review period started after delivery.', ?, ?, ?, ?)`
        ).bind(
          `review-started-${earning.id}`, earning.order_id,
          reviewEnds > now ? "active" : "completed", earning.id,
          JSON.stringify({ reviewEndsAt: reviewEnds.toISOString() }),
          completion.toISOString(), new Date().toISOString()
        ));
      }
      if (status === "eligible") {
        milestoneStatements.push(env.DB.prepare(
          `INSERT OR IGNORE INTO payment_lifecycle_events
            (id, order_id, event_type, status, title, detail, provider_event_id,
             metadata_json, occurred_at, created_at)
           VALUES (?, ?, 'payout_eligible', 'eligible', 'Eligible for creator payout',
             'Delivery and the learner review period are complete.', ?, '{}', ?, ?)`
        ).bind(
          `payout-eligible-${earning.id}`, earning.order_id, earning.id,
          reviewEnds?.toISOString() ?? new Date().toISOString(), new Date().toISOString()
        ));
      }
      await env.DB.batch(milestoneStatements);
    }
    if (status === "eligible" && executeTransfers && creatorAccount?.stripe_account_id) {
      await transferEligibleEarning(env, { ...earning, payable_cents: payable }, creatorAccount.stripe_account_id);
    }
  }
}

export async function reconcileCreatorSettlements(
  env: ApiEnvironment,
  creatorUserId?: string,
  forceTransfers = false
): Promise<number> {
  const automaticTransfers = forceTransfers || env.ENABLE_AUTOMATIC_TRANSFERS === "true";
  const result = creatorUserId
    ? await env.DB.prepare(
      "SELECT DISTINCT course_offering_id FROM creator_earnings WHERE creator_user_id = ?"
    ).bind(creatorUserId).all<{ course_offering_id: string }>()
    : await env.DB.prepare(
      "SELECT DISTINCT course_offering_id FROM creator_earnings"
    ).all<{ course_offering_id: string }>();
  for (const row of result.results) {
    await reconcileOffering(env, row.course_offering_id, automaticTransfers);
  }
  return result.results.length;
}

export async function recordStripeProcessingFee(
  env: ApiEnvironment,
  charge: Stripe.Charge,
  processingFeeCents: number
): Promise<void> {
  const intentId = paymentIntentId(charge.payment_intent);
  if (!intentId) return;
  const order = await env.DB.prepare(
    "SELECT id FROM orders WHERE stripe_payment_intent_id = ?"
  ).bind(intentId).first<{ id: string }>();
  if (!order) return;
  await ensureCreatorEarningForOrder(env, order.id);
  await env.DB.prepare(
    "UPDATE creator_earnings SET processing_fee_cents = ?, updated_at = ? WHERE order_id = ?"
  ).bind(Math.max(0, processingFeeCents), new Date().toISOString(), order.id).run();
  await refreshPayable(env, order.id);
}

export async function recordStripeRefund(env: ApiEnvironment, charge: Stripe.Charge): Promise<void> {
  const intentId = paymentIntentId(charge.payment_intent);
  if (!intentId) return;
  const order = await env.DB.prepare(
    "SELECT id, amount_cents, currency, course_offering_id FROM orders WHERE stripe_payment_intent_id = ?"
  ).bind(intentId).first<{ id: string; amount_cents: number; currency: string; course_offering_id: string | null }>();
  if (!order) return;
  await ensureCreatorEarningForOrder(env, order.id);
  const refunded = Math.min(Number(order.amount_cents), Number(charge.amount_refunded ?? 0));
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO payment_transactions
        (id, order_id, provider, provider_transaction_id, transaction_type,
         amount_cents, currency, status, metadata_json, occurred_at, created_at)
       VALUES (?, ?, 'stripe', ?, 'refund', ?, ?, 'succeeded', '{}', ?, ?)
       ON CONFLICT(provider, provider_transaction_id, transaction_type)
       DO UPDATE SET amount_cents = excluded.amount_cents, status = excluded.status,
         occurred_at = excluded.occurred_at`
    ).bind(crypto.randomUUID(), order.id, charge.id, refunded, order.currency, now, now),
    env.DB.prepare(
      `UPDATE creator_earnings SET refund_cents = ?,
       status = CASE WHEN status IN ('transferred', 'paid') THEN 'reversal_required' ELSE status END,
       updated_at = ? WHERE order_id = ?`
    ).bind(refunded, now, order.id),
    env.DB.prepare(
      "UPDATE orders SET status = CASE WHEN ? >= amount_cents THEN 'refunded' ELSE status END, updated_at = ? WHERE id = ?"
    ).bind(refunded, now, order.id),
    env.DB.prepare(
      `INSERT OR IGNORE INTO payment_lifecycle_events
        (id, order_id, event_type, status, title, detail, provider_event_id,
         metadata_json, occurred_at, created_at)
       VALUES (?, ?, 'refund_recorded', 'succeeded', 'Refund recorded',
         'A refund was recorded for this payment.', ?, ?, ?, ?)`
    ).bind(
      `refund-recorded-${charge.id}`, order.id, charge.id,
      JSON.stringify({ amountCents: refunded, currency: order.currency }), now, now
    )
  ]);
  await refreshPayable(env, order.id);
  if (order.course_offering_id) await reconcileOffering(env, order.course_offering_id, false);
}

export async function recordStripeDispute(
  env: ApiEnvironment,
  dispute: Stripe.Dispute,
  closed: boolean
): Promise<void> {
  const intentId = paymentIntentId(dispute.payment_intent);
  if (!intentId) return;
  const order = await env.DB.prepare(
    "SELECT id, amount_cents, currency, course_offering_id FROM orders WHERE stripe_payment_intent_id = ?"
  ).bind(intentId).first<{ id: string; amount_cents: number; currency: string; course_offering_id: string | null }>();
  if (!order) return;
  await ensureCreatorEarningForOrder(env, order.id);
  const won = closed && dispute.status === "won";
  const lost = closed && dispute.status === "lost";
  const caseStatus = won ? "resolved" : lost ? "refunded" : "open";
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO learner_payment_cases
        (id, order_id, case_type, status, amount_cents, reason, provider_case_id,
         opened_at, resolved_at, updated_at)
       VALUES (?, ?, 'payment_dispute', ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(provider_case_id) DO UPDATE SET status = excluded.status,
         amount_cents = excluded.amount_cents, resolved_at = excluded.resolved_at,
         updated_at = excluded.updated_at`
    ).bind(
      crypto.randomUUID(),
      order.id,
      caseStatus,
      dispute.amount,
      dispute.reason || "Payment disputed with card issuer",
      dispute.id,
      now,
      closed ? now : null,
      now
    ),
    env.DB.prepare(
      `INSERT INTO payment_transactions
        (id, order_id, provider, provider_transaction_id, transaction_type,
         amount_cents, currency, status, metadata_json, occurred_at, created_at)
       VALUES (?, ?, 'stripe', ?, 'dispute', ?, ?, ?, ?, ?, ?)
       ON CONFLICT(provider, provider_transaction_id, transaction_type)
       DO UPDATE SET status = excluded.status, metadata_json = excluded.metadata_json,
         occurred_at = excluded.occurred_at`
    ).bind(
      crypto.randomUUID(),
      order.id,
      dispute.id,
      dispute.amount,
      order.currency,
      dispute.status,
      JSON.stringify({ reason: dispute.reason }),
      now,
      now
    ),
    env.DB.prepare(
      `UPDATE creator_earnings SET
       dispute_hold_cents = ?,
       refund_cents = CASE WHEN ? = 1 THEN MAX(refund_cents, ?) ELSE refund_cents END,
       status = CASE
         WHEN ? = 1 AND status IN ('transferred', 'paid') THEN 'reversal_required'
         WHEN ? = 1 THEN 'held'
         WHEN status = 'held' THEN 'pending_course'
         ELSE status END,
       updated_at = ? WHERE order_id = ?`
    ).bind(
      closed ? 0 : dispute.amount,
      lost ? 1 : 0,
      dispute.amount,
      lost ? 1 : 0,
      closed ? 0 : 1,
      now,
      order.id
    ),
    env.DB.prepare(
      `INSERT OR IGNORE INTO payment_lifecycle_events
        (id, order_id, event_type, status, title, detail, provider_event_id,
         metadata_json, occurred_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      `dispute-${closed ? "resolved" : "opened"}-${dispute.id}`,
      order.id,
      closed ? "dispute_resolved" : "dispute_opened",
      caseStatus,
      closed ? "Payment dispute resolved" : "Payment dispute opened",
      closed ? "The card-provider dispute has been resolved." : "The payment is on hold while the dispute is reviewed.",
      dispute.id,
      JSON.stringify({ amountCents: dispute.amount, currency: order.currency, outcome: dispute.status }),
      now,
      now
    )
  ]);
  await refreshPayable(env, order.id);
  if (order.course_offering_id) await reconcileOffering(env, order.course_offering_id, false);
}

async function recordMeetingUsage(request: Request, env: ApiEnvironment): Promise<Response> {
  if (!internalRequestAuthorized(request, env)) {
    return problem(401, "invalid_usage_signature", "A valid meeting usage credential is required.");
  }
  let input: Record<string, unknown>;
  try {
    input = await request.json<Record<string, unknown>>();
  } catch {
    return problem(400, "invalid_json", "A JSON body is required.");
  }
  const sessionId = typeof input.sessionId === "string" ? input.sessionId.trim() : "";
  const provider = typeof input.provider === "string" ? input.provider.trim().toLowerCase().slice(0, 50) : "";
  const providerEventId = typeof input.providerEventId === "string" ? input.providerEventId.trim().slice(0, 200) : "";
  const participantMinutes = Number(input.participantMinutes);
  if (!sessionId || !provider || !providerEventId || !Number.isInteger(participantMinutes)
    || participantMinutes < 0 || participantMinutes > 100_000_000) {
    return problem(400, "invalid_meeting_usage", "Session, provider event and participant minutes are required.");
  }
  const session = await env.DB.prepare(
    `SELECT s.id, s.course_offering_id FROM course_sessions s
     WHERE s.id = ? AND s.delivery_mode = 'live_online'`
  ).bind(sessionId).first<{ id: string; course_offering_id: string }>();
  if (!session) return problem(404, "session_not_found", "The online session does not exist.");
  await ensurePolicyForOffering(env, session.course_offering_id);
  const policy = await env.DB.prepare(
    "SELECT meeting_rate_micros FROM offering_settlement_policies WHERE course_offering_id = ?"
  ).bind(session.course_offering_id).first<{ meeting_rate_micros: number }>();
  const rateMicros = Number(policy?.meeting_rate_micros ?? configuredInteger(
    env.PLATFORM_MEETING_RATE_MICROS, 4000, 0, 1_000_000
  ));
  const amountCents = Math.ceil(participantMinutes * rateMicros / 10_000);
  const now = new Date().toISOString();
  const observedAt = typeof input.observedAt === "string" && !Number.isNaN(Date.parse(input.observedAt))
    ? new Date(input.observedAt).toISOString()
    : now;
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO meeting_usage_records
        (id, course_session_id, course_offering_id, provider, provider_event_id,
         participant_minutes, rate_micros, amount_cents, status, observed_at,
         finalized_at, metadata_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'finalized', ?, ?, ?, ?, ?)
       ON CONFLICT(provider, provider_event_id) DO UPDATE SET
         participant_minutes = excluded.participant_minutes,
         rate_micros = excluded.rate_micros, amount_cents = excluded.amount_cents,
         status = 'finalized', observed_at = excluded.observed_at,
         finalized_at = excluded.finalized_at, metadata_json = excluded.metadata_json,
         updated_at = excluded.updated_at`
    ).bind(
      crypto.randomUUID(),
      sessionId,
      session.course_offering_id,
      provider,
      providerEventId,
      participantMinutes,
      rateMicros,
      amountCents,
      observedAt,
      now,
      JSON.stringify(input.metadata ?? {}),
      now,
      now
    ),
    env.DB.prepare(
      `INSERT INTO audit_logs
        (id, actor_user_id, action, entity_type, entity_id, metadata_json, created_at)
       VALUES (?, NULL, 'meeting.usage_finalized', 'course_session', ?, ?, ?)`
    ).bind(
      crypto.randomUUID(),
      sessionId,
      JSON.stringify({ provider, providerEventId, participantMinutes, amountCents }),
      now
    )
  ]);
  await reconcileOffering(env, session.course_offering_id, false);
  return json({ usage: { sessionId, provider, providerEventId, participantMinutes, amountCents } }, { status: 201 });
}

async function openLearnerIssue(
  request: Request,
  env: ApiEnvironment,
  orderId: string
): Promise<Response> {
  const actor = await getCreatorActorById(actorId(request), env.DB);
  if (!actor) return problem(401, "authentication_required", "Sign in to report a payment issue.");
  const order = await env.DB.prepare(
    "SELECT id, amount_cents, course_offering_id FROM orders WHERE id = ? AND (student_user_id = ? OR parent_user_id = ?)"
  ).bind(orderId, actor.id, actor.id).first<{ id: string; amount_cents: number; course_offering_id: string | null }>();
  if (!order) return problem(404, "order_not_found", "This payment could not be found.");
  const existing = await env.DB.prepare(
    `SELECT id FROM learner_payment_cases
     WHERE order_id = ? AND status IN ('open', 'reviewing')`
  ).bind(orderId).first();
  if (existing) return problem(409, "issue_already_open", "An issue is already being reviewed for this payment.");
  let input: { reason?: unknown; caseType?: unknown };
  try {
    input = await request.json();
  } catch {
    return problem(400, "invalid_json", "A JSON body is required.");
  }
  const reason = typeof input.reason === "string" ? input.reason.trim().slice(0, 2000) : "";
  const caseType = input.caseType === "refund_request" ? "refund_request" : "service_issue";
  if (reason.length < 10) {
    return problem(400, "reason_required", "Describe the issue in at least 10 characters.");
  }
  const caseId = crypto.randomUUID();
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO learner_payment_cases
        (id, order_id, opened_by_user_id, case_type, status, amount_cents,
         reason, opened_at, updated_at)
       VALUES (?, ?, ?, ?, 'open', ?, ?, ?, ?)`
    ).bind(caseId, orderId, actor.id, caseType, order.amount_cents, reason, now, now),
    env.DB.prepare(
      `UPDATE creator_earnings SET status = CASE
         WHEN status IN ('transferred', 'paid') THEN 'reversal_required' ELSE 'held' END,
       updated_at = ? WHERE order_id = ?`
    ).bind(now, orderId),
    env.DB.prepare(
      `INSERT INTO audit_logs
        (id, actor_user_id, action, entity_type, entity_id, metadata_json, created_at)
       VALUES (?, ?, 'payment.issue_opened', 'order', ?, ?, ?)`
    ).bind(crypto.randomUUID(), actor.id, orderId, JSON.stringify({ caseId, caseType }), now),
    env.DB.prepare(
      `INSERT OR IGNORE INTO payment_lifecycle_events
        (id, order_id, event_type, status, title, detail, actor_user_id,
         provider_event_id, metadata_json, occurred_at, created_at)
       VALUES (?, ?, 'issue_opened', 'open', 'Issue reported',
         'This payment is on hold while the issue is reviewed.', ?, ?, ?, ?, ?)`
    ).bind(
      `issue-opened-${caseId}`, orderId, actor.id, caseId,
      JSON.stringify({ caseType }), now, now
    )
  ]);
  return json({ paymentCase: { id: caseId, orderId, caseType, status: "open" } }, { status: 201 });
}

export async function handleSettlementRequest(
  request: Request,
  env: ApiEnvironment,
  pathname: string
): Promise<Response | null> {
  if (request.method === "POST" && pathname === "/api/internal/meeting-usage") {
    return recordMeetingUsage(request, env);
  }
  if (request.method === "POST" && pathname === "/api/internal/settlements/reconcile") {
    if (!internalRequestAuthorized(request, env)) {
      return problem(401, "invalid_settlement_signature", "A valid settlement credential is required.");
    }
    const offerings = await reconcileCreatorSettlements(env);
    return json({ reconciled: true, offerings });
  }
  const issue = pathname.match(/^\/api\/payments\/([^/]+)\/issues$/);
  if (request.method === "POST" && issue) {
    return openLearnerIssue(request, env, decodeURIComponent(issue[1]));
  }
  return null;
}
