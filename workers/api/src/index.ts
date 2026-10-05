import type Stripe from "stripe";
import { getCreatorActorById } from "../../../src/lib/auth";
import { parseCreateCourseInput, slugifyCourse } from "../../../src/lib/course-input";
import {
  archivePreviousStripePrice,
  persistSyncedOfferingPricing,
  persistSyncedCoursePricing,
  syncOfferingPricing,
  syncCoursePricing,
  type OfferingPricingRecord,
  type CoursePricingRecord
} from "../../../src/lib/course-pricing";
import { findCourseBySlug, listPublishedCourses } from "../../../src/lib/courses";
import { json, problem } from "../../../src/lib/http";
import { constructStripeEvent, createStripe } from "../../../src/lib/stripe";
import { handleJourneyRequest } from "./journeys";

export type ApiEnvironment = {
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

async function courseOfferingsBySlug(env: ApiEnvironment, slug: string): Promise<Response> {
  const course = await findCourseBySlug(slug, env.DB);
  if (!course) return problem(404, "course_not_found", "The course does not exist.");
  const offerings = await env.DB.prepare(
    `SELECT o.id, o.title, o.price_cents, o.currency, o.enrolment_opens_at,
      o.enrolment_closes_at, o.access_ends_at, o.pricing_status,
      o.offering_type, o.delivery_mode, o.starts_at, o.ends_at, o.timezone, o.capacity,
      t.academic_year, t.term_number,
      EXISTS(SELECT 1 FROM course_offering_modules om WHERE om.course_offering_id = o.id) AS has_online_course,
      EXISTS(SELECT 1 FROM course_offering_materials mt WHERE mt.course_offering_id = o.id) AS has_materials,
      EXISTS(SELECT 1 FROM course_offering_assessments oa JOIN assessments a ON a.id = oa.assessment_id
        WHERE oa.course_offering_id = o.id AND a.assessment_type = 'quiz') AS has_quizzes,
      EXISTS(SELECT 1 FROM course_offering_assessments oa JOIN assessments a ON a.id = oa.assessment_id
        WHERE oa.course_offering_id = o.id AND a.assessment_type = 'test') AS has_tests,
      EXISTS(SELECT 1 FROM course_offering_assessments oa JOIN assessments a ON a.id = oa.assessment_id
        WHERE oa.course_offering_id = o.id AND a.assessment_type = 'mock_exam') AS has_mock_exams
     FROM course_offerings o JOIN academic_terms t ON t.id = o.academic_term_id
     WHERE o.course_id = ? AND o.status = 'published'
       AND (o.enrolment_opens_at IS NULL OR o.enrolment_opens_at <= ?)
       AND (o.enrolment_closes_at IS NULL OR o.enrolment_closes_at >= ?)
     ORDER BY COALESCE(o.starts_at, t.starts_at, o.created_at), o.title`
  ).bind(course.id, new Date().toISOString(), new Date().toISOString()).all();
  return json({ course, offerings: offerings.results });
}

async function checkout(request: Request, env: ApiEnvironment): Promise<Response> {
  const form = await request.formData();
  const courseId = form.get("courseId");
  const offeringId = form.get("offeringId");
  const requestedStudentId = form.get("studentId");
  if (typeof courseId !== "string" || !courseId) {
    return problem(400, "invalid_course", "Choose a valid course.");
  }
  if (typeof offeringId !== "string" || !offeringId) {
    return problem(400, "invalid_offering", "Choose a valid course offering.");
  }
  const actorId = authenticatedUserId(request);
  if (!actorId) return problem(401, "authentication_required", "Sign in before enrolling.");
  const actor = await env.DB.prepare(
    "SELECT id, role FROM users WHERE id = ? AND status = 'active'"
  ).bind(actorId).first<{ id: string; role: string }>();
  if (!actor) return problem(401, "authentication_required", "Sign in before enrolling.");
  let studentId: string;
  let parentUserId: string | null = null;
  if (actor.role === "student") {
    studentId = actor.id;
  } else if (actor.role === "parent" && typeof requestedStudentId === "string" && requestedStudentId) {
    const linked = await env.DB.prepare(
      "SELECT 1 FROM parent_student_relationships WHERE parent_user_id = ? AND student_user_id = ?"
    ).bind(actor.id, requestedStudentId).first();
    if (!linked) return problem(403, "student_forbidden", "Choose a student linked to your account.");
    studentId = requestedStudentId;
    parentUserId = actor.id;
  } else {
    return problem(403, "student_required", "Choose a linked student for this enrolment.");
  }

  const course = await env.DB.prepare(
    `SELECT c.id, c.slug, o.id AS offering_id, o.stripe_price_id, o.capacity
     FROM courses c JOIN course_offerings o ON o.course_id = c.id
     WHERE c.id = ? AND o.id = ? AND c.status = 'published' AND o.status = 'published'
       AND (o.enrolment_opens_at IS NULL OR o.enrolment_opens_at <= ?)
       AND (o.enrolment_closes_at IS NULL OR o.enrolment_closes_at >= ?)`
  ).bind(courseId, offeringId, new Date().toISOString(), new Date().toISOString())
    .first<{ id: string; slug: string; offering_id: string; stripe_price_id: string | null; capacity: number | null }>();

  if (!course) return problem(404, "course_not_found", "This course is not available.");
  if (!course.stripe_price_id) {
    return problem(409, "checkout_not_configured", "Checkout is not configured for this course yet.");
  }
  const existing = await env.DB.prepare(
    `SELECT id FROM enrolment_offerings WHERE course_offering_id = ?
     AND student_user_id = ? AND status IN ('active', 'completed')`
  ).bind(course.offering_id, studentId).first();
  if (existing) return problem(409, "already_enrolled", "This learner already has access to this offering.");
  if (course.capacity !== null) {
    const occupancy = await env.DB.prepare(
      `SELECT COUNT(*) AS total FROM enrolment_offerings
       WHERE course_offering_id = ? AND status IN ('active', 'completed')`
    ).bind(course.offering_id).first<{ total: number }>();
    if (Number(occupancy?.total ?? 0) >= course.capacity) {
      return problem(409, "offering_full", "This offering has reached its capacity.");
    }
  }

  try {
    const stripe = createStripe(requireSecret(env, "STRIPE_SECRET_KEY"));
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      line_items: [{ price: course.stripe_price_id, quantity: 1 }],
      success_url: `${env.APP_URL}/courses/${course.slug}?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${env.APP_URL}/courses/${course.slug}?checkout=cancelled`,
      metadata: {
        courseId: course.id,
        offeringId: course.offering_id,
        stripePriceId: course.stripe_price_id,
        studentUserId: studentId,
        parentUserId: parentUserId ?? ""
      }
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
  const offeringId = session.metadata?.offeringId;
  const studentUserId = session.metadata?.studentUserId;
  const parentUserId = session.metadata?.parentUserId || null;
  if (!courseId || !offeringId || !studentUserId) throw new Error("Checkout session is missing enrolment metadata");
  const now = new Date().toISOString();
  const orderId = crypto.randomUUID();
  const existingEnrolment = await db.prepare(
    "SELECT id FROM enrolments WHERE course_id = ? AND student_user_id = ?"
  ).bind(courseId, studentUserId).first<{ id: string }>();
  const enrolmentId = existingEnrolment?.id ?? crypto.randomUUID();
  const enrolmentOfferingId = crypto.randomUUID();
  await db.batch([
    db.prepare(
      `INSERT INTO orders (id, parent_user_id, student_user_id, course_id, course_offering_id,
      stripe_checkout_session_id, stripe_payment_intent_id, stripe_price_id, amount_cents, currency, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'paid', ?, ?)
    ON CONFLICT(stripe_checkout_session_id) DO UPDATE SET
      stripe_payment_intent_id = excluded.stripe_payment_intent_id,
      stripe_price_id = excluded.stripe_price_id,
      amount_cents = excluded.amount_cents, currency = excluded.currency,
      status = 'paid', updated_at = excluded.updated_at`
    ).bind(
      orderId,
      parentUserId,
      studentUserId,
      courseId,
      offeringId,
      session.id,
      typeof session.payment_intent === "string" ? session.payment_intent : null,
      session.metadata?.stripePriceId ?? null,
      session.amount_total ?? 0,
      (session.currency ?? "sgd").toUpperCase(),
      now,
      now
    ),
    db.prepare(
      `INSERT INTO enrolments
        (id, course_id, student_user_id, order_id, status, enrolled_at)
       VALUES (?, ?, ?, ?, 'active', ?)
       ON CONFLICT(course_id, student_user_id) DO UPDATE SET
        order_id = excluded.order_id, status = 'active', enrolled_at = excluded.enrolled_at,
        completed_at = NULL`
    ).bind(enrolmentId, courseId, studentUserId, orderId, now),
    db.prepare(
      `INSERT INTO enrolment_offerings
        (id, enrolment_id, course_offering_id, student_user_id, order_id, status, enrolled_at)
       VALUES (?, ?, ?, ?, ?, 'active', ?)
       ON CONFLICT(course_offering_id, student_user_id) DO UPDATE SET
        enrolment_id = excluded.enrolment_id, order_id = excluded.order_id,
        status = 'active', enrolled_at = excluded.enrolled_at, completed_at = NULL`
    ).bind(enrolmentOfferingId, enrolmentId, offeringId, studentUserId, orderId, now),
    db.prepare(
      `INSERT OR IGNORE INTO course_session_attendance
        (course_session_id, student_user_id, status, updated_at)
       SELECT id, ?, 'registered', ? FROM course_sessions
       WHERE course_offering_id = ? AND status = 'scheduled'`
    ).bind(studentUserId, now, offeringId)
  ]);
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
  const actor = await getCreatorActorById(authenticatedUserId(request), env.DB);
  if (!actor) return problem(401, "authentication_required", "Sign in to create a course.");

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

  const statements = [env.DB.prepare(
    `INSERT INTO courses
      (id, tutor_id, slug, title, description, subject, primary_level, delivery_mode,
       price_cents, currency, status, pricing_status, pricing_version, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', 'pending', 1, ?, ?)`
  ).bind(
    id, actor.id, slug, input.title, input.description, input.subject,
    input.primaryLevel, input.deliveryMode, input.priceCents, input.currency, now, now
  ), env.DB.prepare(
    `INSERT INTO course_members
      (course_id, user_id, member_role, status, created_at, updated_at)
     VALUES (?, ?, 'owner', 'active', ?, ?)`
  ).bind(id, actor.id, now, now)];
  for (const categorySlug of input.categorySlugs) {
    statements.push(env.DB.prepare(
      `INSERT OR IGNORE INTO course_category_links (course_id, category_id)
       SELECT ?, id FROM course_categories WHERE slug = ? AND active = 1`
    ).bind(id, categorySlug));
  }
  await env.DB.batch(statements);

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
  const actor = await getCreatorActorById(authenticatedUserId(request), env.DB);
  if (!actor) return problem(401, "authentication_required", "Sign in to manage this course.");

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
  const actor = await getCreatorActorById(authenticatedUserId(request), env.DB);
  if (!actor) return problem(401, "authentication_required", "Sign in to manage this course.");

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

async function publishOffering(request: Request, env: ApiEnvironment, id: string): Promise<Response> {
  const actor = await getCreatorActorById(authenticatedUserId(request), env.DB);
  if (!actor) return problem(401, "authentication_required", "Sign in to manage this offering.");
  const offering = await env.DB.prepare(
    `SELECT o.id, o.course_id, o.title, o.price_cents, o.currency, o.pricing_version,
      o.stripe_price_id, c.title AS course_title, c.description AS course_description,
      c.stripe_product_id
     FROM course_offerings o JOIN courses c ON c.id = o.course_id
     WHERE o.id = ? AND (c.tutor_id = ? OR ? = 'admin') AND o.status != 'archived'`
  ).bind(id, actor.id, actor.role).first<OfferingPricingRecord>();
  if (!offering) return problem(404, "offering_not_found", "The course offering does not exist.");
  try {
    await env.DB.prepare(
      "UPDATE course_offerings SET pricing_status = 'syncing', updated_at = ? WHERE id = ?"
    ).bind(new Date().toISOString(), id).run();
    const stripeSecret = requireSecret(env, "STRIPE_SECRET_KEY");
    const pricing = await syncOfferingPricing(stripeSecret, offering);
    await persistSyncedOfferingPricing(env.DB, offering, pricing);
    await archivePreviousStripePrice(stripeSecret, pricing).catch((error) => {
      console.warn("offering.pricing.previous_price_archive_failed", { offeringId: id, error });
    });
    return json({
      offering: {
        id,
        courseId: offering.course_id,
        status: "published",
        pricingStatus: "ready",
        stripeProductId: pricing.stripeProductId,
        stripePriceId: pricing.stripePriceId
      }
    });
  } catch (error) {
    console.error("offering.pricing.sync_failed", { offeringId: id, error });
    await env.DB.prepare(
      "UPDATE course_offerings SET pricing_status = 'failed', updated_at = ? WHERE id = ?"
    ).bind(new Date().toISOString(), id).run();
    return problem(502, "offering_pricing_sync_failed", "The offering price could not be created in Stripe.");
  }
}

function routeId(pathname: string, action: "publish" | "pricing"): string | null {
  const match = pathname.match(new RegExp(`^/api/tutor/courses/([^/]+)/${action}$`));
  return match ? decodeURIComponent(match[1]) : null;
}

function offeringPublishId(pathname: string): string | null {
  const match = pathname.match(/^\/api\/tutor\/offerings\/([^/]+)\/publish$/);
  return match ? decodeURIComponent(match[1]) : null;
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    const { pathname } = url;

    if (request.method === "GET" && pathname === "/api/health") return health(env);
    const journeyResponse = await handleJourneyRequest(request, env, pathname);
    if (journeyResponse) return journeyResponse;
    if (request.method === "GET" && pathname === "/api/courses") return courses(env);
    const offeringListMatch = pathname.match(/^\/api\/courses\/([^/]+)\/offerings$/);
    if (request.method === "GET" && offeringListMatch) {
      return courseOfferingsBySlug(env, decodeURIComponent(offeringListMatch[1]));
    }
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
    const publishOfferingId = offeringPublishId(pathname);
    if (request.method === "POST" && publishOfferingId) {
      return publishOffering(request, env, publishOfferingId);
    }

    return problem(404, "not_found", "API route not found.");
  }
} satisfies ExportedHandler<ApiEnvironment>;
