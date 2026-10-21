import { getCreatorActorById } from "../../../src/lib/auth";
import { archivePreviousStripePrice, persistSyncedOfferingPricing, syncOfferingPricing, type OfferingPricingRecord } from "../../../src/lib/course-pricing";
import { json, problem } from "../../../src/lib/http";
import type { ApiEnvironment } from "./index";
import { creatorCanReceivePayouts } from "./payouts";

type OfferInput = {
  title?: unknown; description?: unknown; priceCents?: unknown; currency?: unknown;
  productIds?: unknown; courseOfferingIds?: unknown; enrolmentOpensAt?: unknown; enrolmentClosesAt?: unknown;
  accessEndsAt?: unknown; capacity?: unknown;
};

type ProductOfferRow = {
  id: string; creator_user_id: string; title: string; description: string;
  price_cents: number; currency: string; pricing_version: number;
  stripe_product_id: string | null; stripe_price_id: string | null;
  pricing_status: string; status: string; enrolment_opens_at: string | null;
  enrolment_closes_at: string | null; access_ends_at: string | null;
  capacity: number | null; commerce_course_id: string; commerce_offering_id: string;
  product_count: number; items: Array<Record<string, unknown>>; courseItems: Array<Record<string, unknown>>;
};

const actorId = (request: Request) => request.headers.get("x-pencilscope-user-id")?.trim() || null;
const text = (value: unknown, max: number) => typeof value === "string" ? value.trim().slice(0, max) : "";
const optionalDate = (value: unknown) => typeof value === "string" && value.trim() ? value.trim() : null;

async function offerDetail(db: D1Database, id: string, creatorId?: string) {
  const offer = await db.prepare(
    `SELECT o.*, ((SELECT COUNT(*) FROM product_offer_items i WHERE i.product_offer_id = o.id)
       + (SELECT COUNT(*) FROM product_offer_course_items ci WHERE ci.product_offer_id = o.id)) AS product_count
     FROM product_offers o WHERE o.id = ? ${creatorId ? "AND o.creator_user_id = ?" : ""}`
  ).bind(...(creatorId ? [id, creatorId] : [id])).first<Omit<ProductOfferRow, "items">>();
  if (!offer) return null;
  const items = await db.prepare(
    `SELECT p.id, p.slug, p.product_type, p.title, p.description, p.status, p.listing_status,
       p.content_version, i.position
     FROM product_offer_items i JOIN learning_products p ON p.id = i.learning_product_id
     WHERE i.product_offer_id = ? ORDER BY i.position, p.title`
  ).bind(id).all();
  const courseItems = await db.prepare(
    `SELECT c.id, c.slug, 'course' AS product_type, c.title, c.description, c.status, c.listing_status,
       c.content_version, ci.position, co.id AS course_offering_id, co.title AS offering_title,
       co.delivery_mode, co.starts_at, co.ends_at
     FROM product_offer_course_items ci
     JOIN courses c ON c.id = ci.course_id
     JOIN course_offerings co ON co.id = ci.course_offering_id
     WHERE ci.product_offer_id = ? ORDER BY ci.position, c.title`
  ).bind(id).all();
  return { ...offer, items: items.results, courseItems: courseItems.results } as ProductOfferRow;
}

async function listOffers(request: Request, env: ApiEnvironment, creatorId: string) {
  const productId = new URL(request.url).searchParams.get("productId")?.trim();
  const courseId = new URL(request.url).searchParams.get("courseId")?.trim();
  const result = await env.DB.prepare(
    `SELECT o.*, ((SELECT COUNT(*) FROM product_offer_items i WHERE i.product_offer_id = o.id)
       + (SELECT COUNT(*) FROM product_offer_course_items ci WHERE ci.product_offer_id = o.id)) AS product_count
     FROM product_offers o WHERE o.creator_user_id = ?
       ${productId ? "AND EXISTS (SELECT 1 FROM product_offer_items x WHERE x.product_offer_id = o.id AND x.learning_product_id = ?)" : ""}
       ${courseId ? "AND EXISTS (SELECT 1 FROM product_offer_course_items cx WHERE cx.product_offer_id = o.id AND cx.course_id = ?)" : ""}
     ORDER BY o.updated_at DESC`
  ).bind(creatorId, ...(productId ? [productId] : []), ...(courseId ? [courseId] : [])).all();
  const courseOfferings = await env.DB.prepare(
    `SELECT co.id, co.course_id, co.title AS offering_title, co.delivery_mode, co.starts_at, co.ends_at,
       co.price_cents, co.currency, c.title, c.description
     FROM course_offerings co JOIN courses c ON c.id = co.course_id
     WHERE c.tutor_id = ? AND c.status = 'published' AND c.listing_status = 'listed'
       AND co.status = 'published' AND co.pricing_status = 'ready' AND co.stripe_price_id IS NOT NULL
       AND co.price_cents >= 50 AND NOT EXISTS (SELECT 1 FROM product_offers po WHERE po.commerce_offering_id = co.id)
     ORDER BY c.updated_at DESC, co.created_at DESC`
  ).bind(creatorId).all();
  return json({ offers: result.results, courseOfferings: courseOfferings.results });
}

async function validateProducts(db: D1Database, creatorId: string, ids: string[], requirePublished = false) {
  if (!ids.length) return true;
  const placeholders = ids.map(() => "?").join(",");
  const row = await db.prepare(
    `SELECT COUNT(*) AS total FROM learning_products WHERE creator_id = ? AND id IN (${placeholders})
     ${requirePublished ? "AND status = 'published' AND listing_status = 'listed'" : ""}`
  ).bind(creatorId, ...ids).first<{ total: number }>();
  return Number(row?.total ?? 0) === ids.length;
}

async function validateCourseOfferings(db: D1Database, creatorId: string, ids: string[]) {
  if (!ids.length) return true;
  const placeholders = ids.map(() => "?").join(",");
  const row = await db.prepare(
    `SELECT COUNT(*) AS total FROM course_offerings co JOIN courses c ON c.id = co.course_id
     WHERE c.tutor_id = ? AND co.id IN (${placeholders}) AND c.status = 'published'
       AND c.listing_status = 'listed' AND co.status = 'published' AND co.pricing_status = 'ready'
       AND co.stripe_price_id IS NOT NULL AND co.price_cents >= 50`
  ).bind(creatorId, ...ids).first<{ total: number }>();
  return Number(row?.total ?? 0) === ids.length;
}

async function createOffer(request: Request, env: ApiEnvironment, creatorId: string) {
  const body = await request.json<OfferInput>().catch(() => ({} as OfferInput));
  const title = text(body.title, 160);
  const description = text(body.description, 2000);
  const priceCents = Number(body.priceCents);
  const currency = text(body.currency, 3).toUpperCase() || "SGD";
  const productIds: string[] = Array.isArray(body.productIds) ? [...new Set(body.productIds.map(String).filter(Boolean))] : [];
  const courseOfferingIds: string[] = Array.isArray(body.courseOfferingIds) ? [...new Set(body.courseOfferingIds.map(String).filter(Boolean))] : [];
  if (title.length < 2) return problem(400, "invalid_title", "Enter an offer title.");
  if (!Number.isSafeInteger(priceCents) || priceCents < 50) return problem(400, "invalid_price", "Price must be at least 50 cents.");
  if (!productIds.length && !courseOfferingIds.length) return problem(400, "invalid_products", "Choose one or more products you own.");
  if (!await validateProducts(env.DB, creatorId, productIds)) return problem(400, "invalid_products", "Choose standalone products you own.");
  if (!await validateCourseOfferings(env.DB, creatorId, courseOfferingIds)) return problem(400, "invalid_courses", "Choose published course offers you own.");
  const courseRows = courseOfferingIds.length ? await env.DB.prepare(
    `SELECT co.id AS course_offering_id, co.course_id, c.content_version FROM course_offerings co
     JOIN courses c ON c.id = co.course_id
     WHERE co.id IN (${courseOfferingIds.map(() => "?").join(",")})`
  ).bind(...courseOfferingIds).all<{ course_offering_id: string; course_id: string; content_version: number }>() : { results: [] };
  const id = crypto.randomUUID();
  const courseId = `commerce-${id}`;
  const offeringId = `commerce-offering-${id}`;
  const slug = `product-offer-${id}`;
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO courses (id, tutor_id, slug, title, description, subject, primary_level, delivery_mode,
       price_cents, creator_price_cents, currency, status, listing_status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'Product offer', 'All learners', 'self-paced', ?, ?, ?, 'draft', 'unlisted', ?, ?)`
    ).bind(courseId, creatorId, slug, title, description || title, priceCents, priceCents, currency, now, now),
    env.DB.prepare(
      `INSERT INTO course_offerings (id, course_id, academic_term_id, title, price_cents, creator_price_cents,
       currency, capacity, enrolment_opens_at, enrolment_closes_at, access_ends_at, status, created_at, updated_at)
       VALUES (?, ?, 'academic-term-legacy', ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?)`
    ).bind(offeringId, courseId, title, priceCents, priceCents, currency,
      body.capacity == null || body.capacity === "" ? null : Number(body.capacity), optionalDate(body.enrolmentOpensAt),
      optionalDate(body.enrolmentClosesAt), optionalDate(body.accessEndsAt), now, now),
    env.DB.prepare(
      `INSERT INTO product_offers (id, creator_user_id, title, description, price_cents, currency,
       enrolment_opens_at, enrolment_closes_at, access_ends_at, capacity, commerce_course_id,
       commerce_offering_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(id, creatorId, title, description, priceCents, currency, optionalDate(body.enrolmentOpensAt),
      optionalDate(body.enrolmentClosesAt), optionalDate(body.accessEndsAt),
      body.capacity == null || body.capacity === "" ? null : Number(body.capacity), courseId, offeringId, now, now),
    ...productIds.flatMap((productId, index) => [
      env.DB.prepare(`INSERT INTO product_offer_items (product_offer_id, learning_product_id, position, created_at, content_version)
        SELECT ?, id, ?, ?, content_version FROM learning_products WHERE id = ?`)
        .bind(id, index + 1, now, productId),
      env.DB.prepare(`INSERT INTO course_offering_learning_products (course_offering_id, learning_product_id, position) VALUES (?, ?, ?)`)
        .bind(offeringId, productId, index + 1)
    ]),
    ...courseRows.results.map((course, index) => env.DB.prepare(
      `INSERT INTO product_offer_course_items (product_offer_id, course_id, course_offering_id, position, created_at, content_version)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).bind(id, course.course_id, course.course_offering_id, productIds.length + index + 1, now, course.content_version))
  ]);
  return json({ offer: await offerDetail(env.DB, id, creatorId) }, { status: 201 });
}

async function updateOffer(request: Request, env: ApiEnvironment, creatorId: string, id: string) {
  const current = await offerDetail(env.DB, id, creatorId);
  if (!current) return problem(404, "offer_not_found", "Offer not found.");
  if (current.status !== "draft") return problem(409, "offer_locked", "Only draft offers can be edited.");
  const body = await request.json<OfferInput>().catch(() => ({} as OfferInput));
  const title = text(body.title, 160) || String(current.title);
  const description = body.description === undefined ? String(current.description) : text(body.description, 2000);
  const priceCents = body.priceCents === undefined ? Number(current.price_cents) : Number(body.priceCents);
  if (!Number.isSafeInteger(priceCents) || priceCents < 50) return problem(400, "invalid_price", "Price must be at least 50 cents.");
  const version = priceCents === Number(current.price_cents) ? Number(current.pricing_version) : Number(current.pricing_version) + 1;
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(`UPDATE product_offers SET title = ?, description = ?, price_cents = ?, pricing_version = ?, pricing_status = 'pending',
      enrolment_opens_at = ?, enrolment_closes_at = ?, access_ends_at = ?, capacity = ?, updated_at = ? WHERE id = ?`)
      .bind(title, description, priceCents, version, body.enrolmentOpensAt === undefined ? current.enrolment_opens_at : optionalDate(body.enrolmentOpensAt), body.enrolmentClosesAt === undefined ? current.enrolment_closes_at : optionalDate(body.enrolmentClosesAt), body.accessEndsAt === undefined ? current.access_ends_at : optionalDate(body.accessEndsAt), body.capacity === undefined ? current.capacity : body.capacity == null || body.capacity === "" ? null : Number(body.capacity), now, id),
    env.DB.prepare(`UPDATE courses SET title = ?, description = ?, price_cents = ?, creator_price_cents = ?, pricing_version = ?, updated_at = ? WHERE id = ?`)
      .bind(title, description || title, priceCents, priceCents, version, now, current.commerce_course_id),
    env.DB.prepare(`UPDATE course_offerings SET title = ?, price_cents = ?, creator_price_cents = ?, pricing_version = ?, pricing_status = 'pending',
      enrolment_opens_at = ?, enrolment_closes_at = ?, access_ends_at = ?, capacity = ?, updated_at = ? WHERE id = ?`)
      .bind(title, priceCents, priceCents, version, body.enrolmentOpensAt === undefined ? current.enrolment_opens_at : optionalDate(body.enrolmentOpensAt), body.enrolmentClosesAt === undefined ? current.enrolment_closes_at : optionalDate(body.enrolmentClosesAt), body.accessEndsAt === undefined ? current.access_ends_at : optionalDate(body.accessEndsAt), body.capacity === undefined ? current.capacity : body.capacity == null || body.capacity === "" ? null : Number(body.capacity), now, current.commerce_offering_id)
  ]);
  return json({ offer: await offerDetail(env.DB, id, creatorId) });
}

async function addItem(request: Request, env: ApiEnvironment, creatorId: string, id: string) {
  const offer = await offerDetail(env.DB, id, creatorId);
  if (!offer) return problem(404, "offer_not_found", "Offer not found.");
  if (offer.status !== "draft") return problem(409, "offer_locked", "Only draft offers can be changed.");
  const body = await request.json<{ productId?: string; position?: number }>().catch(() => ({} as { productId?: string; position?: number }));
  const productId = String(body.productId ?? "").trim();
  if (!await validateProducts(env.DB, creatorId, [productId])) return problem(400, "invalid_product", "Choose a product you own.");
  const position = Number.isInteger(body.position) && Number(body.position) > 0 ? Number(body.position) : Number(offer.product_count) + 1;
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO product_offer_items (product_offer_id, learning_product_id, position, created_at, content_version)
      SELECT ?, id, ?, ?, content_version FROM learning_products WHERE id = ?
      ON CONFLICT(product_offer_id, learning_product_id) DO UPDATE SET position = excluded.position, content_version = excluded.content_version`).bind(id, position, now, productId),
    env.DB.prepare(`INSERT INTO course_offering_learning_products (course_offering_id, learning_product_id, position) VALUES (?, ?, ?)
      ON CONFLICT(course_offering_id, learning_product_id) DO UPDATE SET position = excluded.position`).bind(offer.commerce_offering_id, productId, position)
  ]);
  return json({ offer: await offerDetail(env.DB, id, creatorId) });
}

async function removeItem(env: ApiEnvironment, creatorId: string, id: string, productId: string) {
  const offer = await offerDetail(env.DB, id, creatorId);
  if (!offer) return problem(404, "offer_not_found", "Offer not found.");
  if (offer.status !== "draft") return problem(409, "offer_locked", "Only draft offers can be changed.");
  await env.DB.batch([
    env.DB.prepare("DELETE FROM product_offer_items WHERE product_offer_id = ? AND learning_product_id = ?").bind(id, productId),
    env.DB.prepare("DELETE FROM course_offering_learning_products WHERE course_offering_id = ? AND learning_product_id = ?").bind(offer.commerce_offering_id, productId)
  ]);
  return json({ offer: await offerDetail(env.DB, id, creatorId) });
}

async function publishOffer(env: ApiEnvironment, creatorId: string, id: string) {
  const offer = await offerDetail(env.DB, id, creatorId);
  if (!offer) return problem(404, "offer_not_found", "Offer not found.");
  if (Number(offer.price_cents) > 0 && !await creatorCanReceivePayouts(env, creatorId)) {
    return problem(409, "payout_setup_required", "Complete Stripe payout setup before publishing a paid offer.");
  }
  const ids = (offer.items as Array<{ id: string }>).map((item) => item.id);
  if (!await validateProducts(env.DB, creatorId, ids, true)) return problem(409, "products_not_ready", "Every included product must be published and listed before this offer can be published.");
  const courseOfferingIds = (offer.courseItems as Array<{ course_offering_id: string }>).map((item) => item.course_offering_id);
  if (!await validateCourseOfferings(env.DB, creatorId, courseOfferingIds)) return problem(409, "courses_not_ready", "Every included course must have a published, priced learning offer.");
  if (!env.STRIPE_SECRET_KEY) return problem(503, "stripe_not_configured", "Stripe pricing is not configured.");
  const pricingRecord: OfferingPricingRecord = {
    id: String(offer.commerce_offering_id), course_id: String(offer.commerce_course_id),
    course_title: String(offer.title), course_description: String(offer.description || offer.title),
    title: String(offer.title), price_cents: Number(offer.price_cents), currency: String(offer.currency),
    pricing_version: Number(offer.pricing_version), stripe_product_id: offer.stripe_product_id ? String(offer.stripe_product_id) : null,
    stripe_price_id: offer.stripe_price_id ? String(offer.stripe_price_id) : null
  };
  await env.DB.prepare("UPDATE product_offers SET pricing_status = 'syncing', updated_at = ? WHERE id = ?").bind(new Date().toISOString(), id).run();
  try {
    const pricing = await syncOfferingPricing(env.STRIPE_SECRET_KEY, pricingRecord);
    await persistSyncedOfferingPricing(env.DB, pricingRecord, pricing);
    const now = new Date().toISOString();
    await env.DB.batch([
      env.DB.prepare("UPDATE product_offer_prices SET active = 0 WHERE product_offer_id = ?").bind(id),
      env.DB.prepare(`INSERT INTO product_offer_prices (id, product_offer_id, stripe_price_id, amount_cents, currency, pricing_version, active, created_at)
        VALUES (?, ?, ?, ?, ?, ?, 1, ?) ON CONFLICT(product_offer_id, pricing_version) DO UPDATE SET stripe_price_id = excluded.stripe_price_id, amount_cents = excluded.amount_cents, currency = excluded.currency, active = 1`)
        .bind(crypto.randomUUID(), id, pricing.stripePriceId, offer.price_cents, offer.currency, offer.pricing_version, now),
      env.DB.prepare(`UPDATE product_offers SET stripe_product_id = ?, stripe_price_id = ?, pricing_status = 'ready', status = 'published', published_at = COALESCE(published_at, ?), updated_at = ? WHERE id = ?`)
        .bind(pricing.stripeProductId, pricing.stripePriceId, now, now, id),
      env.DB.prepare(`UPDATE course_offerings SET ends_at = COALESCE((
          SELECT MAX(COALESCE((SELECT MAX(s.ends_at) FROM course_sessions s WHERE s.course_offering_id = ci.course_offering_id AND s.status != 'cancelled'), included.ends_at, included.access_ends_at))
          FROM product_offer_course_items ci JOIN course_offerings included ON included.id = ci.course_offering_id
          WHERE ci.product_offer_id = ?
        ), ends_at), updated_at = ? WHERE id = ?`).bind(id, now, offer.commerce_offering_id)
    ]);
    await archivePreviousStripePrice(env.STRIPE_SECRET_KEY, pricing);
    return json({ offer: await offerDetail(env.DB, id, creatorId) });
  } catch (error) {
    await env.DB.prepare("UPDATE product_offers SET pricing_status = 'failed', updated_at = ? WHERE id = ?").bind(new Date().toISOString(), id).run();
    return problem(502, "pricing_sync_failed", error instanceof Error ? error.message : "Offer pricing could not be published.");
  }
}

async function unpublishOffer(env: ApiEnvironment, creatorId: string, id: string) {
  const offer = await offerDetail(env.DB, id, creatorId);
  if (!offer) return problem(404, "offer_not_found", "Offer not found.");
  await env.DB.batch([
    env.DB.prepare("UPDATE product_offers SET status = 'closed', updated_at = ? WHERE id = ?").bind(new Date().toISOString(), id),
    env.DB.prepare("UPDATE course_offerings SET status = 'closed', updated_at = ? WHERE id = ?").bind(new Date().toISOString(), offer.commerce_offering_id)
  ]);
  return json({ offer: await offerDetail(env.DB, id, creatorId) });
}

export async function handleProductOfferRequest(request: Request, env: ApiEnvironment, pathname: string): Promise<Response | null> {
  if (!pathname.startsWith("/api/creator/product-offers")) return null;
  const actor = await getCreatorActorById(actorId(request), env.DB);
  if (!actor) return problem(401, "authentication_required", "Sign in as a creator to manage offers.");
  if (pathname === "/api/creator/product-offers") {
    if (request.method === "GET") return listOffers(request, env, actor.id);
    if (request.method === "POST") return createOffer(request, env, actor.id);
  }
  const item = pathname.match(/^\/api\/creator\/product-offers\/([^/]+)\/items\/([^/]+)$/);
  if (request.method === "DELETE" && item) return removeItem(env, actor.id, decodeURIComponent(item[1]), decodeURIComponent(item[2]));
  const items = pathname.match(/^\/api\/creator\/product-offers\/([^/]+)\/items$/);
  if (request.method === "POST" && items) return addItem(request, env, actor.id, decodeURIComponent(items[1]));
  const action = pathname.match(/^\/api\/creator\/product-offers\/([^/]+)\/(publish|unpublish)$/);
  if (request.method === "POST" && action) return action[2] === "publish" ? publishOffer(env, actor.id, decodeURIComponent(action[1])) : unpublishOffer(env, actor.id, decodeURIComponent(action[1]));
  const detail = pathname.match(/^\/api\/creator\/product-offers\/([^/]+)$/);
  if (detail) {
    if (request.method === "GET") {
      const offer = await offerDetail(env.DB, decodeURIComponent(detail[1]), actor.id);
      return offer ? json({ offer }) : problem(404, "offer_not_found", "Offer not found.");
    }
    if (request.method === "PATCH") return updateOffer(request, env, actor.id, decodeURIComponent(detail[1]));
  }
  return null;
}
