import { getCreatorActorById } from "../../../src/lib/auth";
import { json, problem } from "../../../src/lib/http";
import { createStripe } from "../../../src/lib/stripe";
import type { ApiEnvironment } from "./index";
import { reconcileCreatorSettlements } from "./settlements";

type PayoutAccountRow = {
  stripe_account_id: string | null;
  stripe_details_submitted: number;
  stripe_charges_enabled: number;
  stripe_payouts_enabled: number;
  stripe_account_updated_at: string | null;
  payout_status: "not_configured" | "pending" | "ready" | "restricted";
};

const actorId = (request: Request) => request.headers.get("x-pencilscope-user-id")?.trim() || null;

function publicAccount(row: PayoutAccountRow | null) {
  return {
    connected: Boolean(row?.stripe_account_id),
    detailsSubmitted: Boolean(row?.stripe_details_submitted),
    chargesEnabled: Boolean(row?.stripe_charges_enabled),
    payoutsEnabled: Boolean(row?.stripe_payouts_enabled),
    status: row?.payout_status ?? "not_configured",
    updatedAt: row?.stripe_account_updated_at ?? null
  };
}

async function accountRow(env: ApiEnvironment, userId: string): Promise<PayoutAccountRow | null> {
  return env.DB.prepare(
    `SELECT tp.stripe_account_id, tp.stripe_details_submitted, tp.stripe_charges_enabled,
      tp.stripe_payouts_enabled, tp.stripe_account_updated_at,
      COALESCE(cp.payout_status, 'not_configured') AS payout_status
     FROM tutor_profiles tp LEFT JOIN creator_profiles cp ON cp.user_id = tp.user_id
     WHERE tp.user_id = ?`
  ).bind(userId).first<PayoutAccountRow>();
}

async function syncStripeAccount(env: ApiEnvironment, userId: string, accountId: string): Promise<PayoutAccountRow | null> {
  if (!env.STRIPE_SECRET_KEY) return accountRow(env, userId);
  const stripe = createStripe(env.STRIPE_SECRET_KEY);
  const account = await stripe.accounts.retrieve(accountId);
  const detailsSubmitted = account.details_submitted ? 1 : 0;
  const chargesEnabled = account.charges_enabled ? 1 : 0;
  const payoutsEnabled = account.payouts_enabled ? 1 : 0;
  const status = payoutsEnabled && detailsSubmitted ? "ready"
    : account.requirements?.disabled_reason ? "restricted" : "pending";
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE tutor_profiles SET stripe_details_submitted = ?, stripe_charges_enabled = ?,
        stripe_payouts_enabled = ?, stripe_account_updated_at = ?, updated_at = ? WHERE user_id = ?`
    ).bind(detailsSubmitted, chargesEnabled, payoutsEnabled, now, now, userId),
    env.DB.prepare(
      `INSERT INTO creator_profiles
        (user_id, public_name, biography, verification_status, payout_status, created_at, updated_at)
       SELECT u.id, u.display_name, '', 'unverified', ?, ?, ? FROM users u WHERE u.id = ?
       ON CONFLICT(user_id) DO UPDATE SET payout_status = excluded.payout_status, updated_at = excluded.updated_at`
    ).bind(status, now, now, userId)
  ]);
  return accountRow(env, userId);
}

async function ensureTutorProfile(env: ApiEnvironment, userId: string): Promise<void> {
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT OR IGNORE INTO tutor_profiles
      (user_id, display_name, biography, verification_status, created_at, updated_at)
     SELECT id, display_name, '', 'pending', ?, ? FROM users WHERE id = ?`
  ).bind(now, now, userId).run();
}

export async function payoutAccountSummary(env: ApiEnvironment, userId: string) {
  await ensureTutorProfile(env, userId);
  let row = await accountRow(env, userId);
  if (row?.stripe_account_id && env.STRIPE_SECRET_KEY) {
    try { row = await syncStripeAccount(env, userId, row.stripe_account_id); }
    catch (error) { console.warn("payout.account_sync_failed", { userId, error }); }
  }
  return publicAccount(row);
}

export async function creatorCanReceivePayouts(env: ApiEnvironment, userId: string): Promise<boolean> {
  const account = await payoutAccountSummary(env, userId);
  return account.status === "ready" && account.detailsSubmitted && account.payoutsEnabled;
}

export async function handlePayoutRequest(
  request: Request,
  env: ApiEnvironment,
  pathname: string
): Promise<Response | null> {
  if (!pathname.startsWith("/api/creator/payout")) return null;
  const actor = await getCreatorActorById(actorId(request), env.DB);
  if (!actor) return problem(401, "authentication_required", "Sign in to manage creator payouts.");
  await ensureTutorProfile(env, actor.id);

  if (request.method === "GET" && pathname === "/api/creator/payout-account") {
    let row = await accountRow(env, actor.id);
    if (row?.stripe_account_id && env.STRIPE_SECRET_KEY) {
      try { row = await syncStripeAccount(env, actor.id, row.stripe_account_id); }
      catch (error) { console.warn("payout.account_sync_failed", { userId: actor.id, error }); }
    }
    return json({ payoutAccount: publicAccount(row) });
  }

  if (request.method === "POST" && pathname === "/api/creator/payout-account/onboard") {
    if (!env.STRIPE_SECRET_KEY) {
      return problem(503, "payout_provider_unavailable", "Creator payout setup is not configured yet.");
    }
    const stripe = createStripe(env.STRIPE_SECRET_KEY);
    const user = await env.DB.prepare(
      `SELECT u.email, COALESCE(ap.country_code, 'SG') AS country_code
       FROM users u LEFT JOIN account_profiles ap ON ap.user_id = u.id WHERE u.id = ?`
    ).bind(actor.id).first<{ email: string; country_code: string }>();
    let row = await accountRow(env, actor.id);
    let accountId = row?.stripe_account_id ?? null;
    if (!accountId) {
      const account = await stripe.accounts.create({
        type: "express",
        country: user?.country_code || "SG",
        email: user?.email,
        capabilities: { transfers: { requested: true } },
        business_profile: { product_description: "Learning content and course creator" },
        metadata: { pencilScopeUserId: actor.id }
      }, { idempotencyKey: `creator-connect-${actor.id}` });
      accountId = account.id;
      const now = new Date().toISOString();
      await env.DB.batch([
        env.DB.prepare(
          "UPDATE tutor_profiles SET stripe_account_id = ?, stripe_account_updated_at = ?, updated_at = ? WHERE user_id = ?"
        ).bind(accountId, now, now, actor.id),
        env.DB.prepare(
          "UPDATE creator_profiles SET payout_status = 'pending', updated_at = ? WHERE user_id = ?"
        ).bind(now, actor.id)
      ]);
    }
    const link = await stripe.accountLinks.create({
      account: accountId,
      refresh_url: `${env.APP_URL}/payments?payout=refresh`,
      return_url: `${env.APP_URL}/payments?payout=return`,
      type: "account_onboarding"
    });
    return json({ url: link.url });
  }

  if (request.method === "POST" && pathname === "/api/creator/payout-account/dashboard") {
    if (!env.STRIPE_SECRET_KEY) {
      return problem(503, "payout_provider_unavailable", "Creator payout management is not configured yet.");
    }
    const row = await accountRow(env, actor.id);
    if (!row?.stripe_account_id) return problem(409, "payout_setup_required", "Set up payouts first.");
    const link = await createStripe(env.STRIPE_SECRET_KEY).accounts.createLoginLink(row.stripe_account_id);
    return json({ url: link.url });
  }

  if (request.method === "POST" && pathname === "/api/creator/payouts/release") {
    let row = await accountRow(env, actor.id);
    if (row?.stripe_account_id && env.STRIPE_SECRET_KEY) {
      try { row = await syncStripeAccount(env, actor.id, row.stripe_account_id); }
      catch (error) { console.warn("payout.account_sync_failed", { userId: actor.id, error }); }
    }
    if (!row?.stripe_account_id || !row.stripe_payouts_enabled) {
      await reconcileCreatorSettlements(env, actor.id, true);
      return problem(409, "payout_setup_required", "Complete payout setup before requesting a transfer.");
    }
    const offerings = await reconcileCreatorSettlements(env, actor.id, true);
    return json({ released: true, offerings });
  }

  return problem(405, "method_not_allowed", "Method not allowed.");
}
