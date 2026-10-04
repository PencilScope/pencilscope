import type { APIRoute } from "astro";
import { problem } from "@/lib/http";
import { getEnv, requireSecret } from "@/lib/runtime";
import { createStripe } from "@/lib/stripe";

export const POST: APIRoute = async ({ request, locals }) => {
  const env = getEnv(locals);
  const form = await request.formData();
  const courseId = form.get("courseId");
  if (typeof courseId !== "string" || !courseId) return problem(400, "invalid_course", "Choose a valid course.");

  const course = await env.DB.prepare(
    `SELECT id, slug, stripe_price_id FROM courses WHERE id = ? AND status = 'published'`
  ).bind(courseId).first<{ id: string; slug: string; stripe_price_id: string | null }>();

  if (!course) return problem(404, "course_not_found", "This course is not available.");
  if (!course.stripe_price_id) return problem(409, "checkout_not_configured", "Checkout is not configured for this course yet.");

  try {
    const stripe = createStripe(requireSecret(env, "STRIPE_SECRET_KEY"));
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      line_items: [{ price: course.stripe_price_id, quantity: 1 }],
      success_url: `${env.APP_URL}/courses/${course.slug}?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${env.APP_URL}/courses/${course.slug}?checkout=cancelled`,
      metadata: { courseId: course.id, stripePriceId: course.stripe_price_id }
    });
    if (!session.url) return problem(502, "stripe_error", "Stripe did not return a checkout URL.");
    return Response.redirect(session.url, 303);
  } catch (error) {
    console.error("checkout.create.failed", { courseId, error });
    return problem(502, "checkout_failed", "Checkout is temporarily unavailable.");
  }
};
