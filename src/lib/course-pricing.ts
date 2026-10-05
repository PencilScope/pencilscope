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

export type OfferingPricingRecord = {
  id: string;
  course_id: string;
  course_title: string;
  course_description: string;
  title: string;
  price_cents: number;
  currency: string;
  pricing_version: number;
  stripe_product_id: string | null;
  stripe_price_id: string | null;
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

export async function syncOfferingPricing(
  stripeSecret: string,
  offering: OfferingPricingRecord
): Promise<SyncedCoursePricing> {
  if (!Number.isSafeInteger(offering.price_cents) || offering.price_cents < 50) {
    throw new Error("A purchasable term must cost at least 50 cents");
  }
  const stripe = createStripe(stripeSecret);
  const productMetadata = { courseId: offering.course_id };
  const product = offering.stripe_product_id
    ? await stripe.products.update(offering.stripe_product_id, {
        name: offering.course_title,
        description: offering.course_description,
        active: true,
        metadata: productMetadata
      })
    : await stripe.products.create(
        {
          name: offering.course_title,
          description: offering.course_description,
          active: true,
          metadata: productMetadata
        },
        { idempotencyKey: `course:${offering.course_id}:product` }
      );
  const safeOfferingId = offering.id.replace(/[^a-zA-Z0-9_]/g, "_");
  const price = await stripe.prices.create(
    {
      product: product.id,
      currency: offering.currency.toLowerCase(),
      unit_amount: offering.price_cents,
      lookup_key: `offering_${safeOfferingId}_current`,
      transfer_lookup_key: true,
      nickname: `${offering.course_title} — ${offering.title} v${offering.pricing_version}`,
      metadata: {
        courseId: offering.course_id,
        offeringId: offering.id,
        pricingVersion: String(offering.pricing_version)
      }
    },
    { idempotencyKey: `offering:${offering.id}:price:v${offering.pricing_version}` }
  );
  return {
    stripeProductId: product.id,
    stripePriceId: price.id,
    previousStripePriceId: offering.stripe_price_id
  };
}

export async function persistSyncedOfferingPricing(
  db: D1Database,
  offering: OfferingPricingRecord,
  pricing: SyncedCoursePricing
): Promise<void> {
  const now = new Date().toISOString();
  await db.batch([
    db.prepare(
      "UPDATE course_offering_prices SET active = 0 WHERE course_offering_id = ? AND active = 1"
    ).bind(offering.id),
    db.prepare(
      `INSERT INTO course_offering_prices
        (id, course_offering_id, stripe_price_id, amount_cents, currency, pricing_version, active, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?)
       ON CONFLICT(course_offering_id, pricing_version) DO UPDATE SET
        stripe_price_id = excluded.stripe_price_id, amount_cents = excluded.amount_cents,
        currency = excluded.currency, active = 1`
    ).bind(
      crypto.randomUUID(), offering.id, pricing.stripePriceId, offering.price_cents,
      offering.currency, offering.pricing_version, now
    ),
    db.prepare(
      `UPDATE course_offerings SET stripe_price_id = ?, pricing_status = 'ready',
       status = 'published', updated_at = ? WHERE id = ?`
    ).bind(pricing.stripePriceId, now, offering.id),
    db.prepare(
      `UPDATE courses SET stripe_product_id = ?, status = 'published',
       published_at = COALESCE(published_at, ?), updated_at = ? WHERE id = ?`
    ).bind(pricing.stripeProductId, now, now, offering.course_id)
  ]);
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
