import type { APIRoute } from "astro";
import { getTutorActor } from "@/lib/auth";
import {
  archivePreviousStripePrice,
  persistSyncedCoursePricing,
  syncCoursePricing,
  type CoursePricingRecord
} from "@/lib/course-pricing";
import { json, problem } from "@/lib/http";
import { getEnv, requireSecret } from "@/lib/runtime";

type EditableCourse = CoursePricingRecord & {
  tutor_id: string | null;
  slug: string;
  status: string;
};

export const PATCH: APIRoute = async ({ request, params, locals, session }) => {
  const env = getEnv(locals);
  const actor = await getTutorActor(session, env.DB);
  if (!actor) return problem(401, "authentication_required", "Sign in with an approved tutor account.");
  if (!params.id) return problem(400, "invalid_course", "A course ID is required.");

  let payload: { priceCents?: unknown; currency?: unknown };
  try { payload = await request.json(); }
  catch { return problem(400, "invalid_json", "A JSON request body is required."); }
  if (!Number.isSafeInteger(payload.priceCents) || Number(payload.priceCents) < 50 || Number(payload.priceCents) > 1_000_000) {
    return problem(400, "invalid_price", "priceCents must be an integer between 50 and 1000000.");
  }
  if (payload.currency !== "SGD") return problem(400, "invalid_currency", "Only SGD pricing is currently supported.");

  const current = await env.DB.prepare(
    `SELECT id, tutor_id, slug, title, description, price_cents, currency, status,
      pricing_version, stripe_product_id, stripe_price_id
     FROM courses WHERE id = ?`
  ).bind(params.id).first<EditableCourse>();
  if (!current) return problem(404, "course_not_found", "The course does not exist.");
  if (actor.role !== "admin" && current.tutor_id !== actor.id) {
    return problem(403, "course_forbidden", "You cannot change this course price.");
  }

  const next: CoursePricingRecord = {
    ...current,
    price_cents: Number(payload.priceCents),
    currency: "SGD",
    pricing_version: current.pricing_version + 1
  };

  if (current.status !== "published") {
    await env.DB.prepare(
      `UPDATE courses SET price_cents = ?, currency = ?, pricing_version = ?,
       pricing_status = 'pending', updated_at = ? WHERE id = ?`
    ).bind(next.price_cents, next.currency, next.pricing_version, new Date().toISOString(), next.id).run();
    return json({ course: { id: next.id, slug: current.slug, status: current.status, pricingStatus: "pending", pricingVersion: next.pricing_version } });
  }

  try {
    await env.DB.prepare(
      `UPDATE courses SET pricing_status = 'syncing', updated_at = ? WHERE id = ?`
    ).bind(new Date().toISOString(), next.id).run();
    const stripeSecret = requireSecret(env, "STRIPE_SECRET_KEY");
    const pricing = await syncCoursePricing(stripeSecret, next);
    await persistSyncedCoursePricing(env.DB, next, pricing, false);
    await archivePreviousStripePrice(stripeSecret, pricing).catch((error) => {
      console.warn("course.pricing.previous_price_archive_failed", { courseId: next.id, error });
    });
    return json({
      course: {
        id: next.id,
        slug: current.slug,
        status: current.status,
        pricingStatus: "ready",
        pricingVersion: next.pricing_version,
        stripeProductId: pricing.stripeProductId,
        stripePriceId: pricing.stripePriceId
      }
    });
  } catch (error) {
    console.error("course.price.sync_failed", { courseId: next.id, error });
    await env.DB.prepare(
      `UPDATE courses SET pricing_status = 'failed', updated_at = ? WHERE id = ?`
    ).bind(new Date().toISOString(), next.id).run();
    return problem(502, "pricing_sync_failed", "The new price could not be created. The previous price remains active.");
  }
};
