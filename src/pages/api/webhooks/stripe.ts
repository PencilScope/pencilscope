import type { APIRoute } from "astro";
import type Stripe from "stripe";
import { json, problem } from "@/lib/http";
import { getEnv, requireSecret } from "@/lib/runtime";
import { constructStripeEvent, createStripe } from "@/lib/stripe";

async function recordCompletedCheckout(db: D1Database, session: Stripe.Checkout.Session): Promise<void> {
  const courseId = session.metadata?.courseId;
  if (!courseId) throw new Error("Checkout session is missing courseId metadata");
  const now = new Date().toISOString();
  await db.prepare(
    `INSERT INTO orders (id, parent_user_id, student_user_id, course_id, stripe_checkout_session_id,
      stripe_payment_intent_id, stripe_price_id, amount_cents, currency, status, created_at, updated_at)
    VALUES (?, NULL, NULL, ?, ?, ?, ?, ?, ?, 'paid', ?, ?)
    ON CONFLICT(stripe_checkout_session_id) DO UPDATE SET
      stripe_payment_intent_id = excluded.stripe_payment_intent_id,
      stripe_price_id = excluded.stripe_price_id,
      amount_cents = excluded.amount_cents, currency = excluded.currency,
      status = 'paid', updated_at = excluded.updated_at`
  ).bind(
    crypto.randomUUID(), courseId, session.id,
    typeof session.payment_intent === "string" ? session.payment_intent : null,
    session.metadata?.stripePriceId ?? null,
    session.amount_total ?? 0, (session.currency ?? "sgd").toUpperCase(), now, now
  ).run();
}

export const POST: APIRoute = async ({ request, locals }) => {
  const env = getEnv(locals);
  const signature = request.headers.get("stripe-signature");
  if (!signature) return problem(400, "missing_signature", "Missing Stripe signature.");

  let event: Stripe.Event;
  try {
    const payload = await request.text();
    const stripe = createStripe(requireSecret(env, "STRIPE_SECRET_KEY"));
    event = await constructStripeEvent(stripe, payload, signature, requireSecret(env, "STRIPE_WEBHOOK_SECRET"));
  } catch (error) {
    console.warn("stripe.webhook.invalid", { error });
    return problem(400, "invalid_signature", "Invalid webhook signature.");
  }

  const claimed = await env.DB.prepare(
    `INSERT INTO webhook_events (provider, event_id, event_type, status, received_at)
     VALUES ('stripe', ?, ?, 'processing', ?)
     ON CONFLICT(provider, event_id) DO NOTHING`
  ).bind(event.id, event.type, new Date().toISOString()).run();
  if (!claimed.meta.changes) return json({ received: true, duplicate: true });

  try {
    if (event.type === "checkout.session.completed") await recordCompletedCheckout(env.DB, event.data.object);
    await env.DB.prepare(
      `UPDATE webhook_events SET status = 'processed', processed_at = ? WHERE provider = 'stripe' AND event_id = ?`
    ).bind(new Date().toISOString(), event.id).run();
    return json({ received: true });
  } catch (error) {
    console.error("stripe.webhook.processing_failed", { eventId: event.id, eventType: event.type, error });
    await env.DB.prepare(
      `UPDATE webhook_events SET status = 'failed', error_message = ? WHERE provider = 'stripe' AND event_id = ?`
    ).bind(error instanceof Error ? error.message.slice(0, 500) : "Unknown error", event.id).run();
    return problem(500, "processing_failed", "Webhook processing failed.");
  }
};
