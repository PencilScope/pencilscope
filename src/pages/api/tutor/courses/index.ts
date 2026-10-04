import type { APIRoute } from "astro";
import { getTutorActor } from "@/lib/auth";
import { parseCreateCourseInput, slugifyCourse } from "@/lib/course-input";
import {
  archivePreviousStripePrice,
  persistSyncedCoursePricing,
  syncCoursePricing,
  type CoursePricingRecord
} from "@/lib/course-pricing";
import { json, problem } from "@/lib/http";
import { getEnv, requireSecret } from "@/lib/runtime";

export const POST: APIRoute = async ({ request, locals, session }) => {
  const env = getEnv(locals);
  const actor = await getTutorActor(session, env.DB);
  if (!actor) return problem(401, "authentication_required", "Sign in with an approved tutor account.");

  let input;
  try {
    input = parseCreateCourseInput(await request.json());
  } catch (error) {
    return problem(400, "invalid_course", error instanceof Error ? error.message : "Invalid course details.");
  }

  const id = crypto.randomUUID();
  const slug = slugifyCourse(input.title, id);
  const now = new Date().toISOString();
  const course: CoursePricingRecord = {
    id,
    title: input.title,
    description: input.description,
    price_cents: input.priceCents,
    currency: input.currency,
    pricing_version: 1,
    stripe_product_id: null,
    stripe_price_id: null
  };

  await env.DB.prepare(
    `INSERT INTO courses
      (id, tutor_id, slug, title, description, subject, primary_level, delivery_mode,
       price_cents, currency, status, pricing_status, pricing_version, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', 'pending', 1, ?, ?)`
  ).bind(
    id, actor.id, slug, input.title, input.description, input.subject,
    input.primaryLevel, input.deliveryMode, input.priceCents, input.currency, now, now
  ).run();

  if (!input.publish) {
    return json({ course: { id, slug, status: "draft", pricingStatus: "pending" } }, { status: 201 });
  }

  try {
    await env.DB.prepare(
      `UPDATE courses SET pricing_status = 'syncing', updated_at = ? WHERE id = ?`
    ).bind(new Date().toISOString(), id).run();
    const stripeSecret = requireSecret(env, "STRIPE_SECRET_KEY");
    const pricing = await syncCoursePricing(stripeSecret, course);
    await persistSyncedCoursePricing(env.DB, course, pricing, true);
    await archivePreviousStripePrice(stripeSecret, pricing).catch((error) => {
      console.warn("course.pricing.previous_price_archive_failed", { courseId: id, error });
    });
    return json({
      course: {
        id,
        slug,
        status: "published",
        pricingStatus: "ready",
        stripeProductId: pricing.stripeProductId,
        stripePriceId: pricing.stripePriceId
      }
    }, { status: 201 });
  } catch (error) {
    console.error("course.pricing.sync_failed", { courseId: id, error });
    await env.DB.prepare(
      `UPDATE courses SET pricing_status = 'failed', updated_at = ? WHERE id = ?`
    ).bind(new Date().toISOString(), id).run();
    return problem(502, "pricing_sync_failed", "The course was saved as a draft, but Stripe pricing could not be created.");
  }
};
