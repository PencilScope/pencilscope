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
import {
  learningProductDataReadySql,
  offeringCommerceReadySql,
  offeringContentCountSql,
  offeringProductsReadySql
} from "../../../src/lib/offering-readiness";
import { constructStripeEvent, createStripe } from "../../../src/lib/stripe";
import { handleInvitationRequest, validInvitationForCheckout } from "./invitations";
import { handleJourneyRequest } from "./journeys";
import { handleLearningProductRequest } from "./learning-products";
import { handleOperationsRequest, touchActiveSession } from "./operations";
import { handleContentAuthoringRequest } from "./content-authoring";
import { handleCollaborationRequest } from "./collaboration";
import { handleOAuthRequest } from "./oauth";
import { handleMcpOAuthRequest } from "./mcp-oauth";
import { handleNavigationMediaRequest } from "./navigation-media";
import { handleCreatorLibraryRequest } from "./creator-library";
import { handleCreatorLibraryUploadRequest } from "./creator-library-uploads";
import { handleStorageSubscriptionRequest, processStorageCheckout, syncStorageSubscription } from "./storage-subscriptions";
import { calculateOfferingPrice } from "./platform-pricing";
import { handleGoogleMeetRequest, sendSessionReminders } from "./google-meet";
import { handleActionHistoryRequest } from "./action-history";
import { handlePayoutRequest } from "./payouts";
import { handleContactEnquiryRequest } from "./contact-enquiries";
import { handleProductOfferRequest } from "./product-offers";
import { handleMarketplaceOfferRequest } from "./marketplace-offers";
import { purgeExpiredLibraryItems } from "./r2-asset-catalogue";
import {
  ensureCreatorEarningForOrder,
  handleSettlementRequest,
  reconcileCreatorSettlements,
  recordStripeDispute,
  recordStripeProcessingFee,
  recordStripeRefund
} from "./settlements";

export type ApiEnvironment = {
  DB: D1Database;
  MEDIA: R2Bucket;
  ACTION_ARCHIVE: R2Bucket;
  CONTACT_ENQUIRIES: R2Bucket;
  JOBS: Queue;
  APP_URL: string;
  ENVIRONMENT: string;
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  STRIPE_STORAGE_PRICE_ID?: string;
  RESEND_API_KEY?: string;
  EMAIL_FROM?: string;
  MEETING_USAGE_WEBHOOK_SECRET?: string;
  ENABLE_AUTOMATIC_TRANSFERS?: string;
  PLATFORM_FEE_BPS?: string;
  PLATFORM_FIXED_FEE_CENTS?: string;
  MIN_COURSE_PRICE_CENTS?: string;
  SETTLEMENT_REVIEW_DAYS?: string;
  CREATOR_RESERVE_BPS?: string;
  PLATFORM_MEETING_RATE_MICROS?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  FACEBOOK_APP_ID?: string;
  FACEBOOK_APP_SECRET?: string;
  FACEBOOK_GRAPH_VERSION?: string;
  OAUTH_ALLOWED_REDIRECT_ORIGINS?: string;
  MCP_RESOURCE_ORIGINS?: string;
  CONTENT_LIBRARY_MAX_IMAGE_BYTES?: string;
  CONTENT_LIBRARY_MAX_DOCUMENT_BYTES?: string;
  CONTENT_LIBRARY_MAX_AUDIO_BYTES?: string;
  CONTENT_LIBRARY_MAX_VIDEO_BYTES?: string;
  CONTENT_LIBRARY_DIRECT_UPLOAD_THRESHOLD_BYTES?: string;
  CONTENT_LIBRARY_MULTIPART_PART_BYTES?: string;
  CONTENT_LIBRARY_UPLOAD_RESUME_HOURS?: string;
  CONTENT_LIBRARY_RECOVERY_DAYS?: string;
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

type DefaultOfferingCourse = CoursePricingRecord & {
  delivery_mode: string;
  pricing_status: string;
  creator_price_cents?: number;
};

async function ensureDefaultCourseOffering(
  env: ApiEnvironment,
  course: DefaultOfferingCourse,
  actorUserId: string | null
): Promise<{ id: string; created: boolean }> {
  const offeringId = `offering-${course.id}`;
  const existing = await env.DB.prepare(
    "SELECT id FROM course_offerings WHERE course_id = ? ORDER BY created_at LIMIT 1"
  ).bind(course.id).first<{ id: string }>();
  if (existing && existing.id !== offeringId) return { id: existing.id, created: false };
  if (course.pricing_status !== "ready" || !course.stripe_price_id) {
    throw new Error("Course pricing must be ready before enrolment can be opened");
  }

  const now = new Date().toISOString();
  const offeringType = course.delivery_mode === "self-paced" || course.delivery_mode === "ai-supported"
    ? "self_paced"
    : "cohort";
  const deliveryMode = course.delivery_mode === "live"
    ? "live_online"
    : course.delivery_mode === "hybrid" ? "hybrid" : "recorded";
  const creatorPriceCents = course.creator_price_cents || Math.max(1, course.price_cents);
  const breakdown = calculateOfferingPrice(env, creatorPriceCents);

  await env.DB.batch([
    env.DB.prepare(
      `INSERT OR IGNORE INTO academic_terms
        (id, academic_year, term_number, title, starts_at, ends_at, created_at)
       VALUES ('academic-term-legacy', 2000, 0, 'Full course access', NULL, NULL, ?)`
    ).bind(now),
    env.DB.prepare(
      `INSERT OR IGNORE INTO course_offerings
       (id, course_id, academic_term_id, title, enrolment_opens_at, enrolment_closes_at,
         access_ends_at, price_cents, currency, pricing_version, stripe_price_id,
         pricing_status, status, offering_type, delivery_mode, starts_at, ends_at,
         timezone, capacity, creator_price_cents, platform_fixed_fee_cents,
         service_fee_bps, service_fee_cents, planned_meeting_minutes,
         planned_meeting_participants, planned_paid_learners, planned_meeting_cost_cents,
         created_at, updated_at)
       VALUES (?, ?, 'academic-term-legacy', 'Full course access', NULL, NULL,
         NULL, ?, ?, ?, ?, 'ready', 'published', ?, ?, NULL, NULL,
         'Asia/Singapore', NULL, ?, ?, ?, ?, 0, 0, 1, 0, ?, ?)`
    ).bind(
      offeringId, course.id, course.price_cents, course.currency, course.pricing_version,
      course.stripe_price_id, offeringType, deliveryMode, breakdown.creatorPriceCents,
      breakdown.platformFixedFeeCents, breakdown.serviceFeeBps, breakdown.serviceFeeCents,
      now, now
    ),
    env.DB.prepare(
      `UPDATE course_offerings SET title = 'Full course access', price_cents = ?,
       currency = ?, pricing_version = ?, stripe_price_id = ?, pricing_status = 'ready',
       status = 'published', offering_type = ?, delivery_mode = ?, creator_price_cents = ?,
       platform_fixed_fee_cents = ?, service_fee_bps = ?, service_fee_cents = ?, updated_at = ?
       WHERE id = ? AND course_id = ?`
    ).bind(
      course.price_cents, course.currency, course.pricing_version, course.stripe_price_id,
      offeringType, deliveryMode, breakdown.creatorPriceCents, breakdown.platformFixedFeeCents,
      breakdown.serviceFeeBps, breakdown.serviceFeeCents, now, offeringId, course.id
    ),
    env.DB.prepare(
      `INSERT OR IGNORE INTO course_offering_prices
        (id, course_offering_id, stripe_price_id, amount_cents, currency,
         pricing_version, active, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?)`
    ).bind(
      crypto.randomUUID(), offeringId, course.stripe_price_id, course.price_cents,
      course.currency, course.pricing_version, now
    ),
    env.DB.prepare(
      `INSERT OR IGNORE INTO course_offering_modules (course_offering_id, module_id, position)
       SELECT ?, id, position FROM course_modules WHERE course_id = ?`
    ).bind(offeringId, course.id),
    env.DB.prepare(
      `INSERT OR IGNORE INTO course_offering_assessments (course_offering_id, assessment_id, position)
       SELECT ?, id, ROW_NUMBER() OVER (ORDER BY created_at, id)
       FROM assessments WHERE course_id = ? AND status = 'published'`
    ).bind(offeringId, course.id),
    env.DB.prepare(
      `INSERT OR IGNORE INTO course_offering_materials (course_offering_id, material_id, position)
       SELECT ?, id, ROW_NUMBER() OVER (ORDER BY created_at, id)
       FROM course_materials WHERE course_id = ? AND status = 'published'`
    ).bind(offeringId, course.id),
    env.DB.prepare(
      `INSERT OR IGNORE INTO course_offering_flashcard_decks (course_offering_id, deck_id, position)
       SELECT ?, id, ROW_NUMBER() OVER (ORDER BY created_at, id)
       FROM flashcard_decks WHERE course_id = ? AND status = 'published'`
    ).bind(offeringId, course.id),
    env.DB.prepare(
      `INSERT OR IGNORE INTO audit_logs
        (id, actor_user_id, action, entity_type, entity_id, metadata_json, created_at)
       VALUES (?, ?, 'course.default_offering_created', 'course_offering', ?, ?, ?)`
    ).bind(
      `audit-default-offering-${course.id}`, actorUserId, offeringId,
      JSON.stringify({ courseId: course.id, source: "course_publish" }), now
    )
  ]);
  return { id: offeringId, created: !existing };
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
      (EXISTS(SELECT 1 FROM course_offering_assessments oa JOIN assessments a ON a.id = oa.assessment_id
        WHERE oa.course_offering_id = o.id AND a.assessment_type = 'quiz')
       OR EXISTS(SELECT 1 FROM course_offering_learning_products olp JOIN learning_products p ON p.id = olp.learning_product_id
        WHERE olp.course_offering_id = o.id AND p.status = 'published' AND p.product_type = 'quiz')) AS has_quizzes,
      (EXISTS(SELECT 1 FROM course_offering_assessments oa JOIN assessments a ON a.id = oa.assessment_id
        WHERE oa.course_offering_id = o.id AND a.assessment_type = 'test')
       OR EXISTS(SELECT 1 FROM course_offering_learning_products olp JOIN learning_products p ON p.id = olp.learning_product_id
        WHERE olp.course_offering_id = o.id AND p.status = 'published' AND p.product_type = 'test')) AS has_tests,
      (EXISTS(SELECT 1 FROM course_offering_assessments oa JOIN assessments a ON a.id = oa.assessment_id
        WHERE oa.course_offering_id = o.id AND a.assessment_type = 'mock_exam')
       OR EXISTS(SELECT 1 FROM course_offering_learning_products olp JOIN learning_products p ON p.id = olp.learning_product_id
        WHERE olp.course_offering_id = o.id AND p.status = 'published' AND p.product_type = 'mock_exam')) AS has_mock_exams
      ,(SELECT COUNT(*) FROM course_sessions s WHERE s.course_offering_id = o.id AND s.status = 'scheduled' AND s.delivery_mode = 'live_online') AS online_class_count
      ,(SELECT COUNT(*) FROM course_sessions s WHERE s.course_offering_id = o.id AND s.status = 'scheduled' AND s.delivery_mode = 'in_person') AS in_person_class_count
      ,((SELECT COUNT(*) FROM course_offering_materials om JOIN course_materials m ON m.id = om.material_id WHERE om.course_offering_id = o.id AND m.status = 'published' AND m.content_kind = 'ebook')
        + (SELECT COUNT(*) FROM course_offering_learning_products olp JOIN learning_products p ON p.id = olp.learning_product_id WHERE olp.course_offering_id = o.id AND p.status = 'published' AND p.product_type = 'ebook')) AS ebook_count
      ,((SELECT COUNT(*) FROM course_offering_materials om JOIN course_materials m ON m.id = om.material_id WHERE om.course_offering_id = o.id AND m.status = 'published' AND m.content_kind = 'reading')
        + (SELECT COUNT(*) FROM course_offering_learning_products olp JOIN learning_products p ON p.id = olp.learning_product_id WHERE olp.course_offering_id = o.id AND p.status = 'published' AND p.product_type = 'reading')) AS reading_count
      ,((SELECT COUNT(*) FROM course_offering_materials om JOIN course_materials m ON m.id = om.material_id WHERE om.course_offering_id = o.id AND m.status = 'published' AND m.content_kind = 'video')
        + (SELECT COUNT(*) FROM course_offering_learning_products olp JOIN learning_products p ON p.id = olp.learning_product_id WHERE olp.course_offering_id = o.id AND p.status = 'published' AND p.product_type = 'video')) AS video_count
      ,((SELECT COUNT(*) FROM course_offering_materials om JOIN course_materials m ON m.id = om.material_id WHERE om.course_offering_id = o.id AND m.status = 'published' AND m.content_kind = 'audio')
        + (SELECT COUNT(*) FROM course_offering_learning_products olp JOIN learning_products p ON p.id = olp.learning_product_id WHERE olp.course_offering_id = o.id AND p.status = 'published' AND p.product_type = 'audio')) AS audio_count
     FROM course_offerings o JOIN academic_terms t ON t.id = o.academic_term_id
      WHERE o.course_id = ? AND ${offeringCommerceReadySql("o")}
       AND (o.enrolment_opens_at IS NULL OR o.enrolment_opens_at <= ?)
       AND (o.enrolment_closes_at IS NULL OR o.enrolment_closes_at >= ?)
     ORDER BY COALESCE(o.starts_at, t.starts_at, o.created_at), o.title`
  ).bind(course.id, new Date().toISOString(), new Date().toISOString()).all();
  const learningProducts = await env.DB.prepare(
    `SELECT olp.course_offering_id, p.id, p.slug, p.title, p.product_type,
      p.description, p.estimated_minutes
     FROM course_offering_learning_products olp
     JOIN learning_products p ON p.id = olp.learning_product_id
     JOIN course_offerings o ON o.id = olp.course_offering_id
     WHERE o.course_id = ? AND ${offeringCommerceReadySql("o")} AND p.status = 'published'
     ORDER BY olp.position, p.title`
  ).bind(course.id).all();
  const syllabusRows = await env.DB.prepare(
    `SELECT m.id AS module_id, m.title AS module_title, m.position AS module_position,
      l.id AS lesson_id, l.title AS lesson_title, l.lesson_type, l.estimated_minutes,
      l.position AS lesson_position
     FROM course_modules m
     LEFT JOIN lessons l ON l.module_id = m.id
     WHERE m.course_id = ?
     ORDER BY m.position, m.created_at, l.position, l.created_at`
  ).bind(course.id).all<{
    module_id: string; module_title: string; module_position: number;
    lesson_id: string | null; lesson_title: string | null; lesson_type: string | null;
    estimated_minutes: number | null; lesson_position: number | null;
  }>();
  const syllabusModules = syllabusRows.results.reduce<Array<{
    id: string; title: string; position: number;
    lessons: Array<{ id: string; title: string; lesson_type: string; estimated_minutes: number | null; position: number }>;
  }>>((modules, row) => {
    let module = modules.find((item) => item.id === row.module_id);
    if (!module) {
      module = { id: row.module_id, title: row.module_title, position: row.module_position, lessons: [] };
      modules.push(module);
    }
    if (row.lesson_id && row.lesson_title && row.lesson_type) {
      module.lessons.push({
        id: row.lesson_id,
        title: row.lesson_title,
        lesson_type: row.lesson_type,
        estimated_minutes: row.estimated_minutes,
        position: row.lesson_position ?? module.lessons.length + 1
      });
    }
    return modules;
  }, []);
  const publishedAssessments = await env.DB.prepare(
    `SELECT id, title, assessment_type, time_limit_seconds
     FROM assessments WHERE course_id = ? AND status = 'published'
     ORDER BY created_at, title`
  ).bind(course.id).all();
  const publishedMaterials = await env.DB.prepare(
    `SELECT id, title, description, material_type, resource_kind, content_kind
     FROM course_materials WHERE course_id = ? AND status = 'published'
     ORDER BY created_at, title`
  ).bind(course.id).all();
  const publishedDecks = await env.DB.prepare(
    `SELECT d.id, d.title, d.description,
      (SELECT COUNT(*) FROM flashcards f WHERE f.deck_id = d.id) AS card_count
     FROM flashcard_decks d WHERE d.course_id = ? AND d.status = 'published'
     ORDER BY d.created_at, d.title`
  ).bind(course.id).all();
  return json({
    course,
    offerings: offerings.results,
    learningProducts: learningProducts.results,
    syllabus: {
      modules: syllabusModules,
      assessments: publishedAssessments.results,
      materials: publishedMaterials.results,
      flashcardDecks: publishedDecks.results
    }
  });
}

async function checkout(request: Request, env: ApiEnvironment): Promise<Response> {
  const traceId = request.headers.get("x-pencilscope-trace-id") ?? crypto.randomUUID();
  const form = await request.formData();
  const courseId = form.get("courseId");
  const offeringId = form.get("offeringId");
  const productOfferId = form.get("productOfferId");
  const requestedStudentId = form.get("studentId");
  const invitationToken = form.get("invitationToken");
  if ((!productOfferId || typeof productOfferId !== "string") && (typeof courseId !== "string" || !courseId)) {
    return problem(400, "invalid_course", "Choose a valid course.");
  }
  if ((!productOfferId || typeof productOfferId !== "string") && (typeof offeringId !== "string" || !offeringId)) {
    return problem(400, "invalid_offering", "Choose a valid course offering.");
  }
  const actorId = authenticatedUserId(request);
  if (!actorId) return problem(401, "authentication_required", "Sign in before enrolling.");
  const actor = await env.DB.prepare(
    `SELECT u.id, u.role, COALESCE(ap.account_type, 'individual') AS account_type
     FROM users u LEFT JOIN account_profiles ap ON ap.user_id = u.id
     WHERE u.id = ? AND u.status = 'active'`
  ).bind(actorId).first<{ id: string; role: string; account_type: "individual" | "organization" }>();
  if (!actor) return problem(401, "authentication_required", "Sign in before enrolling.");
  if (typeof requestedStudentId === "string" && requestedStudentId && requestedStudentId !== actor.id) {
    return problem(403, "self_enrolment_required", "Book this course using your own account.");
  }
  const studentId = actor.id;
  const parentUserId: string | null = null;

  if (typeof productOfferId === "string" && productOfferId) {
    const now = new Date().toISOString();
    const offer = await env.DB.prepare(
      `SELECT po.id, po.title, po.stripe_price_id, po.capacity, po.commerce_course_id,
         po.commerce_offering_id
       FROM product_offers po
       WHERE po.id = ? AND po.status = 'published' AND po.pricing_status = 'ready'
         AND po.stripe_price_id IS NOT NULL AND po.price_cents >= 50
         AND (po.enrolment_opens_at IS NULL OR po.enrolment_opens_at <= ?)
         AND (po.enrolment_closes_at IS NULL OR po.enrolment_closes_at >= ?)
       LIMIT 1`
    ).bind(productOfferId, now, now).first<{
      id: string; title: string; stripe_price_id: string; capacity: number | null;
      commerce_course_id: string; commerce_offering_id: string;
    }>();
    if (!offer) return problem(404, "offer_not_found", "This product offer is not available.");
    const existing = await env.DB.prepare(
      `SELECT id FROM enrolment_offerings WHERE course_offering_id = ?
       AND student_user_id = ? AND status IN ('active', 'completed')`
    ).bind(offer.commerce_offering_id, studentId).first();
    if (existing) return problem(409, "already_enrolled", "You already have access to this offer.");
    if (offer.capacity !== null) {
      const occupancy = await env.DB.prepare(
        `SELECT COUNT(*) AS total FROM enrolment_offerings WHERE course_offering_id = ? AND status IN ('active', 'completed')`
      ).bind(offer.commerce_offering_id).first<{ total: number }>();
      if (Number(occupancy?.total ?? 0) >= offer.capacity) return problem(409, "offering_full", "This offer has reached its capacity.");
    }
    try {
      const stripe = createStripe(requireSecret(env, "STRIPE_SECRET_KEY"));
      const session = await stripe.checkout.sessions.create({
        mode: "payment",
        line_items: [{ price: offer.stripe_price_id, quantity: 1 }],
        success_url: `${env.APP_URL}/offers/product-${offer.id}?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${env.APP_URL}/offers/product-${offer.id}?checkout=cancelled`,
        metadata: {
          courseId: offer.commerce_course_id,
          offeringId: offer.commerce_offering_id,
          productOfferId: offer.id,
          stripePriceId: offer.stripe_price_id,
          studentUserId: studentId,
          parentUserId: ""
        }
      });
      if (!session.url) return problem(502, "stripe_error", "Stripe did not return a checkout URL.");
      return Response.redirect(session.url, 303);
    } catch (error) {
      console.error("product_offer.checkout.failed", { traceId, productOfferId, error });
      return problem(502, "checkout_failed", "Checkout is temporarily unavailable.");
    }
  }

  const course = await env.DB.prepare(
    `SELECT c.id, c.slug, o.id AS offering_id, o.stripe_price_id, o.capacity
     FROM courses c JOIN course_offerings o ON o.course_id = c.id
      WHERE c.id = ? AND o.id = ? AND c.status = 'published' AND c.listing_status = 'listed'
        AND ${offeringCommerceReadySql("o")}
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

  let invitationId: string | null = null;
  if (typeof invitationToken === "string" && invitationToken) {
    const invitation = await validInvitationForCheckout(
      env.DB,
      invitationToken,
      actor.id,
      course.id,
      course.offering_id
    );
    if (!invitation) {
      return problem(403, "invalid_invitation", "This invitation is invalid, expired, or belongs to another account.");
    }
    invitationId = invitation.id;
  }

  try {
    const stripe = createStripe(requireSecret(env, "STRIPE_SECRET_KEY"));
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      line_items: [{ price: course.stripe_price_id, quantity: 1 }],
      success_url: invitationToken
        ? `${env.APP_URL}/invite/${encodeURIComponent(String(invitationToken))}?checkout=success&session_id={CHECKOUT_SESSION_ID}`
        : `${env.APP_URL}/courses/${course.slug}?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: invitationToken
        ? `${env.APP_URL}/invite/${encodeURIComponent(String(invitationToken))}?checkout=cancelled`
        : `${env.APP_URL}/courses/${course.slug}?checkout=cancelled`,
      metadata: {
        courseId: course.id,
        offeringId: course.offering_id,
        stripePriceId: course.stripe_price_id,
        studentUserId: studentId,
        parentUserId: parentUserId ?? "",
        invitationId: invitationId ?? ""
      }
    });
    if (!session.url) {
      console.error("checkout.redirect.missing", { traceId, courseId, offeringId });
      return problem(502, "stripe_error", "Stripe did not return a checkout URL.");
    }
    console.info("checkout.created", { traceId, courseId, offeringId, actorId });
    return Response.redirect(session.url, 303);
  } catch (error) {
    console.error("checkout.create.failed", { traceId, courseId, offeringId, error });
    return problem(502, "checkout_failed", "Checkout is temporarily unavailable.");
  }
}

async function checkoutStatus(request: Request, env: ApiEnvironment): Promise<Response> {
  const actorId = authenticatedUserId(request);
  if (!actorId) return problem(401, "authentication_required", "Sign in to confirm your enrolment.");
  const sessionId = new URL(request.url).searchParams.get("sessionId")?.trim() ?? "";
  if (!/^cs_[A-Za-z0-9_]+$/.test(sessionId) || sessionId.length > 255) {
    return problem(400, "invalid_checkout_session", "Choose a valid checkout session.");
  }
  const enrolment = await env.DB.prepare(
    `SELECT e.id AS enrolment_id, e.course_id, eo.course_offering_id,
      c.slug AS course_slug, c.title AS course_title, co.title AS offering_title,
      ((SELECT COUNT(*) FROM course_offering_learning_products olp
        WHERE olp.course_offering_id = eo.course_offering_id)
       + COALESCE((SELECT COUNT(*) FROM product_offer_course_items ci
         WHERE ci.product_offer_id = o.product_offer_id), 0)) AS product_count
     FROM orders o
     JOIN enrolments e ON e.order_id = o.id AND e.student_user_id = o.student_user_id
     JOIN enrolment_offerings eo ON eo.order_id = o.id AND eo.enrolment_id = e.id
     JOIN courses c ON c.id = e.course_id
     JOIN course_offerings co ON co.id = eo.course_offering_id
     WHERE o.stripe_checkout_session_id = ? AND o.student_user_id = ?
       AND o.status = 'paid' AND e.status IN ('active', 'completed')
       AND eo.status IN ('active', 'completed')
     LIMIT 1`
  ).bind(sessionId, actorId).first<{
    enrolment_id: string; course_id: string; course_offering_id: string;
    course_slug: string; course_title: string; offering_title: string; product_count: number;
  }>();
  if (!enrolment) return json({ status: "pending" });
  return json({
    status: "confirmed",
    enrolmentId: enrolment.enrolment_id,
    courseId: enrolment.course_id,
    offeringId: enrolment.course_offering_id,
    courseSlug: enrolment.course_slug,
    courseTitle: enrolment.course_title,
    offeringTitle: enrolment.offering_title,
    productCount: Number(enrolment.product_count ?? 0)
  });
}

async function recordCompletedCheckout(env: ApiEnvironment, session: Stripe.Checkout.Session): Promise<void> {
  const db = env.DB;
  if (session.payment_status !== "paid") {
    throw new Error("Checkout payment is not confirmed");
  }
  const courseId = session.metadata?.courseId;
  const offeringId = session.metadata?.offeringId;
  const studentUserId = session.metadata?.studentUserId;
  const parentUserId = session.metadata?.parentUserId || null;
  if (!courseId || !offeringId || !studentUserId) throw new Error("Checkout session is missing enrolment metadata");
  const now = new Date().toISOString();
  const existingOrder = await db.prepare(
    "SELECT id FROM orders WHERE stripe_checkout_session_id = ?"
  ).bind(session.id).first<{ id: string }>();
  const orderId = existingOrder?.id ?? crypto.randomUUID();
  const existingEnrolment = await db.prepare(
    "SELECT id FROM enrolments WHERE course_id = ? AND student_user_id = ?"
  ).bind(courseId, studentUserId).first<{ id: string }>();
  const enrolmentId = existingEnrolment?.id ?? crypto.randomUUID();
  const enrolmentOfferingId = crypto.randomUUID();
  await db.batch([
    db.prepare(
      `INSERT INTO orders (id, parent_user_id, student_user_id, course_id, course_offering_id, product_offer_id,
      stripe_checkout_session_id, stripe_payment_intent_id, stripe_price_id, amount_cents, currency, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'paid', ?, ?)
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
      session.metadata?.productOfferId || null,
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
    ).bind(studentUserId, now, offeringId),
    db.prepare(
      `INSERT OR IGNORE INTO payment_transactions
        (id, order_id, provider, provider_transaction_id, transaction_type,
         amount_cents, currency, status, metadata_json, occurred_at, created_at)
       VALUES (?, ?, 'stripe', ?, 'payment', ?, ?, 'paid', ?, ?, ?)`
    ).bind(
      crypto.randomUUID(),
      orderId,
      typeof session.payment_intent === "string" ? session.payment_intent : session.id,
      session.amount_total ?? 0,
      (session.currency ?? "sgd").toUpperCase(),
      JSON.stringify({ checkoutSessionId: session.id }),
      now,
      now
    ),
    db.prepare(
      `INSERT OR IGNORE INTO payment_lifecycle_events
        (id, order_id, event_type, status, title, detail, provider_event_id,
         metadata_json, occurred_at, created_at)
       VALUES (?, ?, 'payment_confirmed', 'paid', 'Payment confirmed',
         'Your payment was received securely.', ?, ?, ?, ?)`
    ).bind(
      `payment-confirmed-${orderId}`,
      orderId,
      typeof session.payment_intent === "string" ? session.payment_intent : session.id,
      JSON.stringify({ checkoutSessionId: session.id }),
      now,
      now
    ),
    db.prepare(
      `INSERT OR IGNORE INTO payment_lifecycle_events
        (id, order_id, event_type, status, title, detail, provider_event_id,
         metadata_json, occurred_at, created_at)
       VALUES (?, ?, 'enrolment_created', 'active', 'Access granted',
         'Your enrolment or booking is available.', NULL, '{}', ?, ?)`
    ).bind(`enrolment-created-${orderId}`, orderId, now, now),
    db.prepare(
      `UPDATE course_invitations SET status = 'converted', converted_student_user_id = ?,
       converted_at = ?, updated_at = ?
       WHERE id = ? AND course_id = ? AND course_offering_id = ?
         AND status IN ('pending', 'opened', 'registered')`
    ).bind(studentUserId, now, now, session.metadata?.invitationId || "__no_invitation__", courseId, offeringId)
  ]);
  const productOfferId = session.metadata?.productOfferId;
  if (productOfferId) {
    const includedCourses = await db.prepare(
      `SELECT ci.course_id, ci.course_offering_id
       FROM product_offer_course_items ci JOIN product_offers po ON po.id = ci.product_offer_id
       WHERE ci.product_offer_id = ? AND po.commerce_offering_id = ? ORDER BY ci.position`
    ).bind(productOfferId, offeringId).all<{ course_id: string; course_offering_id: string }>();
    for (const included of includedCourses.results) {
      const existingIncludedEnrolment = await db.prepare(
        "SELECT id FROM enrolments WHERE course_id = ? AND student_user_id = ?"
      ).bind(included.course_id, studentUserId).first<{ id: string }>();
      const includedEnrolmentId = existingIncludedEnrolment?.id ?? crypto.randomUUID();
      await db.batch([
        db.prepare(
          `INSERT INTO enrolments (id, course_id, student_user_id, order_id, status, enrolled_at)
           VALUES (?, ?, ?, ?, 'active', ?)
           ON CONFLICT(course_id, student_user_id) DO UPDATE SET order_id = excluded.order_id,
             status = 'active', enrolled_at = excluded.enrolled_at, completed_at = NULL`
        ).bind(includedEnrolmentId, included.course_id, studentUserId, orderId, now),
        db.prepare(
          `INSERT INTO enrolment_offerings
            (id, enrolment_id, course_offering_id, student_user_id, order_id, status, enrolled_at)
           VALUES (?, ?, ?, ?, ?, 'active', ?)
           ON CONFLICT(course_offering_id, student_user_id) DO UPDATE SET
             enrolment_id = excluded.enrolment_id, order_id = excluded.order_id,
             status = 'active', enrolled_at = excluded.enrolled_at, completed_at = NULL`
        ).bind(crypto.randomUUID(), includedEnrolmentId, included.course_offering_id, studentUserId, orderId, now),
        db.prepare(
          `INSERT OR IGNORE INTO course_session_attendance
            (course_session_id, student_user_id, status, updated_at)
           SELECT id, ?, 'registered', ? FROM course_sessions
           WHERE course_offering_id = ? AND status = 'scheduled'`
        ).bind(studentUserId, now, included.course_offering_id)
      ]);
    }
  }
  await ensureCreatorEarningForOrder(env, orderId);

  if (env.STRIPE_SECRET_KEY && typeof session.payment_intent === "string") {
    try {
      const stripe = createStripe(env.STRIPE_SECRET_KEY);
      const intent = await stripe.paymentIntents.retrieve(session.payment_intent, {
        expand: ["latest_charge.balance_transaction"]
      });
      const charge = typeof intent.latest_charge === "object" ? intent.latest_charge : null;
      const balanceTransactionReference = charge?.balance_transaction;
      const balanceTransaction = typeof balanceTransactionReference === "object"
        ? balanceTransactionReference
        : typeof balanceTransactionReference === "string"
          ? await stripe.balanceTransactions.retrieve(balanceTransactionReference)
          : null;
      if (charge && balanceTransaction) {
        await recordStripeProcessingFee(env, charge, balanceTransaction.fee);
      }
    } catch (error) {
      console.warn("settlement.processing_fee_lookup_failed", { orderId, error });
    }
  }
}

async function stripeWebhook(request: Request, env: ApiEnvironment): Promise<Response> {
  const signature = request.headers.get("stripe-signature");
  if (!signature) return problem(400, "missing_signature", "Missing Stripe signature.");

  let event: Stripe.Event;
  let stripe: Stripe;
  try {
    const payload = await request.text();
    stripe = createStripe(requireSecret(env, "STRIPE_SECRET_KEY"));
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
    if (event.type === "checkout.session.completed" && event.data.object.payment_status === "paid") {
      const handledStorage = await processStorageCheckout(env, stripe, event.data.object, event.id);
      if (!handledStorage) await recordCompletedCheckout(env, event.data.object);
    }
    if (event.type === "checkout.session.async_payment_succeeded") {
      const handledStorage = await processStorageCheckout(env, stripe, event.data.object, event.id);
      if (!handledStorage) await recordCompletedCheckout(env, event.data.object);
    }
    if (event.type === "customer.subscription.created" || event.type === "customer.subscription.updated" || event.type === "customer.subscription.deleted") {
      await syncStorageSubscription(env, event.data.object, event.id);
    }
    if (event.type === "charge.succeeded") {
      const charge = event.data.object;
      const balanceTransaction = typeof charge.balance_transaction === "object"
        ? charge.balance_transaction
        : charge.balance_transaction
          ? await stripe.balanceTransactions.retrieve(charge.balance_transaction)
          : null;
      if (balanceTransaction) await recordStripeProcessingFee(env, charge, balanceTransaction.fee);
    }
    if (event.type === "charge.refunded") {
      await recordStripeRefund(env, event.data.object);
    }
    if (event.type === "charge.dispute.created") {
      await recordStripeDispute(env, event.data.object, false);
    }
    if (event.type === "charge.dispute.closed") {
      await recordStripeDispute(env, event.data.object, true);
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
  let breakdown = { checkoutPriceCents: 0, creatorPriceCents: 0 };
  if (input.priceCents > 0) {
    try {
      breakdown = calculateOfferingPrice(env, input.priceCents);
    } catch (error) {
      return problem(400, "invalid_price", error instanceof Error ? error.message : "Invalid course price.");
    }
  }
  const course: CoursePricingRecord = {
    id,
    title: input.title,
    description: input.description,
    price_cents: breakdown.checkoutPriceCents,
    currency: input.currency,
    pricing_version: 1,
    stripe_product_id: null,
    stripe_price_id: null
  };

  const statements = [env.DB.prepare(
    `INSERT INTO courses
      (id, tutor_id, slug, title, description, subject, primary_level, delivery_mode,
       price_cents, creator_price_cents, currency, status, pricing_status, pricing_version, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', 'pending', 1, ?, ?)`
  ).bind(
    id, actor.id, slug, input.title, input.description, input.subject,
    input.primaryLevel, input.deliveryMode, breakdown.checkoutPriceCents,
    breakdown.creatorPriceCents, input.currency, now, now
  ), env.DB.prepare(
    `INSERT INTO course_members
      (course_id, user_id, member_role, status, created_at, updated_at)
     VALUES (?, ?, 'owner', 'active', ?, ?)`
  ).bind(id, actor.id, now, now), env.DB.prepare(
    `INSERT INTO audit_logs
      (id, actor_user_id, action, entity_type, entity_id, metadata_json, created_at)
     VALUES (?, ?, 'course.created', 'course', ?, ?, ?)`
  ).bind(crypto.randomUUID(), actor.id, id, JSON.stringify({ title: input.title }), now)];
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
    const defaultOffering = await ensureDefaultCourseOffering(env, {
      ...course,
      creator_price_cents: breakdown.creatorPriceCents,
      delivery_mode: input.deliveryMode,
      pricing_status: "ready",
      stripe_product_id: pricing.stripeProductId,
      stripe_price_id: pricing.stripePriceId
    }, actor.id);
    await env.DB.prepare(
      `INSERT INTO audit_logs
        (id, actor_user_id, action, entity_type, entity_id, metadata_json, created_at)
       VALUES (?, ?, 'course.published', 'course', ?, '{}', ?)`
    ).bind(crypto.randomUUID(), actor.id, course.id, new Date().toISOString()).run();
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
        stripePriceId: pricing.stripePriceId,
        defaultOfferingId: defaultOffering.id
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
  delivery_mode: string;
  status: string;
  pricing_status: string;
  creator_price_cents: number;
};

async function publishCourse(request: Request, env: ApiEnvironment, id: string): Promise<Response> {
  const actor = await getCreatorActorById(authenticatedUserId(request), env.DB);
  if (!actor) return problem(401, "authentication_required", "Sign in to manage this course.");

  const course = await env.DB.prepare(
    `SELECT id, tutor_id, slug, title, description, delivery_mode, price_cents, creator_price_cents, currency, status,
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
    const defaultOffering = await ensureDefaultCourseOffering(env, course, actor.id);
    return json({
      course: {
        id: course.id,
        slug: course.slug,
        status: course.status,
        pricingStatus: course.pricing_status,
        defaultOfferingId: defaultOffering.id
      }
    });
  }

  try {
    const breakdown = calculateOfferingPrice(env, course.creator_price_cents || course.price_cents);
    const pricedCourse: PublishableCourse = { ...course, price_cents: breakdown.checkoutPriceCents };
    await env.DB.prepare(
      "UPDATE courses SET price_cents = ?, creator_price_cents = ?, pricing_status = 'syncing', updated_at = ? WHERE id = ?"
    ).bind(pricedCourse.price_cents, breakdown.creatorPriceCents, new Date().toISOString(), course.id).run();
    const stripeSecret = requireSecret(env, "STRIPE_SECRET_KEY");
    const pricing = await syncCoursePricing(stripeSecret, pricedCourse);
    await persistSyncedCoursePricing(env.DB, pricedCourse, pricing, true);
    const defaultOffering = await ensureDefaultCourseOffering(env, {
      ...pricedCourse,
      pricing_status: "ready",
      stripe_product_id: pricing.stripeProductId,
      stripe_price_id: pricing.stripePriceId
    }, actor.id);
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
        stripePriceId: pricing.stripePriceId,
        defaultOfferingId: defaultOffering.id
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
  let breakdown;
  try {
    breakdown = calculateOfferingPrice(env, Number(payload.priceCents));
  } catch (error) {
    return problem(400, "invalid_price", error instanceof Error ? error.message : "Invalid course price.");
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
  if (current.status !== "draft") {
    return problem(409, "draft_version_required", "Published course pricing is immutable. Create a new version to change it.");
  }

  const next: CoursePricingRecord = {
    ...current,
    price_cents: breakdown.checkoutPriceCents,
    currency: "SGD",
    pricing_version: current.pricing_version + 1
  };

  await env.DB.prepare(
      `UPDATE courses SET price_cents = ?, creator_price_cents = ?, currency = ?, pricing_version = ?,
       pricing_status = 'pending', updated_at = ? WHERE id = ?`
    ).bind(
      next.price_cents,
      breakdown.creatorPriceCents,
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
  if (!Number.isSafeInteger(offering.price_cents) || offering.price_cents < 50) {
    return problem(409, "offering_price_required", "Set a valid offer price before publishing.");
  }
  const readiness = await env.DB.prepare(
    `SELECT o.status,
      ${offeringContentCountSql("o")} AS content_count,
      (SELECT COUNT(*) FROM course_offering_learning_products olp
        JOIN learning_products p ON p.id = olp.learning_product_id
        WHERE olp.course_offering_id = o.id AND (p.status != 'published' OR p.listing_status != 'listed')) AS unavailable_products,
      (SELECT COUNT(*) FROM course_offering_learning_products olp
        JOIN learning_products p ON p.id = olp.learning_product_id
        WHERE olp.course_offering_id = o.id AND NOT ${learningProductDataReadySql("p")}) AS incomplete_products,
      ${offeringProductsReadySql("o")} AS products_ready
     FROM course_offerings o WHERE o.id = ?`
  ).bind(id).first<{ status: string; content_count: number; unavailable_products: number; incomplete_products: number; products_ready: number }>();
  if (readiness?.status !== "draft") {
    return problem(409, "draft_offering_required", "Only a draft offer can be published. Create a new version for pricing or content changes.");
  }
  if (Number(readiness.content_count) < 1) {
    return problem(409, "offering_content_required", "Add at least one product, course module, resource, assessment, deck or class session before publishing.");
  }
  if (Number(readiness.unavailable_products) > 0) {
    return problem(409, "published_products_required", "Publish every product in this bundle before publishing the offer.");
  }
  if (Number(readiness.incomplete_products) > 0 || !Number(readiness.products_ready)) {
    return problem(409, "complete_products_required", "Complete the required title, description, topic, audience, duration and format-specific content for every product before publishing the offer.");
  }
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
    const requestedPathname = url.pathname;
    const pathname = requestedPathname.length > 1
      ? requestedPathname.replace(/\/+$/, "")
      : requestedPathname;

    if (request.method === "GET" && pathname === "/api/health") return health(env);
    const contactEnquiryResponse = await handleContactEnquiryRequest(request, env, pathname);
    if (contactEnquiryResponse) return contactEnquiryResponse;
    const mcpOAuthResponse = await handleMcpOAuthRequest(request, env, pathname);
    if (mcpOAuthResponse) return mcpOAuthResponse;
    await touchActiveSession(request, env);
    const routeSource = request.headers.get("x-pencilscope-route-source");
    if (request.method === "GET" && pathname === "/api/checkout/status") {
      return checkoutStatus(request, env);
    }
    if (request.method === "POST" && (pathname === "/api/checkout" || routeSource === "web-checkout")) {
      if (pathname !== "/api/checkout") {
        console.warn("checkout.route_recovered", {
          traceId: request.headers.get("x-pencilscope-trace-id"),
          requestedPathname,
          normalizedPathname: pathname
        });
      }
      return checkout(request, env);
    }
    const oauthResponse = await handleOAuthRequest(request, env, pathname);
    if (oauthResponse) return oauthResponse;
    const navigationMediaResponse = await handleNavigationMediaRequest(request, env, pathname);
    if (navigationMediaResponse) return navigationMediaResponse;
    const creatorLibraryUploadResponse = await handleCreatorLibraryUploadRequest(request, env, pathname);
    if (creatorLibraryUploadResponse) return creatorLibraryUploadResponse;
    const creatorLibraryResponse = await handleCreatorLibraryRequest(request, env, pathname);
    if (creatorLibraryResponse) return creatorLibraryResponse;
    const storageSubscriptionResponse = await handleStorageSubscriptionRequest(request, env, pathname);
    if (storageSubscriptionResponse) return storageSubscriptionResponse;
    const googleMeetResponse = await handleGoogleMeetRequest(request, env, pathname);
    if (googleMeetResponse) return googleMeetResponse;
    const settlementResponse = await handleSettlementRequest(request, env, pathname);
    if (settlementResponse) return settlementResponse;
    const payoutResponse = await handlePayoutRequest(request, env, pathname);
    if (payoutResponse) return payoutResponse;
    const collaborationResponse = await handleCollaborationRequest(request, env, pathname);
    if (collaborationResponse) return collaborationResponse;
    const actionHistoryResponse = await handleActionHistoryRequest(request, env, pathname);
    if (actionHistoryResponse) return actionHistoryResponse;
    const operationsResponse = await handleOperationsRequest(request, env, pathname);
    if (operationsResponse) return operationsResponse;
    const contentAuthoringResponse = await handleContentAuthoringRequest(request, env, pathname);
    if (contentAuthoringResponse) return contentAuthoringResponse;
    const invitationResponse = await handleInvitationRequest(request, env, pathname);
    if (invitationResponse) return invitationResponse;
    const journeyResponse = await handleJourneyRequest(request, env, pathname);
    if (journeyResponse) return journeyResponse;
    const learningProductResponse = await handleLearningProductRequest(request, env, pathname);
    if (learningProductResponse) return learningProductResponse;
    const marketplaceOfferResponse = await handleMarketplaceOfferRequest(request, env, pathname);
    if (marketplaceOfferResponse) return marketplaceOfferResponse;
    const productOfferResponse = await handleProductOfferRequest(request, env, pathname);
    if (productOfferResponse) return productOfferResponse;
    if (request.method === "GET" && pathname === "/api/courses") return courses(env);
    const offeringListMatch = pathname.match(/^\/api\/courses\/([^/]+)\/offerings$/);
    if (request.method === "GET" && offeringListMatch) {
      return courseOfferingsBySlug(env, decodeURIComponent(offeringListMatch[1]));
    }
    if (request.method === "GET" && pathname.startsWith("/api/courses/")) {
      return courseBySlug(env, decodeURIComponent(pathname.slice("/api/courses/".length)));
    }
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

    console.warn("api.route_not_found", {
      traceId: request.headers.get("x-pencilscope-trace-id"),
      routeSource: request.headers.get("x-pencilscope-route-source"),
      method: request.method,
      pathname: requestedPathname,
      normalizedPathname: pathname
    });
    return problem(404, "not_found", "API route not found.");
  },
  async scheduled(_controller, env, ctx): Promise<void> {
    ctx.waitUntil(Promise.all([
      reconcileCreatorSettlements(env),
      sendSessionReminders(env),
      purgeExpiredLibraryItems(env)
    ]).then(() => undefined));
  }
} satisfies ExportedHandler<ApiEnvironment>;
