import { json, problem } from "../../../src/lib/http";
import { offeringCommerceReadySql } from "../../../src/lib/offering-readiness";
import type { ApiEnvironment } from "./index";

type OfferRow = {
  id: string; slug: string; course_id: string | null; offer_kind: "course" | "independent" | "bundle"; title: string; description: string;
  creator_name: string; price_cents: number; currency: string; enrolment_opens_at: string | null;
  enrolment_closes_at: string | null; access_ends_at: string | null; capacity: number | null;
  starts_at: string | null; ends_at: string | null; delivery_mode: string; cover_asset_id: string | null;
  item_count: number; course_count: number; formats: string; topics: string; included_titles: string;
  languages: string; estimated_minutes: number;
  enrolled_count: number; updated_at: string;
};

const availability = (offer: OfferRow) => {
  const now = Date.now();
  if (offer.enrolment_opens_at && Date.parse(offer.enrolment_opens_at) > now) return "opens_soon";
  if (offer.enrolment_closes_at && Date.parse(offer.enrolment_closes_at) < now) return "closed";
  if (offer.capacity !== null && Number(offer.enrolled_count) >= Number(offer.capacity)) return "sold_out";
  return "available";
};

const splitDistinct = (value: string, separator: string) => [...new Set(String(value || "").split(separator).map((item) => item.trim()).filter(Boolean))];

const publicOffer = (offer: OfferRow) => ({
  id: offer.id,
  slug: offer.slug,
  courseId: offer.course_id,
  offerKind: offer.offer_kind,
  title: offer.title,
  description: offer.description,
  creatorName: offer.creator_name,
  priceCents: Number(offer.price_cents),
  currency: offer.currency,
  enrolmentOpensAt: offer.enrolment_opens_at,
  enrolmentClosesAt: offer.enrolment_closes_at,
  accessEndsAt: offer.access_ends_at,
  startsAt: offer.starts_at,
  endsAt: offer.ends_at,
  capacity: offer.capacity === null ? null : Number(offer.capacity),
  enrolledCount: Number(offer.enrolled_count),
  availability: availability(offer),
  deliveryMode: offer.delivery_mode,
  coverAssetId: offer.cover_asset_id,
  itemCount: Number(offer.item_count),
  courseCount: Number(offer.course_count),
  formats: [...new Set(String(offer.formats || "").split(",").filter(Boolean))],
  topics: splitDistinct(offer.topics, "¦"),
  includedTitles: splitDistinct(offer.included_titles, "¦"),
  languages: splitDistinct(offer.languages, ","),
  estimatedMinutes: Number(offer.estimated_minutes || 0),
  updatedAt: offer.updated_at
});

async function offerRows(env: ApiEnvironment): Promise<OfferRow[]> {
  const productOffers = await env.DB.prepare(
    `SELECT po.id, 'product-' || po.id AS slug, NULL AS course_id,
       CASE WHEN ((SELECT COUNT(*) FROM product_offer_items pi WHERE pi.product_offer_id = po.id)
         + (SELECT COUNT(*) FROM product_offer_course_items ci WHERE ci.product_offer_id = po.id)) > 1 THEN 'bundle'
         WHEN EXISTS (SELECT 1 FROM product_offer_course_items ci WHERE ci.product_offer_id = po.id) THEN 'course'
         ELSE 'independent' END AS offer_kind,
       po.title, po.description,
       COALESCE(ap.organization_name, cp.public_name, u.display_name, 'PencilScope Creator') AS creator_name,
       po.price_cents, po.currency, po.enrolment_opens_at, po.enrolment_closes_at, po.access_ends_at,
       po.capacity,
       (SELECT MIN(co.starts_at) FROM product_offer_course_items ci JOIN course_offerings co ON co.id = ci.course_offering_id WHERE ci.product_offer_id = po.id) AS starts_at,
       (SELECT MAX(COALESCE(co.ends_at, co.access_ends_at)) FROM product_offer_course_items ci JOIN course_offerings co ON co.id = ci.course_offering_id WHERE ci.product_offer_id = po.id) AS ends_at,
       COALESCE((SELECT GROUP_CONCAT(DISTINCT co.delivery_mode) FROM product_offer_course_items ci JOIN course_offerings co ON co.id = ci.course_offering_id WHERE ci.product_offer_id = po.id), 'self_paced') AS delivery_mode,
       (SELECT c.cover_asset_id FROM product_offer_course_items ci JOIN courses c ON c.id = ci.course_id WHERE ci.product_offer_id = po.id AND c.cover_asset_id IS NOT NULL ORDER BY ci.position LIMIT 1) AS cover_asset_id,
       ((SELECT COUNT(*) FROM product_offer_items pi WHERE pi.product_offer_id = po.id)
         + (SELECT COUNT(*) FROM product_offer_course_items ci WHERE ci.product_offer_id = po.id)) AS item_count,
       (SELECT COUNT(*) FROM product_offer_course_items ci WHERE ci.product_offer_id = po.id) AS course_count,
       TRIM(COALESCE((SELECT GROUP_CONCAT(p.product_type) FROM product_offer_items pi JOIN learning_products p ON p.id = pi.learning_product_id WHERE pi.product_offer_id = po.id), '')
         || CASE WHEN EXISTS (SELECT 1 FROM product_offer_course_items ci WHERE ci.product_offer_id = po.id) THEN ',course' ELSE '' END, ',') AS formats,
       TRIM(COALESCE((SELECT GROUP_CONCAT(p.subject, '¦') FROM product_offer_items pi JOIN learning_products p ON p.id = pi.learning_product_id WHERE pi.product_offer_id = po.id), '')
         || CASE WHEN EXISTS (SELECT 1 FROM product_offer_course_items ci WHERE ci.product_offer_id = po.id) THEN '¦' || COALESCE((SELECT GROUP_CONCAT(c.subject, '¦') FROM product_offer_course_items ci JOIN courses c ON c.id = ci.course_id WHERE ci.product_offer_id = po.id), '') ELSE '' END, '¦') AS topics,
       TRIM(COALESCE((SELECT GROUP_CONCAT(p.title, '¦') FROM product_offer_items pi JOIN learning_products p ON p.id = pi.learning_product_id WHERE pi.product_offer_id = po.id), '')
         || CASE WHEN EXISTS (SELECT 1 FROM product_offer_course_items ci WHERE ci.product_offer_id = po.id) THEN '¦' || COALESCE((SELECT GROUP_CONCAT(c.title, '¦') FROM product_offer_course_items ci JOIN courses c ON c.id = ci.course_id WHERE ci.product_offer_id = po.id), '') ELSE '' END, '¦') AS included_titles,
       TRIM(COALESCE((SELECT GROUP_CONCAT(DISTINCT p.language_code) FROM product_offer_items pi JOIN learning_products p ON p.id = pi.learning_product_id WHERE pi.product_offer_id = po.id), '')
         || CASE WHEN EXISTS (SELECT 1 FROM product_offer_course_items ci WHERE ci.product_offer_id = po.id) THEN ',' || COALESCE((SELECT GROUP_CONCAT(DISTINCT c.language_code) FROM product_offer_course_items ci JOIN courses c ON c.id = ci.course_id WHERE ci.product_offer_id = po.id), '') ELSE '' END, ',') AS languages,
       COALESCE((SELECT SUM(COALESCE(p.estimated_minutes, 0)) FROM product_offer_items pi JOIN learning_products p ON p.id = pi.learning_product_id WHERE pi.product_offer_id = po.id), 0)
         + COALESCE((SELECT SUM(COALESCE(l.estimated_minutes, 0)) FROM product_offer_course_items ci JOIN course_modules m ON m.course_id = ci.course_id JOIN lessons l ON l.module_id = m.id WHERE ci.product_offer_id = po.id), 0) AS estimated_minutes,
       (SELECT COUNT(*) FROM enrolment_offerings eo WHERE eo.course_offering_id = po.commerce_offering_id AND eo.status IN ('active', 'completed')) AS enrolled_count,
       po.updated_at
     FROM product_offers po JOIN users u ON u.id = po.creator_user_id
     LEFT JOIN account_profiles ap ON ap.user_id = po.creator_user_id
     LEFT JOIN creator_profiles cp ON cp.user_id = po.creator_user_id
     WHERE po.status = 'published' AND po.pricing_status = 'ready' AND po.stripe_price_id IS NOT NULL
       AND po.price_cents >= 50
       AND ((SELECT COUNT(*) FROM product_offer_items pi WHERE pi.product_offer_id = po.id)
         + (SELECT COUNT(*) FROM product_offer_course_items ci WHERE ci.product_offer_id = po.id)) > 0`
  ).all<OfferRow>();
  const courseOffers = await env.DB.prepare(
    `SELECT co.id, 'course-' || co.id AS slug, co.course_id, 'course' AS offer_kind, co.title,
       c.description, COALESCE(ap.organization_name, cp.public_name, u.display_name, 'PencilScope Creator') AS creator_name,
       co.price_cents, co.currency, co.enrolment_opens_at, co.enrolment_closes_at, co.access_ends_at,
       co.capacity, co.starts_at, co.ends_at, co.delivery_mode, c.cover_asset_id,
       1 + (SELECT COUNT(*) FROM course_offering_learning_products olp WHERE olp.course_offering_id = co.id) AS item_count,
       1 AS course_count,
       'course' || COALESCE((SELECT ',' || GROUP_CONCAT(p.product_type) FROM course_offering_learning_products olp JOIN learning_products p ON p.id = olp.learning_product_id WHERE olp.course_offering_id = co.id), '') AS formats,
       c.subject || COALESCE((SELECT '¦' || GROUP_CONCAT(cc.title, '¦') FROM course_category_links ccl JOIN course_categories cc ON cc.id = ccl.category_id WHERE ccl.course_id = c.id AND cc.active = 1), '') AS topics,
       c.title || COALESCE((SELECT '¦' || GROUP_CONCAT(p.title, '¦') FROM course_offering_learning_products olp JOIN learning_products p ON p.id = olp.learning_product_id WHERE olp.course_offering_id = co.id), '') AS included_titles,
       c.language_code || COALESCE((SELECT ',' || GROUP_CONCAT(DISTINCT p.language_code) FROM course_offering_learning_products olp JOIN learning_products p ON p.id = olp.learning_product_id WHERE olp.course_offering_id = co.id), '') AS languages,
       COALESCE((SELECT SUM(COALESCE(l.estimated_minutes, 0)) FROM course_modules m JOIN lessons l ON l.module_id = m.id WHERE m.course_id = c.id), 0)
         + COALESCE((SELECT SUM(COALESCE(p.estimated_minutes, 0)) FROM course_offering_learning_products olp JOIN learning_products p ON p.id = olp.learning_product_id WHERE olp.course_offering_id = co.id), 0) AS estimated_minutes,
       (SELECT COUNT(*) FROM enrolment_offerings eo WHERE eo.course_offering_id = co.id AND eo.status IN ('active', 'completed')) AS enrolled_count,
       co.updated_at
     FROM course_offerings co JOIN courses c ON c.id = co.course_id JOIN users u ON u.id = c.tutor_id
     LEFT JOIN account_profiles ap ON ap.user_id = c.tutor_id LEFT JOIN creator_profiles cp ON cp.user_id = c.tutor_id
     WHERE c.status = 'published' AND c.listing_status = 'listed' AND ${offeringCommerceReadySql("co")}
       AND NOT EXISTS (SELECT 1 FROM product_offers po WHERE po.commerce_offering_id = co.id)`
  ).all<OfferRow>();
  return [...productOffers.results, ...courseOffers.results]
    .sort((left, right) => String(right.updated_at).localeCompare(String(left.updated_at)));
}

async function offerItems(env: ApiEnvironment, offer: OfferRow) {
  if (offer.slug.startsWith("product-")) {
    const products = await env.DB.prepare(
      `SELECT p.id, p.slug, p.title, p.description, p.product_type AS productType,
        p.estimated_minutes AS estimatedMinutes, pi.position
       FROM product_offer_items pi JOIN learning_products p ON p.id = pi.learning_product_id
       WHERE pi.product_offer_id = ? AND p.status = 'published' ORDER BY pi.position`
    ).bind(offer.id).all();
    const courses = await env.DB.prepare(
      `SELECT c.id, c.slug, c.title, c.description, 'course' AS productType,
        NULL AS estimatedMinutes, ci.position, co.id AS courseOfferingId, co.title AS offeringTitle,
        co.delivery_mode AS deliveryMode, co.starts_at AS startsAt, co.ends_at AS endsAt
       FROM product_offer_course_items ci JOIN courses c ON c.id = ci.course_id
       JOIN course_offerings co ON co.id = ci.course_offering_id
       WHERE ci.product_offer_id = ? AND c.status = 'published' ORDER BY ci.position`
    ).bind(offer.id).all();
    return [...products.results, ...courses.results].sort((a: any, b: any) => Number(a.position) - Number(b.position));
  }
  const course = await env.DB.prepare(
    `SELECT c.id, c.slug, c.title, c.description, 'course' AS productType, NULL AS estimatedMinutes,
      0 AS position, co.id AS courseOfferingId, co.title AS offeringTitle,
      co.delivery_mode AS deliveryMode, co.starts_at AS startsAt, co.ends_at AS endsAt
     FROM course_offerings co JOIN courses c ON c.id = co.course_id WHERE co.id = ?`
  ).bind(offer.id).first();
  const products = await env.DB.prepare(
    `SELECT p.id, p.slug, p.title, p.description, p.product_type AS productType,
      p.estimated_minutes AS estimatedMinutes, olp.position
     FROM course_offering_learning_products olp JOIN learning_products p ON p.id = olp.learning_product_id
     WHERE olp.course_offering_id = ? AND p.status = 'published' ORDER BY olp.position`
  ).bind(offer.id).all();
  return course ? [course, ...products.results] : products.results;
}

export async function handleMarketplaceOfferRequest(request: Request, env: ApiEnvironment, pathname: string): Promise<Response | null> {
  if (request.method !== "GET") return null;
  if (pathname === "/api/offers") {
    const url = new URL(request.url);
    const query = (url.searchParams.get("q") ?? "").trim().toLocaleLowerCase();
    const type = (url.searchParams.get("type") ?? "").trim();
    const kind = (url.searchParams.get("kind") ?? "").trim();
    const topic = (url.searchParams.get("topic") ?? "").trim().toLocaleLowerCase();
    const delivery = (url.searchParams.get("delivery") ?? "").trim();
    const available = (url.searchParams.get("availability") ?? "").trim();
    const sort = (url.searchParams.get("sort") ?? "relevant").trim();
    const rows = await offerRows(env);
    const offers = rows.map(publicOffer).filter((offer) =>
      (!query || [offer.title, offer.description, offer.creatorName, ...offer.formats, ...offer.topics, ...offer.includedTitles].join(" ").toLocaleLowerCase().includes(query))
      && (!type || (type === "assessment" ? offer.formats.some((format) => ["quiz", "test", "mock_exam"].includes(format))
        : type === "audio" ? offer.formats.some((format) => ["audio", "audio_book"].includes(format)) : offer.formats.includes(type)))
      && (!kind || offer.offerKind === kind)
      && (!topic || offer.topics.some((value) => value.toLocaleLowerCase() === topic))
      && (!delivery || offer.deliveryMode.split(",").some((value) => value === delivery || (delivery === "self_paced" && value === "recorded")))
      && (!available || offer.availability === available)
    ).sort((left, right) => {
      if (sort === "price_low") return left.priceCents - right.priceCents;
      if (sort === "price_high") return right.priceCents - left.priceCents;
      if (sort === "starting_soon") return (left.startsAt ? Date.parse(left.startsAt) : Number.MAX_SAFE_INTEGER) - (right.startsAt ? Date.parse(right.startsAt) : Number.MAX_SAFE_INTEGER);
      if (query) {
        const score = (offer: typeof left) => (offer.title.toLocaleLowerCase().includes(query) ? 4 : 0)
          + (offer.includedTitles.some((title) => title.toLocaleLowerCase().includes(query)) ? 3 : 0)
          + (offer.topics.some((value) => value.toLocaleLowerCase().includes(query)) ? 2 : 0);
        const difference = score(right) - score(left);
        if (difference) return difference;
      }
      return String(right.updatedAt).localeCompare(String(left.updatedAt));
    });
    return json({ offers });
  }
  const detail = pathname.match(/^\/api\/offers\/([^/]+)$/);
  if (!detail) return null;
  const slug = decodeURIComponent(detail[1]);
  const row = (await offerRows(env)).find((offer) => offer.slug === slug);
  if (!row) return problem(404, "offer_not_found", "This offer is not available.");
  return json({ offer: publicOffer(row), items: await offerItems(env, row) });
}
