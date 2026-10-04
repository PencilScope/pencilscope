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

type PublishableCourse = CoursePricingRecord & {
  tutor_id: string | null;
  slug: string;
  status: string;
  pricing_status: string;
};

export const POST: APIRoute = async ({ params, locals, session }) => {
  const env = getEnv(locals);
  const actor = await getTutorActor(session, env.DB);
  if (!actor) return problem(401, "authentication_required", "Sign in with an approved tutor account.");
  if (!params.id) return problem(400, "invalid_course", "A course ID is required.");

  const course = await env.DB.prepare(
    `SELECT id, tutor_id, slug, title, description, price_cents, currency, status,
      pricing_status, pricing_version, stripe_product_id, stripe_price_id
     FROM courses WHERE id = ?`
  ).bind(params.id).first<PublishableCourse>();
  if (!course) return problem(404, "course_not_found", "The course does not exist.");
  if (actor.role !== "admin" && course.tutor_id !== actor.id) {
    return problem(403, "course_forbidden", "You cannot publish this course.");
  }
  if (course.status === "archived") return problem(409, "course_archived", "Archived courses cannot be published.");
  if (course.status === "published" && course.pricing_status === "ready") {
    return json({ course: { id: course.id, slug: course.slug, status: course.status, pricingStatus: course.pricing_status } });
  }

  try {
    await env.DB.prepare(
      `UPDATE courses SET pricing_status = 'syncing', updated_at = ? WHERE id = ?`
    ).bind(new Date().toISOString(), course.id).run();
    const stripeSecret = requireSecret(env, "STRIPE_SECRET_KEY");
    const pricing = await syncCoursePricing(stripeSecret, course);
    await persistSyncedCoursePricing(env.DB, course, pricing, true);
    await archivePreviousStripePrice(stripeSecret, pricing).catch((error) => {
      console.warn("course.pricing.previous_price_archive_failed", { courseId: course.id, error });
    });
    return json({
      course: {
        id: course.id,
        slug: course.slug,
        status: "published",
        pricingStatus: "ready",
        stripeProductId: pricing.stripeProductId,
        stripePriceId: pricing.stripePriceId
      }
    });
  } catch (error) {
    console.error("course.publish.pricing_failed", { courseId: course.id, error });
    await env.DB.prepare(
      `UPDATE courses SET pricing_status = 'failed', updated_at = ? WHERE id = ?`
    ).bind(new Date().toISOString(), course.id).run();
    return problem(502, "pricing_sync_failed", "Stripe pricing could not be created. The course remains unpublished.");
  }
};
