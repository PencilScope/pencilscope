import type Stripe from "stripe";
import { getTutorActorById } from "../../../src/lib/auth";
import { parseCreateCourseInput, slugifyCourse } from "../../../src/lib/course-input";
import {
  archivePreviousStripePrice,
  persistSyncedCoursePricing,
  syncCoursePricing,
  type CoursePricingRecord
} from "../../../src/lib/course-pricing";
import { findCourseBySlug, listPublishedCourses } from "../../../src/lib/courses";
import { json, problem } from "../../../src/lib/http";
import { constructStripeEvent, createStripe } from "../../../src/lib/stripe";

type ApiEnvironment = {
  DB: D1Database;
  MEDIA: R2Bucket;
  JOBS: Queue;
  APP_URL: string;
  ENVIRONMENT: string;
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  RESEND_API_KEY?: string;
  EMAIL_FROM?: string;
};

type SecretName = "STRIPE_SECRET_KEY" | "STRIPE_WEBHOOK_SECRET" | "RESEND_API_KEY";

function requireSecret(env: ApiEnvironment, name: SecretName): string {
  const value = env[name];
  if (!value) throw new Error(`${name} is not configured`);
  return value;
}

function authenticatedUserId(request: Request): string | null {
  const userId = request.headers.get("x-pencilscope-user-id");
  return userId?.trim() || null;
}

async function health(env: ApiEnvironment): Promise<Response> {
  let database = "ready";
  try {
    await env.DB.prepare("SELECT 1").first();
  } catch {
    database = "unavailable";
  }
  return json({
    status: database === "ready" ? "ok" : "degraded",
    service: "pencilscope-api",
    environment: env.ENVIRONMENT,
    database,
    time: new Date().toISOString()
  }, { status: database === "ready" ? 200 : 503 });
}

async function courses(env: ApiEnvironment): Promise<Response> {
  return json({ courses: await listPublishedCourses(env.DB) });
}

async function courseBySlug(env: ApiEnvironment, slug: string): Promise<Response> {
  const course = await findCourseBySlug(slug, env.DB);
  return course
    ? json({ course })
    : problem(404, "course_not_found", "The course does not exist.");
}

async function checkout(request: Request, env: ApiEnvironment): Promise<Response> {
  const form = await request.formData();
  const courseId = form.get("courseId");
  if (typeof courseId !== "string" || !courseId) {
    return problem(400, "invalid_course", "Choose a valid course.");
  }

  const course = await env.DB.prepare(
    "SELECT id, slug, stripe_price_id FROM courses WHERE id = ? AND status = 'published'"
  ).bind(courseId).first<{ id: string; slug: string; stripe_price_id: string | null }>();

  if (!course) return problem(404, "course_not_found", "This course is not available.");
  if (!course.stripe_price_id) {
    return problem(409, "checkout_not_configured", "Checkout is not configured for this course yet.");
  }

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
}

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

async function stripeWebhook(request: Request, env: ApiEnvironment): Promise<Response> {
  const signature = request.headers.get("stripe-signature");
  if (!signature) return problem(400, "missing_signature", "Missing Stripe signature.");

  let event: Stripe.Event;
  try {
    const payload = await request.text();
    const stripe = createStripe(requireSecret(env, "STRIPE_SECRET_KEY"));
    event = await constructStripeEvent(
      stripe,
      payload,
      signature,
      requireSecret(env, "STRIPE_WEBHOOK_SECRET")
    );
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
    if (event.type === "checkout.session.completed") {
      await recordCompletedCheckout(env.DB, event.data.object);
    }
    await env.DB.prepare(
      "UPDATE webhook_events SET status = 'processed', processed_at = ? WHERE provider = 'stripe' AND event_id = ?"
    ).bind(new Date().toISOString(), event.id).run();
    return json({ received: true });
  } catch (error) {
    console.error("stripe.webhook.processing_failed", {
      eventId: event.id,
      eventType: event.type,
      error
    });
    await env.DB.prepare(
      "UPDATE webhook_events SET status = 'failed', error_message = ? WHERE provider = 'stripe' AND event_id = ?"
    ).bind(error instanceof Error ? error.message.slice(0, 500) : "Unknown error", event.id).run();
    return problem(500, "processing_failed", "Webhook processing failed.");
  }
}

async function createCourse(request: Request, env: ApiEnvironment): Promise<Response> {
  const actor = await getTutorActorById(authenticatedUserId(request), env.DB);
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
      "UPDATE courses SET pricing_status = 'syncing', updated_at = ? WHERE id = ?"
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
      "UPDATE courses SET pricing_status = 'failed', updated_at = ? WHERE id = ?"
    ).bind(new Date().toISOString(), id).run();
    return problem(502, "pricing_sync_failed", "The course was saved as a draft, but Stripe pricing could not be created.");
  }
}

type PublishableCourse = CoursePricingRecord & {
  tutor_id: string | null;
  slug: string;
  status: string;
  pricing_status: string;
};

async function publishCourse(request: Request, env: ApiEnvironment, id: string): Promise<Response> {
  const actor = await getTutorActorById(authenticatedUserId(request), env.DB);
  if (!actor) return problem(401, "authentication_required", "Sign in with an approved tutor account.");

  const course = await env.DB.prepare(
    `SELECT id, tutor_id, slug, title, description, price_cents, currency, status,
      pricing_status, pricing_version, stripe_product_id, stripe_price_id
     FROM courses WHERE id = ?`
  ).bind(id).first<PublishableCourse>();
  if (!course) return problem(404, "course_not_found", "The course does not exist.");
  if (actor.role !== "admin" && course.tutor_id !== actor.id) {
    return problem(403, "course_forbidden", "You cannot publish this course.");
  }
  if (course.status === "archived") {
    return problem(409, "course_archived", "Archived courses cannot be published.");
  }
  if (course.status === "published" && course.pricing_status === "ready") {
    return json({
      course: {
        id: course.id,
        slug: course.slug,
        status: course.status,
        pricingStatus: course.pricing_status
      }
    });
  }

  try {
    await env.DB.prepare(
      "UPDATE courses SET pricing_status = 'syncing', updated_at = ? WHERE id = ?"
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
      "UPDATE courses SET pricing_status = 'failed', updated_at = ? WHERE id = ?"
    ).bind(new Date().toISOString(), course.id).run();
    return problem(502, "pricing_sync_failed", "Stripe pricing could not be created. The course remains unpublished.");
  }
}

type EditableCourse = CoursePricingRecord & {
  tutor_id: string | null;
  slug: string;
  status: string;
};

async function updateCoursePricing(request: Request, env: ApiEnvironment, id: string): Promise<Response> {
  const actor = await getTutorActorById(authenticatedUserId(request), env.DB);
  if (!actor) return problem(401, "authentication_required", "Sign in with an approved tutor account.");

  let payload: { priceCents?: unknown; currency?: unknown };
  try {
    payload = await request.json();
  } catch {
    return problem(400, "invalid_json", "A JSON request body is required.");
  }
  if (
    !Number.isSafeInteger(payload.priceCents) ||
    Number(payload.priceCents) < 50 ||
    Number(payload.priceCents) > 1_000_000
  ) {
    return problem(400, "invalid_price", "priceCents must be an integer between 50 and 1000000.");
  }
  if (payload.currency !== "SGD") {
    return problem(400, "invalid_currency", "Only SGD pricing is currently supported.");
  }

  const current = await env.DB.prepare(
    `SELECT id, tutor_id, slug, title, description, price_cents, currency, status,
      pricing_version, stripe_product_id, stripe_price_id
     FROM courses WHERE id = ?`
  ).bind(id).first<EditableCourse>();
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
    ).bind(
      next.price_cents,
      next.currency,
      next.pricing_version,
      new Date().toISOString(),
      next.id
    ).run();
    return json({
      course: {
        id: next.id,
        slug: current.slug,
        status: current.status,
        pricingStatus: "pending",
        pricingVersion: next.pricing_version
      }
    });
  }

  try {
    await env.DB.prepare(
      "UPDATE courses SET pricing_status = 'syncing', updated_at = ? WHERE id = ?"
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
      "UPDATE courses SET pricing_status = 'failed', updated_at = ? WHERE id = ?"
    ).bind(new Date().toISOString(), next.id).run();
    return problem(502, "pricing_sync_failed", "The new price could not be created. The previous price remains active.");
  }
}

function routeId(pathname: string, action: "publish" | "pricing"): string | null {
  const match = pathname.match(new RegExp(`^/api/tutor/courses/([^/]+)/${action}$`));
  return match ? decodeURIComponent(match[1]) : null;
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    const { pathname } = url;

    if (request.method === "GET" && pathname === "/api/health") return health(env);
    if (request.method === "GET" && pathname === "/api/courses") return courses(env);
    if (request.method === "GET" && pathname.startsWith("/api/courses/")) {
      return courseBySlug(env, decodeURIComponent(pathname.slice("/api/courses/".length)));
    }
    if (request.method === "POST" && pathname === "/api/checkout") return checkout(request, env);
    if (request.method === "POST" && pathname === "/api/webhooks/stripe") {
      return stripeWebhook(request, env);
    }
    if (request.method === "POST" && pathname === "/api/tutor/courses") {
      return createCourse(request, env);
    }

    const publishId = routeId(pathname, "publish");
    if (request.method === "POST" && publishId) return publishCourse(request, env, publishId);
    const pricingId = routeId(pathname, "pricing");
    if (request.method === "PATCH" && pricingId) {
      return updateCoursePricing(request, env, pricingId);
    }

    return problem(404, "not_found", "API route not found.");
  }
} satisfies ExportedHandler<ApiEnvironment>;
