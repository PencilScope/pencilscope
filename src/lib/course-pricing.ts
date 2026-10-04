import type Stripe from "stripe";
import { createStripe } from "@/lib/stripe";

export type CoursePricingRecord = {
  id: string;
  title: string;
  description: string;
  price_cents: number;
  currency: string;
  pricing_version: number;
  stripe_product_id: string | null;
  stripe_price_id: string | null;
};

export type SyncedCoursePricing = {
  stripeProductId: string;
  stripePriceId: string;
  previousStripePriceId: string | null;
};

export async function syncCoursePricing(
  stripeSecret: string,
  course: CoursePricingRecord
): Promise<SyncedCoursePricing> {
  if (!Number.isSafeInteger(course.price_cents) || course.price_cents < 50) {
    throw new Error("A purchasable course must cost at least 50 cents");
  }

  const stripe = createStripe(stripeSecret);
  const metadata = { courseId: course.id };

  const product = course.stripe_product_id
    ? await stripe.products.update(course.stripe_product_id, {
        name: course.title,
        description: course.description,
        active: true,
        metadata
      })
    : await stripe.products.create(
        {
          name: course.title,
          description: course.description,
          active: true,
          metadata
        },
        { idempotencyKey: `course:${course.id}:product` }
      );

  const lookupKey = `course_${course.id.replace(/[^a-zA-Z0-9_]/g, "_")}_current`;
  const price = await stripe.prices.create(
    {
      product: product.id,
      currency: course.currency.toLowerCase(),
      unit_amount: course.price_cents,
      lookup_key: lookupKey,
      transfer_lookup_key: true,
      nickname: `${course.title} v${course.pricing_version}`,
      metadata: {
        ...metadata,
        pricingVersion: String(course.pricing_version)
      }
    },
    { idempotencyKey: `course:${course.id}:price:v${course.pricing_version}` }
  );

  await stripe.products.update(product.id, { default_price: price.id });

  return {
    stripeProductId: product.id,
    stripePriceId: price.id,
    previousStripePriceId: course.stripe_price_id
  };
}

export async function persistSyncedCoursePricing(
  db: D1Database,
  course: CoursePricingRecord,
  pricing: SyncedCoursePricing,
  publish: boolean
): Promise<void> {
  const now = new Date().toISOString();
  const statusSql = publish
    ? ", status = 'published', published_at = COALESCE(published_at, ?)"
    : "";

  const updateBindings: unknown[] = [
    pricing.stripeProductId,
    pricing.stripePriceId,
    course.price_cents,
    course.currency,
    course.pricing_version,
    now
  ];
  if (publish) updateBindings.push(now);
  updateBindings.push(course.id);

  await db.batch([
    db.prepare(
      `UPDATE course_prices SET active = 0 WHERE course_id = ? AND active = 1`
    ).bind(course.id),
    db.prepare(
      `INSERT INTO course_prices
        (id, course_id, stripe_price_id, amount_cents, currency, billing_type,
         billing_interval, pricing_version, active, created_at)
       VALUES (?, ?, ?, ?, ?, 'one_time', NULL, ?, 1, ?)
       ON CONFLICT(course_id, pricing_version) DO UPDATE SET
         stripe_price_id = excluded.stripe_price_id,
         amount_cents = excluded.amount_cents,
         currency = excluded.currency,
         active = 1`
    ).bind(
      crypto.randomUUID(),
      course.id,
      pricing.stripePriceId,
      course.price_cents,
      course.currency,
      course.pricing_version,
      now
    ),
    db.prepare(
      `UPDATE courses SET stripe_product_id = ?, stripe_price_id = ?,
       price_cents = ?, currency = ?, pricing_version = ?,
       pricing_status = 'ready', updated_at = ?${statusSql} WHERE id = ?`
    ).bind(...updateBindings)
  ]);
}

export async function archivePreviousStripePrice(
  stripeSecret: string,
  pricing: SyncedCoursePricing
): Promise<void> {
  if (!pricing.previousStripePriceId || pricing.previousStripePriceId === pricing.stripePriceId) return;
  const stripe = createStripe(stripeSecret);
  await stripe.prices.update(pricing.previousStripePriceId, { active: false });
}

export function isStripeResourceMissing(error: unknown): boolean {
  return Boolean(
    error && typeof error === "object" && "code" in error &&
    (error as Stripe.errors.StripeError).code === "resource_missing"
  );
}
