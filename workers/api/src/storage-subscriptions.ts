import type Stripe from "stripe";
import { json, problem } from "../../../src/lib/http";
import { createStripe } from "../../../src/lib/stripe";
import type { ApiEnvironment } from "./index";

export const INCLUDED_STORAGE_BYTES = 5_000_000_000;
export const STORAGE_BLOCK_BYTES = 10_000_000_000;
export const STORAGE_BLOCK_PRICE_CENTS = 500;
export const STORAGE_CURRENCY = "sgd";
const MAX_STORAGE_BLOCKS = 20;
const PLAN_KEY = "storage-plus-10gb-v1";

type StorageActor = { id: string; email: string; display_name: string };
type StoredSubscription = {
  user_id: string;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  stripe_subscription_item_id: string | null;
  additional_blocks: number;
  status: string;
  current_period_end: string | null;
  cancel_at_period_end: number;
  grace_ends_at: string | null;
};

const actorId = (request: Request) => request.headers.get("x-pencilscope-user-id")?.trim() || null;
async function activeActor(request: Request, env: ApiEnvironment): Promise<StorageActor | null> {
  const id = actorId(request);
  if (!id) return null;
  return env.DB.prepare(
    "SELECT id, email, display_name FROM users WHERE id = ? AND status = 'active'"
  ).bind(id).first<StorageActor>();
}

const isoFromUnix = (value?: number | null) => value ? new Date(value * 1000).toISOString() : null;
const stripeId = (value: string | { id: string } | null | undefined) =>
  typeof value === "string" ? value : value?.id ?? null;

function mappedStatus(status: Stripe.Subscription.Status): StoredSubscription["status"] {
  if (["trialing", "active", "past_due", "unpaid", "paused", "canceled", "incomplete"].includes(status)) return status;
  return status === "incomplete_expired" ? "canceled" : "incomplete";
}

function periodEnd(subscription: Stripe.Subscription): string | null {
  const itemEnds = subscription.items.data
    .map((item) => item.current_period_end)
    .filter((value): value is number => typeof value === "number");
  return isoFromUnix(itemEnds.length ? Math.max(...itemEnds) : null);
}

export async function storageUsage(env: ApiEnvironment, userId: string) {
  const [usage, subscription] = await Promise.all([
    env.DB.prepare(
      `SELECT COALESCE(SUM(size_bytes), 0) AS storage_bytes
       FROM r2_asset_objects
       WHERE owner_user_id = ? AND bucket_binding = 'MEDIA' AND purged_at IS NULL`
    ).bind(userId).first<{ storage_bytes: number }>(),
    env.DB.prepare("SELECT * FROM creator_storage_subscriptions WHERE user_id = ?")
      .bind(userId).first<StoredSubscription>()
  ]);
  const now = Date.now();
  const status = subscription?.status ?? "none";
  const graceActive = Boolean(subscription?.grace_ends_at && Date.parse(subscription.grace_ends_at) > now);
  const paidCapacityActive = ["active", "trialing"].includes(status) || (["past_due", "unpaid"].includes(status) && graceActive);
  const additionalBlocks = paidCapacityActive ? Number(subscription?.additional_blocks ?? 0) : 0;
  const usedBytes = Number(usage?.storage_bytes ?? 0);
  const quotaBytes = INCLUDED_STORAGE_BYTES + additionalBlocks * STORAGE_BLOCK_BYTES;
  return {
    usedBytes,
    includedBytes: INCLUDED_STORAGE_BYTES,
    blockBytes: STORAGE_BLOCK_BYTES,
    quotaBytes,
    remainingBytes: Math.max(0, quotaBytes - usedBytes),
    usagePercent: quotaBytes ? Math.min(100, Math.round((usedBytes / quotaBytes) * 1000) / 10) : 100,
    additionalBlocks,
    pricePerBlockCents: STORAGE_BLOCK_PRICE_CENTS,
    currency: STORAGE_CURRENCY.toUpperCase(),
    subscriptionStatus: status,
    currentPeriodEnd: subscription?.current_period_end ?? null,
    cancelAtPeriodEnd: Boolean(subscription?.cancel_at_period_end),
    graceEndsAt: subscription?.grace_ends_at ?? null,
    canUpload: usedBytes < quotaBytes
  };
}

export async function reserveStorage(
  env: ApiEnvironment,
  userId: string,
  sizeBytes: number,
  ttlMilliseconds = 15 * 60_000
): Promise<{ id: string; quotaBytes: number; usedBytes: number } | null> {
  const usage = await storageUsage(env, userId);
  const id = crypto.randomUUID();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + ttlMilliseconds).toISOString();
  await env.DB.prepare("DELETE FROM creator_storage_upload_reservations WHERE expires_at <= ?")
    .bind(now.toISOString()).run();
  const inserted = await env.DB.prepare(
    `INSERT INTO creator_storage_upload_reservations (id, user_id, size_bytes, expires_at, created_at)
     SELECT ?, ?, ?, ?, ?
     WHERE (
       COALESCE((SELECT SUM(o.size_bytes) FROM r2_asset_objects o
         WHERE o.owner_user_id = ? AND o.bucket_binding = 'MEDIA' AND o.purged_at IS NULL), 0)
       + COALESCE((SELECT SUM(r.size_bytes) FROM creator_storage_upload_reservations r
         WHERE r.user_id = ? AND r.expires_at > ?), 0)
       + ?
     ) <= ?`
  ).bind(id, userId, sizeBytes, expiresAt, now.toISOString(), userId, userId, now.toISOString(), sizeBytes, usage.quotaBytes).run();
  return inserted.meta.changes ? { id, quotaBytes: usage.quotaBytes, usedBytes: usage.usedBytes } : null;
}

export async function releaseStorageReservation(env: ApiEnvironment, id: string): Promise<void> {
  await env.DB.prepare("DELETE FROM creator_storage_upload_reservations WHERE id = ?").bind(id).run();
}

function matchesStoragePlan(price: Stripe.Price): boolean {
  return price.active
    && price.currency === STORAGE_CURRENCY
    && price.unit_amount === STORAGE_BLOCK_PRICE_CENTS
    && price.recurring?.interval === "month"
    && price.metadata.pencilScopePlan === PLAN_KEY
    && price.metadata.storageBytes === String(STORAGE_BLOCK_BYTES);
}

async function recordStoragePlan(env: ApiEnvironment, price: Stripe.Price): Promise<void> {
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO creator_storage_billing_config
      (plan_key, stripe_product_id, stripe_price_id, block_bytes, unit_amount_cents, currency, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(plan_key) DO UPDATE SET stripe_product_id = excluded.stripe_product_id,
       stripe_price_id = excluded.stripe_price_id, block_bytes = excluded.block_bytes,
       unit_amount_cents = excluded.unit_amount_cents, currency = excluded.currency,
       updated_at = excluded.updated_at`
  ).bind(PLAN_KEY, stripeId(price.product), price.id, STORAGE_BLOCK_BYTES, STORAGE_BLOCK_PRICE_CENTS,
    STORAGE_CURRENCY.toUpperCase(), now, now).run();
}

async function ensureStripePlan(env: ApiEnvironment, stripe: Stripe): Promise<string> {
  const configured = env.STRIPE_STORAGE_PRICE_ID?.trim();
  if (configured) {
    const price = await stripe.prices.retrieve(configured);
    if (!matchesStoragePlan(price)) {
      throw new Error(`STRIPE_STORAGE_PRICE_ID must reference the immutable ${PLAN_KEY} price`);
    }
    await recordStoragePlan(env, price);
    return configured;
  }
  const existing = await env.DB.prepare(
    "SELECT stripe_price_id FROM creator_storage_billing_config WHERE plan_key = ?"
  ).bind(PLAN_KEY).first<{ stripe_price_id: string | null }>();
  if (existing?.stripe_price_id) {
    const price = await stripe.prices.retrieve(existing.stripe_price_id);
    if (!matchesStoragePlan(price)) throw new Error(`Stored ${PLAN_KEY} Stripe price is invalid`);
    return existing.stripe_price_id;
  }
  const product = await stripe.products.create({
    name: "PencilScope Storage Plus — 10 GB",
    description: "An additional 10 GB of private Content Library storage per monthly unit.",
    metadata: { pencilScopePlan: PLAN_KEY, storageBytes: String(STORAGE_BLOCK_BYTES) }
  });
  const price = await stripe.prices.create({
    product: product.id,
    currency: STORAGE_CURRENCY,
    unit_amount: STORAGE_BLOCK_PRICE_CENTS,
    recurring: { interval: "month" },
    metadata: { pencilScopePlan: PLAN_KEY, storageBytes: String(STORAGE_BLOCK_BYTES) }
  });
  await recordStoragePlan(env, price);
  return price.id;
}

async function checkout(request: Request, env: ApiEnvironment, user: StorageActor): Promise<Response> {
  let input: { blocks?: unknown } = {};
  try { input = await request.json(); } catch { /* use one block */ }
  const blocks = Math.trunc(Number(input.blocks ?? 1));
  if (!Number.isFinite(blocks) || blocks < 1 || blocks > MAX_STORAGE_BLOCKS) {
    return problem(400, "invalid_storage_blocks", `Choose between 1 and ${MAX_STORAGE_BLOCKS} additional storage blocks.`);
  }
  if (!env.STRIPE_SECRET_KEY) return problem(503, "billing_unavailable", "Storage billing is not configured yet.");
  const current = await env.DB.prepare("SELECT * FROM creator_storage_subscriptions WHERE user_id = ?")
    .bind(user.id).first<StoredSubscription>();
  if (current?.stripe_subscription_id && ["active", "trialing", "past_due"].includes(current.status)) {
    if (blocks <= Number(current.additional_blocks)) {
      return problem(409, "storage_plan_not_an_upgrade", "Use Manage billing to reduce or cancel your storage plan.");
    }
    try {
      const stripe = createStripe(env.STRIPE_SECRET_KEY);
      const priceId = await ensureStripePlan(env, stripe);
      const itemId = current.stripe_subscription_item_id || (await stripe.subscriptions.retrieve(current.stripe_subscription_id)).items.data[0]?.id;
      if (!itemId) return problem(409, "storage_subscription_incomplete", "Open Manage billing to review this storage subscription.");
      await stripe.subscriptionItems.update(itemId, { price: priceId, quantity: blocks, proration_behavior: "always_invoice" });
      await syncStorageSubscription(env, await stripe.subscriptions.retrieve(current.stripe_subscription_id));
      return json({ updated: true, blocks, redirectUrl: `${env.APP_URL}/content-library?storage=updated` });
    } catch (error) {
      console.error("storage.subscription.upgrade_failed", { userId: user.id, error });
      return problem(502, "storage_upgrade_failed", "The storage upgrade could not be completed. Try again shortly.");
    }
  }
  try {
    const stripe = createStripe(env.STRIPE_SECRET_KEY);
    const priceId = await ensureStripePlan(env, stripe);
    const customerId = current?.stripe_customer_id || (await stripe.customers.create({
      email: user.email,
      name: user.display_name,
      metadata: { pencilScopeUserId: user.id }
    })).id;
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer: customerId,
      line_items: [{ price: priceId, quantity: blocks, adjustable_quantity: { enabled: true, minimum: 1, maximum: MAX_STORAGE_BLOCKS } }],
      success_url: `${env.APP_URL}/content-library?storage=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${env.APP_URL}/content-library?storage=cancelled`,
      metadata: { kind: "creator_storage", userId: user.id },
      subscription_data: { metadata: { kind: "creator_storage", userId: user.id } }
    });
    const now = new Date().toISOString();
    await env.DB.prepare(
      `INSERT INTO creator_storage_subscriptions
        (user_id, stripe_customer_id, additional_blocks, status, created_at, updated_at)
       VALUES (?, ?, 0, 'checkout_pending', ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET stripe_customer_id = excluded.stripe_customer_id,
         status = CASE WHEN creator_storage_subscriptions.status IN ('active','trialing','past_due')
           THEN creator_storage_subscriptions.status ELSE 'checkout_pending' END,
         updated_at = excluded.updated_at`
    ).bind(user.id, customerId, now, now).run();
    return json({ checkoutUrl: session.url });
  } catch (error) {
    console.error("storage.checkout.failed", { userId: user.id, error });
    return problem(502, "storage_checkout_failed", "Storage checkout is temporarily unavailable.");
  }
}

async function portal(env: ApiEnvironment, user: StorageActor): Promise<Response> {
  if (!env.STRIPE_SECRET_KEY) return problem(503, "billing_unavailable", "Storage billing is not configured yet.");
  const record = await env.DB.prepare(
    "SELECT stripe_customer_id FROM creator_storage_subscriptions WHERE user_id = ?"
  ).bind(user.id).first<{ stripe_customer_id: string | null }>();
  if (!record?.stripe_customer_id) return problem(409, "storage_subscription_missing", "Subscribe to Storage Plus before managing billing.");
  try {
    const stripe = createStripe(env.STRIPE_SECRET_KEY);
    const session = await stripe.billingPortal.sessions.create({
      customer: record.stripe_customer_id,
      return_url: `${env.APP_URL}/content-library`
    });
    return json({ portalUrl: session.url });
  } catch (error) {
    console.error("storage.portal.failed", { userId: user.id, error });
    return problem(502, "storage_portal_failed", "The billing portal is temporarily unavailable.");
  }
}

export async function handleStorageSubscriptionRequest(request: Request, env: ApiEnvironment, pathname: string): Promise<Response | null> {
  if (!pathname.startsWith("/api/creator/storage")) return null;
  const user = await activeActor(request, env);
  if (!user) return problem(401, "authentication_required", "Sign in to manage Content Library storage.");
  if (pathname === "/api/creator/storage" && request.method === "GET") return json({ storage: await storageUsage(env, user.id) });
  if (pathname === "/api/creator/storage/checkout" && request.method === "POST") return checkout(request, env, user);
  if (pathname === "/api/creator/storage/portal" && request.method === "POST") return portal(env, user);
  return problem(404, "storage_route_not_found", "Storage billing route not found.");
}

export async function syncStorageSubscription(env: ApiEnvironment, subscription: Stripe.Subscription, stripeEventId?: string): Promise<void> {
  const userId = subscription.metadata.userId?.trim();
  if (!userId || subscription.metadata.kind !== "creator_storage") return;
  const item = subscription.items.data[0];
  const nextBlocks = Math.max(0, Math.min(MAX_STORAGE_BLOCKS, Number(item?.quantity ?? 0)));
  const previous = await env.DB.prepare(
    "SELECT additional_blocks, status FROM creator_storage_subscriptions WHERE user_id = ?"
  ).bind(userId).first<{ additional_blocks: number; status: string }>();
  const status = mappedStatus(subscription.status);
  const now = new Date().toISOString();
  const graceEndsAt = ["past_due", "unpaid"].includes(status) ? new Date(Date.now() + 30 * 86_400_000).toISOString() : null;
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO creator_storage_subscriptions
        (user_id, stripe_customer_id, stripe_subscription_id, stripe_subscription_item_id,
         additional_blocks, status, current_period_end, cancel_at_period_end, grace_ends_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET stripe_customer_id = excluded.stripe_customer_id,
         stripe_subscription_id = excluded.stripe_subscription_id,
         stripe_subscription_item_id = excluded.stripe_subscription_item_id,
         additional_blocks = excluded.additional_blocks, status = excluded.status,
         current_period_end = excluded.current_period_end,
         cancel_at_period_end = excluded.cancel_at_period_end,
         grace_ends_at = CASE
           WHEN excluded.status IN ('active','trialing') THEN NULL
           WHEN creator_storage_subscriptions.grace_ends_at IS NOT NULL THEN creator_storage_subscriptions.grace_ends_at
           ELSE excluded.grace_ends_at END,
         updated_at = excluded.updated_at`
    ).bind(userId, stripeId(subscription.customer), subscription.id, item?.id ?? null, nextBlocks, status,
      periodEnd(subscription), subscription.cancel_at_period_end ? 1 : 0, graceEndsAt, now, now),
    env.DB.prepare(
      `INSERT INTO creator_storage_subscription_events
        (id, user_id, event_type, previous_blocks, next_blocks, status, stripe_event_id, metadata_json, created_at)
       VALUES (?, ?, 'subscription.synced', ?, ?, ?, ?, ?, ?)`
    ).bind(crypto.randomUUID(), userId, Number(previous?.additional_blocks ?? 0), nextBlocks, status,
      stripeEventId ?? null, JSON.stringify({ previousStatus: previous?.status ?? "none", cancelAtPeriodEnd: subscription.cancel_at_period_end }), now)
  ]);
}

export async function processStorageCheckout(env: ApiEnvironment, stripe: Stripe, session: Stripe.Checkout.Session, eventId?: string): Promise<boolean> {
  if (session.metadata?.kind !== "creator_storage") return false;
  const subscriptionId = stripeId(session.subscription);
  if (!subscriptionId) throw new Error("Storage checkout is missing its subscription");
  await syncStorageSubscription(env, await stripe.subscriptions.retrieve(subscriptionId), eventId);
  return true;
}
