import { env as cloudflareEnv } from "cloudflare:workers";
import type { CourseSummary } from "@/lib/courses";
import type { LearningProduct } from "@/lib/learning-products";
import type { MarketplaceOffer, MarketplaceOfferItem } from "@/lib/offers";

type CourseListResponse = { courses: CourseSummary[] };
type CourseResponse = { course: CourseSummary };
type LearningProductListResponse = { products: LearningProduct[] };
type LearningProductResponse = { product: LearningProduct };
type OfferListResponse = { offers: MarketplaceOffer[] };
type OfferResponse = { offer: MarketplaceOffer; items: MarketplaceOfferItem[] };

export type ApiRequestOptions = {
  userId?: string;
  method?: string;
  body?: unknown;
};

export async function requestApi(path: string, options: ApiRequestOptions = {}): Promise<Response> {
  const env = cloudflareEnv as unknown as AppEnvironment;
  const headers = new Headers();
  if (options.userId) headers.set("x-pencilscope-user-id", options.userId);
  if (options.body !== undefined) headers.set("content-type", "application/json");
  return env.API.fetch(new Request(`https://pencilscope-api.internal${path}`, {
    method: options.method ?? "GET",
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body)
  }));
}

export async function listPublishedCourses(): Promise<CourseSummary[]> {
  try {
    const response = await requestApi("/api/courses");
    if (!response.ok) throw new Error(`Course API returned ${response.status}`);
    const result = await response.json<CourseListResponse>();
    return result.courses;
  } catch (error) {
    console.warn("courses.api.unavailable", { error });
    return [];
  }
}

export async function findCourseBySlug(slug: string): Promise<CourseSummary | undefined> {
  try {
    const response = await requestApi(`/api/courses/${encodeURIComponent(slug)}`);
    if (response.status === 404) return undefined;
    if (!response.ok) throw new Error(`Course API returned ${response.status}`);
    const result = await response.json<CourseResponse>();
    return result.course;
  } catch (error) {
    console.warn("course.api.unavailable", { slug, error });
    return undefined;
  }
}

export async function listPublishedLearningProducts(type?: string): Promise<LearningProduct[]> {
  try {
    const query = type ? `?type=${encodeURIComponent(type)}` : "";
    const response = await requestApi(`/api/learning-products${query}`);
    if (!response.ok) throw new Error(`Learning product API returned ${response.status}`);
    return (await response.json<LearningProductListResponse>()).products;
  } catch (error) {
    console.warn("learning-products.api.unavailable", { error });
    return [];
  }
}

export async function findLearningProductBySlug(slug: string, userId?: string): Promise<LearningProduct | undefined> {
  try {
    const response = await requestApi(`/api/learning-products/${encodeURIComponent(slug)}`, { userId });
    if (response.status === 404) return undefined;
    if (!response.ok) throw new Error(`Learning product API returned ${response.status}`);
    return (await response.json<LearningProductResponse>()).product;
  } catch (error) {
    console.warn("learning-product.api.unavailable", { slug, error });
    return undefined;
  }
}

export async function listPublishedOffers(filters: { q?: string; type?: string; kind?: string; topic?: string; delivery?: string; availability?: string; sort?: string } = {}): Promise<MarketplaceOffer[]> {
  try {
    const query = new URLSearchParams();
    if (filters.q) query.set("q", filters.q);
    if (filters.type) query.set("type", filters.type);
    if (filters.kind) query.set("kind", filters.kind);
    if (filters.topic) query.set("topic", filters.topic);
    if (filters.delivery) query.set("delivery", filters.delivery);
    if (filters.availability) query.set("availability", filters.availability);
    if (filters.sort) query.set("sort", filters.sort);
    const response = await requestApi(`/api/offers${query.size ? `?${query}` : ""}`);
    if (!response.ok) throw new Error(`Offer API returned ${response.status}`);
    return (await response.json<OfferListResponse>()).offers;
  } catch (error) {
    console.warn("offers.api.unavailable", { error });
    return [];
  }
}

export async function findPublishedOffer(slug: string): Promise<OfferResponse | undefined> {
  try {
    const response = await requestApi(`/api/offers/${encodeURIComponent(slug)}`);
    if (response.status === 404) return undefined;
    if (!response.ok) throw new Error(`Offer API returned ${response.status}`);
    return response.json<OfferResponse>();
  } catch (error) {
    console.warn("offer.api.unavailable", { slug, error });
    return undefined;
  }
}
