import { getCreatorActorById } from "../../../src/lib/auth";
import {
  isAssessmentProduct,
  isLearningProductType,
  type LearningProductQuestion,
  type LearningProductType
} from "../../../src/lib/learning-products";
import { json, problem } from "../../../src/lib/http";
import type { ApiEnvironment } from "./index";
import {
  questionMediaInsert,
  resolveQuestionMedia,
  serveQuestionMediaVersion,
  type ResolvedQuestionMedia
} from "./question-media";

function userId(request: Request): string | null {
  return request.headers.get("x-pencilscope-user-id")?.trim() || null;
}

function decodeSegment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function slugify(value: string): string {
  return value.toLowerCase().trim()
    .normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 70) || "learning-product";
}

async function uniqueSlug(db: D1Database, title: string): Promise<string> {
  const base = slugify(title);
  let candidate = base;
  for (let suffix = 2; suffix < 100; suffix += 1) {
    const existing = await db.prepare("SELECT 1 FROM learning_products WHERE slug = ?").bind(candidate).first();
    if (!existing) return candidate;
    candidate = `${base}-${suffix}`;
  }
  return `${base}-${crypto.randomUUID().slice(0, 8)}`;
}

type StoredProduct = {
  id: string;
  creator_id: string;
  creator_name: string;
  slug: string;
  product_type: LearningProductType;
  title: string;
  description: string;
  subject: string;
  audience: string;
  language_code: string;
  content_url: string | null;
  content_json: string;
  estimated_minutes: number | null;
  price_cents: number;
  currency: string;
  status: "draft" | "published" | "archived";
  listing_status: "listed" | "unpublished";
  source_product_id: string | null;
  content_version: number;
  published_at: string | null;
  created_at: string;
  updated_at: string;
  owned?: number;
  has_access?: number;
  offer_course_slug?: string | null;
  offer_title?: string | null;
  offer_price_cents?: number | null;
  product_offer_id?: string | null;
  primary_mime_type?: string | null;
  primary_original_filename?: string | null;
  resource_count?: number | null;
};

function parseQuestions(contentJson: string): LearningProductQuestion[] {
  try {
    const value = JSON.parse(contentJson) as { questions?: unknown };
    return Array.isArray(value.questions) ? value.questions as LearningProductQuestion[] : [];
  } catch {
    return [];
  }
}

function publicProduct(product: StoredProduct, includeAnswers = false, includeContent = false) {
  const questions = parseQuestions(product.content_json);
  let assessmentConfig: { passingScore?: number; timeLimitMinutes?: number | null } = {};
  try {
    assessmentConfig = JSON.parse(product.content_json) as typeof assessmentConfig;
  } catch {
    assessmentConfig = {};
  }
  return {
    ...product,
    content_json: undefined,
    content_url: includeContent ? product.content_url : null,
    has_access: Boolean(product.has_access || includeContent),
    question_count: questions.length,
    questions: includeContent && isAssessmentProduct(product.product_type)
      ? questions.map((question) => ({
          id: question.id,
          prompt: question.prompt,
          options: question.options,
          ...(question.media ? { media: {
            ...question.media,
            contentUrl: `/api/learning-products/${encodeURIComponent(product.slug)}/questions/${encodeURIComponent(question.id ?? "")}/media`
          } } : {}),
          ...(includeAnswers ? { correctIndex: question.correctIndex, explanation: question.explanation } : {})
        }))
      : undefined,
    ...(includeAnswers && isAssessmentProduct(product.product_type) ? {
      passing_score: assessmentConfig.passingScore ?? 50,
      time_limit_minutes: assessmentConfig.timeLimitMinutes ?? null
    } : {})
  };
}

const pricedPublishedOffer = `(p.listing_status = 'listed' AND (EXISTS (
  SELECT 1 FROM course_offering_learning_products gate_olp
  JOIN course_offerings gate_o ON gate_o.id = gate_olp.course_offering_id
  JOIN courses gate_c ON gate_c.id = gate_o.course_id
  WHERE gate_olp.learning_product_id = p.id
    AND gate_o.status = 'published' AND gate_o.pricing_status = 'ready'
    AND gate_o.stripe_price_id IS NOT NULL AND gate_o.price_cents >= 50
    AND gate_c.status = 'published' AND gate_c.listing_status = 'listed'
) OR EXISTS (
  SELECT 1 FROM product_offer_items gate_pi JOIN product_offers gate_po ON gate_po.id = gate_pi.product_offer_id
  WHERE gate_pi.learning_product_id = p.id AND gate_po.status = 'published'
    AND gate_po.pricing_status = 'ready' AND gate_po.stripe_price_id IS NOT NULL
    AND gate_po.price_cents >= 50
    AND (gate_po.enrolment_opens_at IS NULL OR gate_po.enrolment_opens_at <= datetime('now'))
    AND (gate_po.enrolment_closes_at IS NULL OR gate_po.enrolment_closes_at >= datetime('now'))
)))`;

const productSelect = `SELECT p.*, COALESCE(NULLIF(u.display_name, ''), 'PencilScope creator') AS creator_name,
  (SELECT gate_po.id FROM product_offer_items gate_pi JOIN product_offers gate_po ON gate_po.id = gate_pi.product_offer_id
    WHERE gate_pi.learning_product_id = p.id AND gate_po.status = 'published'
      AND gate_po.pricing_status = 'ready' AND gate_po.stripe_price_id IS NOT NULL AND gate_po.price_cents >= 50
    ORDER BY gate_po.published_at DESC LIMIT 1) AS product_offer_id,
  (SELECT gate_c.slug FROM course_offering_learning_products gate_olp
    JOIN course_offerings gate_o ON gate_o.id = gate_olp.course_offering_id
    JOIN courses gate_c ON gate_c.id = gate_o.course_id
    WHERE gate_olp.learning_product_id = p.id AND gate_o.status = 'published'
      AND gate_o.pricing_status = 'ready' AND gate_o.stripe_price_id IS NOT NULL
      AND gate_o.price_cents >= 50 AND gate_c.status = 'published' AND gate_c.listing_status = 'listed'
    ORDER BY gate_o.created_at DESC LIMIT 1) AS offer_course_slug,
  COALESCE((SELECT gate_po.title FROM product_offer_items gate_pi JOIN product_offers gate_po ON gate_po.id = gate_pi.product_offer_id
    WHERE gate_pi.learning_product_id = p.id AND gate_po.status = 'published'
      AND gate_po.pricing_status = 'ready' AND gate_po.stripe_price_id IS NOT NULL AND gate_po.price_cents >= 50
    ORDER BY gate_po.published_at DESC LIMIT 1), (SELECT gate_o.title FROM course_offering_learning_products gate_olp
    JOIN course_offerings gate_o ON gate_o.id = gate_olp.course_offering_id
    JOIN courses gate_c ON gate_c.id = gate_o.course_id
    WHERE gate_olp.learning_product_id = p.id AND gate_o.status = 'published'
      AND gate_o.pricing_status = 'ready' AND gate_o.stripe_price_id IS NOT NULL
      AND gate_o.price_cents >= 50 AND gate_c.status = 'published' AND gate_c.listing_status = 'listed'
    ORDER BY gate_o.created_at DESC LIMIT 1)) AS offer_title,
  COALESCE((SELECT gate_po.price_cents FROM product_offer_items gate_pi JOIN product_offers gate_po ON gate_po.id = gate_pi.product_offer_id
    WHERE gate_pi.learning_product_id = p.id AND gate_po.status = 'published'
      AND gate_po.pricing_status = 'ready' AND gate_po.stripe_price_id IS NOT NULL AND gate_po.price_cents >= 50
    ORDER BY gate_po.published_at DESC LIMIT 1), (SELECT gate_o.price_cents FROM course_offering_learning_products gate_olp
    JOIN course_offerings gate_o ON gate_o.id = gate_olp.course_offering_id
    JOIN courses gate_c ON gate_c.id = gate_o.course_id
    WHERE gate_olp.learning_product_id = p.id AND gate_o.status = 'published'
      AND gate_o.pricing_status = 'ready' AND gate_o.stripe_price_id IS NOT NULL
      AND gate_o.price_cents >= 50 AND gate_c.status = 'published' AND gate_c.listing_status = 'listed'
    ORDER BY gate_o.created_at DESC LIMIT 1)) AS offer_price_cents
  FROM learning_products p JOIN users u ON u.id = p.creator_id`;

async function listProducts(request: Request, env: ApiEnvironment): Promise<Response> {
  const url = new URL(request.url);
  const requestedType = url.searchParams.get("type");
  if (requestedType && !isLearningProductType(requestedType)) {
    return problem(400, "invalid_product_type", "Choose a valid learning product type.");
  }
  const result = requestedType
    ? await env.DB.prepare(`${productSelect} WHERE p.status = 'published' AND ${pricedPublishedOffer}
        AND p.product_type = ?
        ORDER BY p.published_at DESC, p.title`).bind(requestedType).all<StoredProduct>()
    : await env.DB.prepare(`${productSelect} WHERE p.status = 'published' AND ${pricedPublishedOffer}
        ORDER BY p.published_at DESC, p.title`).all<StoredProduct>();
  return json({ products: result.results.map((product) => publicProduct(product)) });
}

async function productBySlug(request: Request, env: ApiEnvironment, slug: string): Promise<Response> {
  const actor = await getCreatorActorById(userId(request), env.DB);
  const actorId = actor?.id ?? "";
  const now = new Date().toISOString();
  const product = await env.DB.prepare(
    `${productSelect} WHERE p.slug = ? AND p.status = 'published'
      AND (${pricedPublishedOffer} OR p.creator_id = ?
        OR EXISTS (SELECT 1 FROM learning_product_entitlements e
          WHERE e.learning_product_id = p.id AND e.user_id = ? AND e.status IN ('active', 'completed'))
        OR EXISTS (SELECT 1 FROM course_offering_learning_products olp
          JOIN enrolment_offerings eo ON eo.course_offering_id = olp.course_offering_id
          JOIN course_offerings o ON o.id = eo.course_offering_id
          WHERE olp.learning_product_id = p.id AND eo.student_user_id = ? AND eo.status = 'active'
            AND (o.access_ends_at IS NULL OR o.access_ends_at >= ?)))`
  ).bind(slug, actorId, actorId, actorId, now).first<StoredProduct>();
  if (!product) return problem(404, "learning_product_not_found", "This learning product does not exist.");
  const access = actor ? await env.DB.prepare(
    `SELECT 1 WHERE ? = ?
      OR EXISTS (SELECT 1 FROM learning_product_entitlements e
        WHERE e.learning_product_id = ? AND e.user_id = ? AND e.status IN ('active', 'completed'))
      OR EXISTS (SELECT 1 FROM course_offering_learning_products olp
        JOIN enrolment_offerings eo ON eo.course_offering_id = olp.course_offering_id
        JOIN course_offerings o ON o.id = eo.course_offering_id
        WHERE olp.learning_product_id = ? AND eo.student_user_id = ? AND eo.status = 'active'
          AND (o.access_ends_at IS NULL OR o.access_ends_at >= ?))`
  ).bind(product.creator_id, actorId, product.id, actorId, product.id, actorId, now).first() : null;
  product.has_access = access ? 1 : 0;
  return product
    ? json({ product: publicProduct(product, false, Boolean(product.has_access)) })
    : problem(404, "learning_product_not_found", "This learning product does not exist.");
}

async function accessibleProductForProgress(env: ApiEnvironment, slug: string, actorId: string) {
  return env.DB.prepare(
    `SELECT p.id, p.product_type FROM learning_products p
     WHERE p.slug = ? AND p.status = 'published' AND (
       p.creator_id = ?
       OR EXISTS (SELECT 1 FROM learning_product_entitlements e
         WHERE e.learning_product_id = p.id AND e.user_id = ?
           AND e.status IN ('active', 'completed'))
       OR EXISTS (SELECT 1 FROM course_offering_learning_products olp
         JOIN enrolment_offerings eo ON eo.course_offering_id = olp.course_offering_id
         JOIN course_offerings o ON o.id = eo.course_offering_id
         WHERE olp.learning_product_id = p.id AND eo.student_user_id = ?
           AND eo.status IN ('active', 'completed')
           AND (o.access_ends_at IS NULL OR o.access_ends_at >= ?))
     )`
  ).bind(slug, actorId, actorId, actorId, new Date().toISOString())
    .first<{ id: string; product_type: LearningProductType }>();
}

async function standaloneQuestionMedia(
  request: Request,
  env: ApiEnvironment,
  slug: string,
  questionId: string
): Promise<Response> {
  const actor = await getCreatorActorById(userId(request), env.DB);
  if (!actor) return problem(401, "authentication_required", "Sign in to view this question media.");
  const product = await accessibleProductForProgress(env, slug, actor.id);
  if (!product || !isAssessmentProduct(product.product_type)) {
    return problem(403, "product_access_required", "Active access to this assessment is required.");
  }
  const media = await env.DB.prepare(
    `SELECT asset_version_id FROM assessment_question_media
     WHERE learning_product_id = ? AND standalone_question_id = ?`
  ).bind(product.id, questionId).first<{ asset_version_id: string }>();
  return media
    ? serveQuestionMediaVersion(env, media.asset_version_id)
    : problem(404, "question_media_not_found", "This question does not have media.");
}

async function productProgress(request: Request, env: ApiEnvironment, slug: string): Promise<Response> {
  const actor = await getCreatorActorById(userId(request), env.DB);
  if (!actor) return problem(401, "authentication_required", "Sign in to view product progress.");
  const product = await accessibleProductForProgress(env, slug, actor.id);
  if (!product) return problem(403, "product_access_required", "Active access to this product is required.");

  if (request.method === "GET") {
    const [progress, activities, attempts] = await Promise.all([
      env.DB.prepare(
        `SELECT status, progress_percent, position_seconds, duration_seconds, total_seconds,
          first_opened_at, last_opened_at, completed_at
         FROM learning_product_progress WHERE learning_product_id = ? AND user_id = ?`
      ).bind(product.id, actor.id).first(),
      env.DB.prepare(
        `SELECT id, activity_type, progress_percent, position_seconds, seconds_spent, created_at
         FROM learning_product_activity
         WHERE learning_product_id = ? AND user_id = ?
         ORDER BY created_at DESC LIMIT 20`
      ).bind(product.id, actor.id).all(),
      env.DB.prepare(
        `SELECT id, score_percent, passed, submitted_at
         FROM learning_product_attempts
         WHERE learning_product_id = ? AND user_id = ?
         ORDER BY submitted_at DESC LIMIT 20`
      ).bind(product.id, actor.id).all()
    ]);
    return json({
      progress: progress ?? {
        status: "not_started", progress_percent: 0, position_seconds: 0,
        duration_seconds: 0, total_seconds: 0, first_opened_at: null,
        last_opened_at: null, completed_at: null
      },
      activities: activities.results,
      attempts: attempts.results
    });
  }

  if (request.method !== "PATCH") return problem(405, "method_not_allowed", "Method not allowed.");
  let input: Record<string, unknown>;
  try {
    input = await request.json<Record<string, unknown>>();
  } catch {
    return problem(400, "invalid_json", "A JSON request body is required.");
  }
  const progressPercent = Math.round(Number(input.progressPercent ?? 0));
  const positionSeconds = Number(input.positionSeconds ?? 0);
  const durationSeconds = Number(input.durationSeconds ?? 0);
  const secondsSpent = Math.round(Number(input.secondsSpent ?? 0));
  const requestedStatus = String(input.status ?? (progressPercent >= 100 ? "completed" : "in_progress"));
  const activityType = String(input.activityType ?? "progressed");
  if (!Number.isFinite(progressPercent) || progressPercent < 0 || progressPercent > 100
    || !Number.isFinite(positionSeconds) || positionSeconds < 0
    || !Number.isFinite(durationSeconds) || durationSeconds < 0
    || !Number.isSafeInteger(secondsSpent) || secondsSpent < 0 || secondsSpent > 300
    || !["not_started", "in_progress", "completed"].includes(requestedStatus)
    || !["opened", "progressed", "paused", "completed"].includes(activityType)) {
    return problem(400, "invalid_progress", "Provide valid product progress values.");
  }
  const status = requestedStatus === "completed" || progressPercent >= 100 ? "completed" : requestedStatus;
  const normalizedPercent = status === "completed" ? 100 : progressPercent;
  const now = new Date().toISOString();
  const statements = [env.DB.prepare(
    `INSERT INTO learning_product_progress
      (id, learning_product_id, user_id, status, progress_percent, position_seconds,
       duration_seconds, total_seconds, first_opened_at, last_opened_at, completed_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(learning_product_id, user_id) DO UPDATE SET
       status = CASE WHEN learning_product_progress.status = 'completed' THEN 'completed' ELSE excluded.status END,
       progress_percent = MAX(learning_product_progress.progress_percent, excluded.progress_percent),
       position_seconds = excluded.position_seconds,
       duration_seconds = MAX(learning_product_progress.duration_seconds, excluded.duration_seconds),
       total_seconds = learning_product_progress.total_seconds + excluded.total_seconds,
       last_opened_at = excluded.last_opened_at,
       completed_at = CASE WHEN excluded.status = 'completed'
         THEN COALESCE(learning_product_progress.completed_at, excluded.completed_at)
         ELSE learning_product_progress.completed_at END,
       updated_at = excluded.updated_at`
  ).bind(
    crypto.randomUUID(), product.id, actor.id, status, normalizedPercent,
    positionSeconds, durationSeconds, secondsSpent, now, now,
    status === "completed" ? now : null, now
  )];
  if (activityType !== "progressed") {
    statements.push(env.DB.prepare(
      `INSERT INTO learning_product_activity
        (id, learning_product_id, user_id, activity_type, progress_percent,
         position_seconds, seconds_spent, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      crypto.randomUUID(), product.id, actor.id, activityType,
      normalizedPercent, positionSeconds, secondsSpent, now
    ));
  }
  if (status === "completed") {
    statements.push(env.DB.prepare(
      `UPDATE learning_product_entitlements SET status = 'completed', completed_at = COALESCE(completed_at, ?)
       WHERE learning_product_id = ? AND user_id = ?`
    ).bind(now, product.id, actor.id));
  }
  await env.DB.batch(statements);
  return json({ saved: true, status, progressPercent: normalizedPercent, updatedAt: now });
}

async function creatorProducts(request: Request, env: ApiEnvironment): Promise<Response> {
  const actor = await getCreatorActorById(userId(request), env.DB);
  if (!actor) return problem(401, "authentication_required", "Sign in to manage learning products.");
  const result = await env.DB.prepare(
    `${productSelect} WHERE p.creator_id = ? ORDER BY p.updated_at DESC`
  ).bind(actor.id).all<StoredProduct>();
  return json({ products: result.results.map((product) => publicProduct(product, true, true)) });
}

type CreatePayload = {
  title?: unknown;
  description?: unknown;
  subject?: unknown;
  audience?: unknown;
  productType?: unknown;
  contentUrl?: unknown;
  estimatedMinutes?: unknown;
  questions?: unknown;
  passingScore?: unknown;
  timeLimitMinutes?: unknown;
  status?: unknown;
  metadataOnly?: unknown;
  primaryLibraryItemId?: unknown;
  languageCode?: unknown;
};

function cleanText(value: unknown, limit: number): string {
  return typeof value === "string" ? value.trim().slice(0, limit) : "";
}

async function validateQuestions(
  env: ApiEnvironment,
  creatorId: string,
  value: unknown
): Promise<{ questions: LearningProductQuestion[]; media: Array<{ questionId: string; value: ResolvedQuestionMedia }> } | Response | null> {
  if (!Array.isArray(value) || !value.length || value.length > 100) return null;
  const questions: LearningProductQuestion[] = [];
  const media: Array<{ questionId: string; value: ResolvedQuestionMedia }> = [];
  const ids = new Set<string>();
  for (const raw of value) {
    if (!raw || typeof raw !== "object") return null;
    const source = raw as Record<string, unknown>;
    const prompt = cleanText(source.prompt, 1000);
    const options = Array.isArray(source.options)
      ? source.options.map((option) => cleanText(option, 500)).filter(Boolean)
      : [];
    const correctIndex = Number(source.correctIndex);
    if (!prompt || options.length < 2 || !Number.isInteger(correctIndex) || correctIndex < 0 || correctIndex >= options.length) {
      return null;
    }
    const requestedId = cleanText(source.id, 100);
    const id = requestedId && !ids.has(requestedId) ? requestedId : crypto.randomUUID();
    ids.add(id);
    const resolved = await resolveQuestionMedia(env, creatorId, source);
    if (resolved instanceof Response) return resolved;
    const question: LearningProductQuestion = {
      id,
      prompt,
      options,
      correctIndex,
      explanation: cleanText(source.explanation, 1000)
    };
    if (resolved) {
      question.media = {
        libraryItemId: resolved.libraryItemId,
        mediaType: resolved.mediaType,
        altText: resolved.altText,
        caption: resolved.caption
      };
      media.push({ questionId: id, value: resolved });
    }
    questions.push(question);
  }
  return { questions, media };
}

async function createProduct(request: Request, env: ApiEnvironment): Promise<Response> {
  const actor = await getCreatorActorById(userId(request), env.DB);
  if (!actor) return problem(401, "authentication_required", "Sign in to create a learning product.");
  let payload: CreatePayload;
  try {
    payload = await request.json<CreatePayload>();
  } catch {
    return problem(400, "invalid_json", "A JSON request body is required.");
  }
  if (!isLearningProductType(payload.productType)) {
    return problem(400, "invalid_product_type", "Choose an ebook, reading, quiz, test, mock exam, video or audio.");
  }
  const title = cleanText(payload.title, 140);
  const description = cleanText(payload.description, 2000);
  const subject = cleanText(payload.subject, 120);
  const audience = cleanText(payload.audience, 120);
  const languageCode = /^[a-z]{2,3}(?:-[A-Z]{2})?$/.test(cleanText(payload.languageCode, 10))
    ? cleanText(payload.languageCode, 10) : "en";
  if (title.length < 3 || description.length < 20 || !subject || !audience) {
    return problem(400, "invalid_product", "Add a title, a description of at least 20 characters, a topic and an audience.");
  }
  const estimatedMinutes = Number(payload.estimatedMinutes);
  if (!Number.isSafeInteger(estimatedMinutes) || estimatedMinutes < 1 || estimatedMinutes > 10000) {
    return problem(400, "invalid_duration", "Estimated minutes must be between 1 and 10000.");
  }
  let contentUrl: string | null = null;
  let primaryLibraryItem: { id: string; media_type: string; mime_type: string | null } | null = null;
  let questions: LearningProductQuestion[] = [];
  const content: Record<string, unknown> = {};
  let questionMedia: Array<{ questionId: string; value: ResolvedQuestionMedia }> = [];
  const metadataOnly = payload.metadataOnly === true && payload.status !== "published";
  if (metadataOnly) {
    content.setupIncomplete = true;
  } else if (isAssessmentProduct(payload.productType)) {
    const validated = await validateQuestions(env, actor.id, payload.questions);
    if (validated instanceof Response) return validated;
    if (!validated) return problem(400, "invalid_questions", "Add at least one complete question with two answers and a correct answer.");
    questions = validated.questions;
    questionMedia = validated.media;
    const passingScore = Number(payload.passingScore);
    const timeLimitMinutes = Number(payload.timeLimitMinutes);
    content.questions = questions;
    content.passingScore = Number.isInteger(passingScore) && passingScore >= 0 && passingScore <= 100 ? passingScore : 50;
    content.timeLimitMinutes = Number.isInteger(timeLimitMinutes) && timeLimitMinutes > 0 ? timeLimitMinutes : null;
  } else {
    const libraryItemId = cleanText(payload.primaryLibraryItemId, 100);
    if (libraryItemId) {
      primaryLibraryItem = await env.DB.prepare(
        "SELECT i.id, i.media_type, ma.mime_type FROM creator_library_items i LEFT JOIN media_assets ma ON ma.id = i.media_asset_id WHERE i.id = ? AND i.owner_user_id = ? AND i.status = 'active'"
      ).bind(libraryItemId, actor.id).first<{ id: string; media_type: string; mime_type: string | null }>();
      const expected = payload.productType === "audio" ? "audio"
        : payload.productType === "video" ? "video"
          : payload.productType === "ebook" ? "document" : null;
      if (!primaryLibraryItem || (expected && primaryLibraryItem.media_type !== expected)) {
        return problem(409, "incompatible_library_item", "Choose a compatible active item from your Content Library.");
      }
      if (payload.productType === "video"
        && ["video/x-ms-wmv", "video/x-ms-asf"].includes(primaryLibraryItem.mime_type ?? "")) {
        return problem(409, "wmv_playback_unsupported", "Use MP4 or WebM as the primary playable video. WMV can only be offered as a download.");
      }
      contentUrl = "/api/creator/content-library/items/" + libraryItemId + "/content";
    } else {
      const rawUrl = cleanText(payload.contentUrl, 2000);
      try {
        const parsed = new URL(rawUrl);
        if (!["https:", "http:"].includes(parsed.protocol)) throw new Error("invalid protocol");
        contentUrl = parsed.toString();
      } catch {
        return problem(400, "invalid_content_source", "Add a valid content link or choose a compatible Content Library item.");
      }
    }
  }
  const status = payload.status === "published" ? "published" : "draft";
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  const slug = await uniqueSlug(env.DB, title);
  const statements = [
    env.DB.prepare(
    `INSERT INTO learning_products
      (id, creator_id, slug, product_type, title, description, subject, audience, language_code,
       content_url, content_json, estimated_minutes, price_cents, currency, status,
       published_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'SGD', ?, ?, ?, ?)`
  ).bind(
    id, actor.id, slug, payload.productType, title, description, subject, audience,
    languageCode, contentUrl, JSON.stringify(content), estimatedMinutes, status,
    status === "published" ? now : null, now, now
    ),
    env.DB.prepare(
      `INSERT INTO audit_logs
        (id, actor_user_id, action, entity_type, entity_id, metadata_json, created_at)
       VALUES (?, ?, ?, 'learning_product', ?, ?, ?)`
    ).bind(
      crypto.randomUUID(), actor.id,
      status === "published" ? "learning_product.created_and_published" : "learning_product.created",
      id, JSON.stringify({ title, productType: payload.productType }), now
    )
  ];
  if (primaryLibraryItem) {
    const role = payload.productType === "ebook" ? "primary_document" : "primary_media";
    statements.push(env.DB.prepare(
      "INSERT INTO creator_library_resource_links (id, item_id, owner_user_id, entity_type, entity_id, resource_role, position, required_percent, created_at) VALUES (?, ?, ?, 'learning_product', ?, ?, 1, 90, ?)"
    ).bind(crypto.randomUUID(), primaryLibraryItem.id, actor.id, id, role, now));
  }
  questionMedia.forEach((entry) => statements.push(questionMediaInsert(
    env, actor.id, entry.value,
    { learningProductId: id, standaloneQuestionId: entry.questionId }, now
  )));
  await env.DB.batch(statements);
  return json({ product: { id, slug, status } }, { status: 201 });
}

async function updateProduct(request: Request, env: ApiEnvironment, id: string): Promise<Response> {
  const actor = await getCreatorActorById(userId(request), env.DB);
  if (!actor) return problem(401, "authentication_required", "Sign in to edit this learning product.");
  const existing = await env.DB.prepare(
    "SELECT id, creator_id, product_type, slug, status, content_url FROM learning_products WHERE id = ?"
  ).bind(id).first<Pick<StoredProduct, "id" | "creator_id" | "product_type" | "slug" | "status" | "content_url">>();
  if (!existing) return problem(404, "learning_product_not_found", "This learning product does not exist.");
  if (existing.creator_id !== actor.id && actor.role !== "admin") {
    return problem(403, "learning_product_forbidden", "Only the content creator can edit this learning product.");
  }
  if (existing.status !== "draft") {
    return problem(409, "draft_version_required", "Create a new draft version before editing published content.");
  }
  let payload: CreatePayload;
  try {
    payload = await request.json<CreatePayload>();
  } catch {
    return problem(400, "invalid_json", "A JSON request body is required.");
  }
  if (!isLearningProductType(payload.productType) || payload.productType !== existing.product_type) {
    return problem(400, "product_type_locked", "The product format cannot be changed after it is created.");
  }
  const title = cleanText(payload.title, 140);
  const description = cleanText(payload.description, 2000);
  const subject = cleanText(payload.subject, 120);
  const audience = cleanText(payload.audience, 120);
  const languageCode = /^[a-z]{2,3}(?:-[A-Z]{2})?$/.test(cleanText(payload.languageCode, 10))
    ? cleanText(payload.languageCode, 10) : "en";
  if (title.length < 3 || description.length < 20 || !subject || !audience) {
    return problem(400, "invalid_product", "Add a title, a description of at least 20 characters, a topic and an audience.");
  }
  const estimatedMinutes = Number(payload.estimatedMinutes);
  if (!Number.isSafeInteger(estimatedMinutes) || estimatedMinutes < 1 || estimatedMinutes > 10000) {
    return problem(400, "invalid_duration", "Estimated minutes must be between 1 and 10000.");
  }
  if (payload.metadataOnly === true) {
    let metadataUpdate;
    if (isAssessmentProduct(existing.product_type)) {
      metadataUpdate = env.DB.prepare(
        `UPDATE learning_products SET title = ?, description = ?, subject = ?, audience = ?, language_code = ?,
          estimated_minutes = ?, updated_at = ? WHERE id = ?`
      ).bind(title, description, subject, audience, languageCode, estimatedMinutes, new Date().toISOString(), id);
    } else {
      const rawUrl = cleanText(payload.contentUrl, 2000);
      let resourceUrl = existing.content_url ?? "";
      if (rawUrl) {
        try {
          const parsed = new URL(rawUrl);
          if (!["https:", "http:"].includes(parsed.protocol)) throw new Error("invalid protocol");
          resourceUrl = parsed.toString();
        } catch {
          if (!resourceUrl.startsWith("/api/creator/content-library/items/")) {
            return problem(400, "invalid_content_url", "Add a valid HTTP or HTTPS link to the content.");
          }
        }
      }
      metadataUpdate = env.DB.prepare(
        `UPDATE learning_products SET title = ?, description = ?, subject = ?, audience = ?, language_code = ?,
          content_url = ?, estimated_minutes = ?, updated_at = ? WHERE id = ?`
      ).bind(title, description, subject, audience, languageCode, resourceUrl, estimatedMinutes, new Date().toISOString(), id);
    }
    const now = new Date().toISOString();
    await env.DB.batch([
      metadataUpdate,
      env.DB.prepare(
        `INSERT INTO audit_logs
          (id, actor_user_id, action, entity_type, entity_id, metadata_json, created_at)
         VALUES (?, ?, 'learning_product.updated', 'learning_product', ?, ?, ?)`
      ).bind(crypto.randomUUID(), actor.id, id, JSON.stringify({ title, metadataOnly: true }), now)
    ]);
    return json({ product: { id, slug: existing.slug, status: existing.status } });
  }
  let contentUrl: string | null = null;
  const content: Record<string, unknown> = {};
  let questionMedia: Array<{ questionId: string; value: ResolvedQuestionMedia }> = [];
  let primaryLibraryItem: { id: string; media_type: string; mime_type: string | null } | null = null;
  if (isAssessmentProduct(existing.product_type)) {
    const validated = await validateQuestions(env, actor.id, payload.questions);
    if (validated instanceof Response) return validated;
    if (!validated) return problem(400, "invalid_questions", "Add at least one complete question with two answers and a correct answer.");
    const questions = validated.questions;
    questionMedia = validated.media;
    const passingScore = Number(payload.passingScore);
    const timeLimitMinutes = Number(payload.timeLimitMinutes);
    content.questions = questions;
    content.passingScore = Number.isInteger(passingScore) && passingScore >= 0 && passingScore <= 100 ? passingScore : 50;
    content.timeLimitMinutes = Number.isInteger(timeLimitMinutes) && timeLimitMinutes > 0 ? timeLimitMinutes : null;
  } else {
    const libraryItemId = cleanText(payload.primaryLibraryItemId, 100);
    if (libraryItemId) {
      primaryLibraryItem = await env.DB.prepare(
        "SELECT i.id, i.media_type, ma.mime_type FROM creator_library_items i LEFT JOIN media_assets ma ON ma.id = i.media_asset_id WHERE i.id = ? AND i.owner_user_id = ? AND i.status = 'active'"
      ).bind(libraryItemId, actor.id).first<{ id: string; media_type: string; mime_type: string | null }>();
      const expected = existing.product_type === "audio" ? "audio"
        : existing.product_type === "video" ? "video"
          : existing.product_type === "ebook" ? "document" : null;
      if (!primaryLibraryItem || (expected && primaryLibraryItem.media_type !== expected)) {
        return problem(409, "incompatible_library_item", "Choose a compatible active item from your Content Library.");
      }
      if (existing.product_type === "video"
        && ["video/x-ms-wmv", "video/x-ms-asf"].includes(primaryLibraryItem.mime_type ?? "")) {
        return problem(409, "wmv_playback_unsupported", "Use MP4 or WebM as the primary playable video. WMV can only be offered as a download.");
      }
      contentUrl = "/api/creator/content-library/items/" + libraryItemId + "/content";
    } else {
      const rawUrl = cleanText(payload.contentUrl, 2000);
      try {
        const parsed = new URL(rawUrl);
        if (!["https:", "http:"].includes(parsed.protocol)) throw new Error("invalid protocol");
        contentUrl = parsed.toString();
      } catch {
        return problem(400, "invalid_content_url", "Add a valid HTTP or HTTPS link to the content.");
      }
    }
  }
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(
    `UPDATE learning_products SET title = ?, description = ?, subject = ?, audience = ?, language_code = ?,
      content_url = ?, content_json = ?, estimated_minutes = ?, updated_at = ? WHERE id = ?`
  ).bind(
    title, description, subject, audience, languageCode, contentUrl, JSON.stringify(content), estimatedMinutes,
    now, id
    ),
    env.DB.prepare(
      `INSERT INTO audit_logs
        (id, actor_user_id, action, entity_type, entity_id, metadata_json, created_at)
       VALUES (?, ?, 'learning_product.updated', 'learning_product', ?, ?, ?)`
    ).bind(crypto.randomUUID(), actor.id, id, JSON.stringify({ title }), now)
    ,
    ...(isAssessmentProduct(existing.product_type)
      ? [
          env.DB.prepare("DELETE FROM assessment_question_media WHERE learning_product_id = ?").bind(id),
          ...questionMedia.map((entry) => questionMediaInsert(
            env, actor.id, entry.value,
            { learningProductId: id, standaloneQuestionId: entry.questionId }, now
          ))
        ]
      : [
          env.DB.prepare(
            "DELETE FROM creator_library_resource_links WHERE entity_type = 'learning_product' AND entity_id = ? AND resource_role IN ('primary_document', 'primary_media')"
          ).bind(id),
          ...(primaryLibraryItem ? [env.DB.prepare(
            "INSERT INTO creator_library_resource_links (id, item_id, owner_user_id, entity_type, entity_id, resource_role, position, required_percent, created_at) VALUES (?, ?, ?, 'learning_product', ?, ?, 1, 90, ?)"
          ).bind(
            crypto.randomUUID(), primaryLibraryItem.id, actor.id, id,
            existing.product_type === "ebook" ? "primary_document" : "primary_media", now
          )] : [])
        ])
  ]);
  return json({ product: { id, slug: existing.slug, status: existing.status } });
}

async function publishProduct(request: Request, env: ApiEnvironment, id: string): Promise<Response> {
  const actor = await getCreatorActorById(userId(request), env.DB);
  if (!actor) return problem(401, "authentication_required", "Sign in to publish this learning product.");
  const product = await env.DB.prepare(
    "SELECT id, creator_id, product_type, status, content_url, content_json FROM learning_products WHERE id = ?"
  ).bind(id).first<Pick<StoredProduct, "id" | "creator_id" | "product_type" | "status" | "content_url" | "content_json">>();
  if (!product) return problem(404, "learning_product_not_found", "This learning product does not exist.");
  if (product.creator_id !== actor.id && actor.role !== "admin") {
    return problem(403, "learning_product_forbidden", "You cannot publish this learning product.");
  }
  const hasCompleteContent = isAssessmentProduct(product.product_type)
    ? parseQuestions(product.content_json).length > 0
    : Boolean(product.content_url);
  if (!hasCompleteContent) {
    return problem(409, "product_content_required", "Complete the product content before publishing.");
  }
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE learning_products SET status = 'published', listing_status = 'listed', published_at = COALESCE(published_at, ?), updated_at = ? WHERE id = ?"
    ).bind(now, now, id),
    env.DB.prepare(
      `INSERT INTO audit_logs
        (id, actor_user_id, action, entity_type, entity_id, metadata_json, created_at)
       VALUES (?, ?, 'learning_product.published', 'learning_product', ?, '{}', ?)`
    ).bind(crypto.randomUUID(), actor.id, id, now)
  ]);
  return json({ product: { id, status: "published" } });
}

async function productLifecycle(
  request: Request,
  env: ApiEnvironment,
  id: string,
  action: "unpublish" | "republish"
): Promise<Response> {
  const actor = await getCreatorActorById(userId(request), env.DB);
  if (!actor) return problem(401, "authentication_required", "Sign in to manage this learning product.");
  const product = await env.DB.prepare(
    "SELECT id, creator_id, status FROM learning_products WHERE id = ?"
  ).bind(id).first<{ id: string; creator_id: string; status: string }>();
  if (!product) return problem(404, "learning_product_not_found", "This learning product does not exist.");
  if (product.creator_id !== actor.id && actor.role !== "admin") {
    return problem(403, "learning_product_forbidden", "Only the content creator can change publication visibility.");
  }
  if (product.status !== "published") {
    return problem(409, "learning_product_not_published", "Only published content can be unpublished or republished.");
  }
  if (action === "unpublish") {
    const liveOffer = await env.DB.prepare(
      `SELECT po.id, po.title FROM product_offer_items pi JOIN product_offers po ON po.id = pi.product_offer_id
       WHERE pi.learning_product_id = ? AND po.status = 'published' LIMIT 1`
    ).bind(id).first<{ id: string; title: string }>();
    if (liveOffer) {
      return problem(409, "product_in_live_offer", `Close the live offer “${liveOffer.title}” before unpublishing this product.`);
    }
  }
  const listingStatus = action === "unpublish" ? "unpublished" : "listed";
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare("UPDATE learning_products SET listing_status = ?, updated_at = ? WHERE id = ?")
      .bind(listingStatus, now, id),
    env.DB.prepare(
      `INSERT INTO audit_logs
        (id, actor_user_id, action, entity_type, entity_id, metadata_json, created_at)
       VALUES (?, ?, ?, 'learning_product', ?, '{}', ?)`
    ).bind(crypto.randomUUID(), actor.id, `learning_product.${action}`, id, now)
  ]);
  return json({ product: { id, status: "published", listingStatus } });
}

async function copyProduct(request: Request, env: ApiEnvironment, id: string): Promise<Response> {
  const actor = await getCreatorActorById(userId(request), env.DB);
  if (!actor) return problem(401, "authentication_required", "Sign in to create a new content version.");
  const source = await env.DB.prepare(
    "SELECT * FROM learning_products WHERE id = ?"
  ).bind(id).first<StoredProduct>();
  if (!source) return problem(404, "learning_product_not_found", "This learning product does not exist.");
  if (source.creator_id !== actor.id && actor.role !== "admin") {
    return problem(403, "learning_product_forbidden", "Only the content creator can copy this learning product.");
  }
  if (source.status !== "published") {
    return problem(409, "published_product_required", "Publish this content before creating a new version.");
  }
  const rootId = source.source_product_id ?? source.id;
  const versionRow = await env.DB.prepare(
    "SELECT MAX(content_version) AS version FROM learning_products WHERE id = ? OR source_product_id = ?"
  ).bind(rootId, rootId).first<{ version: number | null }>();
  const version = Number(versionRow?.version ?? source.content_version) + 1;
  const newId = crypto.randomUUID();
  const slug = await uniqueSlug(env.DB, `${source.title}-v${version}`);
  const now = new Date().toISOString();
  const sourceQuestionMedia = await env.DB.prepare(
    `SELECT library_item_id, asset_version_id, standalone_question_id, media_type, alt_text, caption
     FROM assessment_question_media WHERE learning_product_id = ?`
  ).bind(source.id).all<{
    library_item_id: string; asset_version_id: string; standalone_question_id: string;
    media_type: "image" | "video" | "audio"; alt_text: string; caption: string;
  }>();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO learning_products
        (id, creator_id, slug, product_type, title, description, subject, audience, language_code,
         content_url, content_json, estimated_minutes, price_cents, currency, status,
         published_at, created_at, updated_at, source_product_id, content_version, listing_status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', NULL, ?, ?, ?, ?, 'listed')`
    ).bind(
      newId, source.creator_id, slug, source.product_type, source.title, source.description,
      source.subject, source.audience, source.language_code, source.content_url, source.content_json,
      source.estimated_minutes, source.price_cents, source.currency, now, now, rootId, version
    ),
    env.DB.prepare(
      `INSERT INTO audit_logs
        (id, actor_user_id, action, entity_type, entity_id, metadata_json, created_at)
       VALUES (?, ?, 'learning_product.version_created', 'learning_product', ?, ?, ?)`
    ).bind(crypto.randomUUID(), actor.id, newId, JSON.stringify({ sourceId: source.id, version }), now),
    ...sourceQuestionMedia.results.map((media) => questionMediaInsert(
      env, actor.id,
      {
        libraryItemId: media.library_item_id,
        assetVersionId: media.asset_version_id,
        mediaType: media.media_type,
        altText: media.alt_text,
        caption: media.caption
      },
      { learningProductId: newId, standaloneQuestionId: media.standalone_question_id }, now
    ))
  ]);
  return json({ product: { id: newId, slug, status: "draft", contentVersion: version } }, { status: 201 });
}

async function deleteProductDraft(request: Request, env: ApiEnvironment, id: string): Promise<Response> {
  const actor = await getCreatorActorById(userId(request), env.DB);
  if (!actor) return problem(401, "authentication_required", "Sign in to delete this learning product.");
  const product = await env.DB.prepare(
    "SELECT id, creator_id, status FROM learning_products WHERE id = ?"
  ).bind(id).first<{ id: string; creator_id: string; status: string }>();
  if (!product) return problem(404, "learning_product_not_found", "This learning product does not exist.");
  if (product.creator_id !== actor.id && actor.role !== "admin") {
    return problem(403, "learning_product_forbidden", "Only the content creator can delete this draft.");
  }
  if (product.status !== "draft") {
    return problem(409, "draft_required", "Published content cannot be deleted. Unpublish it or create a new version instead.");
  }
  const usage = await env.DB.prepare(
    `SELECT
      (SELECT COUNT(*) FROM learning_product_entitlements WHERE learning_product_id = ?) +
      (SELECT COUNT(*) FROM course_offering_learning_products WHERE learning_product_id = ?) AS total`
  ).bind(id, id).first<{ total: number }>();
  if (Number(usage?.total ?? 0) > 0) {
    return problem(409, "product_in_use", "This draft is attached to an offering or learner record and cannot be deleted.");
  }
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO audit_logs
        (id, actor_user_id, action, entity_type, entity_id, metadata_json, created_at)
       VALUES (?, ?, 'learning_product.deleted', 'learning_product', ?, '{}', ?)`
    ).bind(crypto.randomUUID(), actor.id, id, now),
    env.DB.prepare("DELETE FROM learning_products WHERE id = ?").bind(id)
  ]);
  return json({ deleted: true, id });
}

async function addToLibrary(request: Request, env: ApiEnvironment, slug: string): Promise<Response> {
  const actor = await getCreatorActorById(userId(request), env.DB);
  if (!actor) return problem(401, "authentication_required", "Sign in to add this to your learning.");
  const product = await env.DB.prepare(
    `SELECT p.id FROM learning_products p WHERE p.slug = ? AND p.status = 'published'
      AND p.listing_status = 'listed' AND ${pricedPublishedOffer}`
  ).bind(slug).first<{ id: string }>();
  if (!product) return problem(404, "learning_product_not_found", "This learning product does not exist.");
  return problem(409, "offer_purchase_required", "Choose and enrol in the published offer to unlock this product.");
}

async function myProducts(request: Request, env: ApiEnvironment): Promise<Response> {
  const actor = await getCreatorActorById(userId(request), env.DB);
  if (!actor) return problem(401, "authentication_required", "Sign in to view your learning.");
  const result = await env.DB.prepare(
    `${productSelect}
     WHERE p.status = 'published' AND (
       EXISTS (SELECT 1 FROM learning_product_entitlements e
         WHERE e.learning_product_id = p.id AND e.user_id = ?
           AND e.status IN ('active', 'completed'))
       OR EXISTS (SELECT 1 FROM course_offering_learning_products olp
         JOIN enrolment_offerings eo ON eo.course_offering_id = olp.course_offering_id
         JOIN course_offerings o ON o.id = eo.course_offering_id
         WHERE olp.learning_product_id = p.id AND eo.student_user_id = ?
           AND eo.status IN ('active', 'completed')
           AND (o.access_ends_at IS NULL OR o.access_ends_at >= ?))
     )
     ORDER BY COALESCE(
       (SELECT MAX(eo.enrolled_at) FROM course_offering_learning_products olp
        JOIN enrolment_offerings eo ON eo.course_offering_id = olp.course_offering_id
        WHERE olp.learning_product_id = p.id AND eo.student_user_id = ?),
       (SELECT MAX(e.granted_at) FROM learning_product_entitlements e
        WHERE e.learning_product_id = p.id AND e.user_id = ?),
       p.published_at
     ) DESC`
  ).bind(actor.id, actor.id, new Date().toISOString(), actor.id, actor.id).all<StoredProduct>();
  const accessOrders = await env.DB.prepare(
    `SELECT olp.learning_product_id, eo.order_id
     FROM course_offering_learning_products olp
     JOIN enrolment_offerings eo ON eo.course_offering_id = olp.course_offering_id
     WHERE eo.student_user_id = ? AND eo.status IN ('active', 'completed')
     ORDER BY eo.enrolled_at DESC`
  ).bind(actor.id).all<{ learning_product_id: string; order_id: string | null }>();
  const orderByProduct = new Map<string, string | null>();
  accessOrders.results.forEach((row) => {
    if (!orderByProduct.has(row.learning_product_id)) orderByProduct.set(row.learning_product_id, row.order_id);
  });
  return json({ products: result.results.map((product) => ({
    ...publicProduct(product, false, true),
    access_order_id: orderByProduct.get(product.id) ?? null
  })) });
}

async function submitAttempt(request: Request, env: ApiEnvironment, slug: string): Promise<Response> {
  const actor = await getCreatorActorById(userId(request), env.DB);
  if (!actor) return problem(401, "authentication_required", "Sign in before submitting an assessment.");
  const product = await env.DB.prepare(
    `SELECT id, product_type, content_json FROM learning_products p
     WHERE slug = ? AND status = 'published'
       AND (creator_id = ?
         OR EXISTS (SELECT 1 FROM learning_product_entitlements e
           WHERE e.learning_product_id = p.id AND e.user_id = ? AND e.status IN ('active', 'completed'))
         OR EXISTS (SELECT 1 FROM course_offering_learning_products olp
           JOIN enrolment_offerings eo ON eo.course_offering_id = olp.course_offering_id
           JOIN course_offerings o ON o.id = eo.course_offering_id
           WHERE olp.learning_product_id = p.id AND eo.student_user_id = ? AND eo.status = 'active'
             AND (o.access_ends_at IS NULL OR o.access_ends_at >= ?)))`
  ).bind(slug, actor.id, actor.id, actor.id, new Date().toISOString()).first<{ id: string; product_type: LearningProductType; content_json: string }>();
  if (!product || !isAssessmentProduct(product.product_type)) {
    return problem(404, "assessment_not_found", "This assessment does not exist.");
  }
  let payload: { answers?: unknown };
  try {
    payload = await request.json<{ answers?: unknown }>();
  } catch {
    return problem(400, "invalid_json", "A JSON request body is required.");
  }
  const questions = parseQuestions(product.content_json);
  const answers = Array.isArray(payload.answers) ? payload.answers.map(Number) : [];
  if (answers.length !== questions.length || answers.some((answer) => !Number.isInteger(answer))) {
    return problem(400, "invalid_answers", "Answer every question before submitting.");
  }
  let correct = 0;
  questions.forEach((question, index) => {
    if (answers[index] === question.correctIndex) correct += 1;
  });
  const config = JSON.parse(product.content_json) as { passingScore?: number };
  const scorePercent = Math.round((correct / questions.length) * 100);
  const passingScore = Number.isFinite(config.passingScore) ? Number(config.passingScore) : 50;
  const passed = scorePercent >= passingScore;
  const now = new Date().toISOString();
  const attemptId = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO learning_product_attempts
        (id, learning_product_id, user_id, answers_json, score_percent, passed, submitted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).bind(attemptId, product.id, actor.id, JSON.stringify(answers), scorePercent, passed ? 1 : 0, now),
    env.DB.prepare(
      `INSERT INTO learning_product_entitlements (id, learning_product_id, user_id, status, granted_at, completed_at)
       VALUES (?, ?, ?, 'completed', ?, ?)
       ON CONFLICT(learning_product_id, user_id) DO UPDATE SET status = 'completed', completed_at = excluded.completed_at`
    ).bind(crypto.randomUUID(), product.id, actor.id, now, now),
    env.DB.prepare(
      `INSERT INTO learning_product_progress
        (id, learning_product_id, user_id, status, progress_percent, position_seconds,
         duration_seconds, total_seconds, first_opened_at, last_opened_at, completed_at, updated_at)
       VALUES (?, ?, ?, 'completed', 100, 0, 0, 0, ?, ?, ?, ?)
       ON CONFLICT(learning_product_id, user_id) DO UPDATE SET
         status = 'completed', progress_percent = 100, last_opened_at = excluded.last_opened_at,
         completed_at = COALESCE(learning_product_progress.completed_at, excluded.completed_at),
         updated_at = excluded.updated_at`
    ).bind(crypto.randomUUID(), product.id, actor.id, now, now, now, now),
    env.DB.prepare(
      `INSERT INTO learning_product_activity
        (id, learning_product_id, user_id, activity_type, progress_percent,
         position_seconds, seconds_spent, created_at)
       VALUES (?, ?, ?, 'assessment', 100, 0, 0, ?)`
    ).bind(crypto.randomUUID(), product.id, actor.id, now)
  ]);
  return json({
    result: {
      attemptId,
      scorePercent,
      correct,
      total: questions.length,
      passingScore,
      passed,
      questions: questions.map((question, index) => ({
        selectedIndex: answers[index],
        correctIndex: question.correctIndex,
        explanation: question.explanation || ""
      }))
    }
  });
}

export async function handleLearningProductRequest(
  request: Request,
  env: ApiEnvironment,
  pathname: string
): Promise<Response | null> {
  if (request.method === "GET" && pathname === "/api/learning-products") return listProducts(request, env);
  if (request.method === "GET" && pathname === "/api/creator/learning-products") return creatorProducts(request, env);
  if (request.method === "POST" && pathname === "/api/creator/learning-products") return createProduct(request, env);
  if (request.method === "GET" && pathname === "/api/my-learning-products") return myProducts(request, env);

  const publish = pathname.match(/^\/api\/creator\/learning-products\/([^/]+)\/publish$/);
  if (request.method === "POST" && publish) return publishProduct(request, env, decodeSegment(publish[1]));
  const lifecycle = pathname.match(/^\/api\/creator\/learning-products\/([^/]+)\/(unpublish|republish)$/);
  if (request.method === "POST" && lifecycle) {
    return productLifecycle(request, env, decodeSegment(lifecycle[1]), lifecycle[2] as "unpublish" | "republish");
  }
  const copy = pathname.match(/^\/api\/creator\/learning-products\/([^/]+)\/copy$/);
  if (request.method === "POST" && copy) return copyProduct(request, env, decodeSegment(copy[1]));
  const creatorProduct = pathname.match(/^\/api\/creator\/learning-products\/([^/]+)$/);
  if (request.method === "PATCH" && creatorProduct) return updateProduct(request, env, decodeSegment(creatorProduct[1]));
  if (request.method === "DELETE" && creatorProduct) return deleteProductDraft(request, env, decodeSegment(creatorProduct[1]));
  const add = pathname.match(/^\/api\/learning-products\/([^/]+)\/add$/);
  if (request.method === "POST" && add) return addToLibrary(request, env, decodeSegment(add[1]));
  const attempt = pathname.match(/^\/api\/learning-products\/([^/]+)\/attempts$/);
  if (request.method === "POST" && attempt) return submitAttempt(request, env, decodeSegment(attempt[1]));
  const progress = pathname.match(/^\/api\/learning-products\/([^/]+)\/progress$/);
  if ((request.method === "GET" || request.method === "PATCH") && progress) {
    return productProgress(request, env, decodeSegment(progress[1]));
  }
  const media = pathname.match(/^\/api\/learning-products\/([^/]+)\/questions\/([^/]+)\/media$/);
  if (request.method === "GET" && media) {
    return standaloneQuestionMedia(request, env, decodeSegment(media[1]), decodeSegment(media[2]));
  }
  const detail = pathname.match(/^\/api\/learning-products\/([^/]+)$/);
  if (request.method === "GET" && detail) return productBySlug(request, env, decodeSegment(detail[1]));
  return null;
}
