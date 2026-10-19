export type MarketplaceOffer = {
  id: string;
  slug: string;
  courseId: string | null;
  offerKind: "course" | "independent" | "bundle";
  title: string;
  description: string;
  creatorName: string;
  priceCents: number;
  currency: string;
  enrolmentOpensAt: string | null;
  enrolmentClosesAt: string | null;
  accessEndsAt: string | null;
  startsAt: string | null;
  endsAt: string | null;
  capacity: number | null;
  enrolledCount: number;
  availability: "available" | "opens_soon" | "sold_out" | "closed";
  deliveryMode: string;
  coverAssetId: string | null;
  itemCount: number;
  courseCount: number;
  formats: string[];
  topics: string[];
  includedTitles: string[];
  updatedAt: string;
};

export type MarketplaceOfferItem = {
  id: string;
  slug: string;
  title: string;
  description: string;
  productType: string;
  estimatedMinutes: number | null;
  position: number;
  courseOfferingId?: string;
  offeringTitle?: string;
  deliveryMode?: string;
  startsAt?: string | null;
  endsAt?: string | null;
};

export const offerPrice = (offer: Pick<MarketplaceOffer, "priceCents" | "currency">) => offer.currency === "SGD"
  ? `S$${new Intl.NumberFormat("en-SG", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(offer.priceCents / 100)}`
  : new Intl.NumberFormat("en-SG", { style: "currency", currency: offer.currency }).format(offer.priceCents / 100);

export const offerAvailabilityLabel: Record<MarketplaceOffer["availability"], string> = {
  available: "Available",
  opens_soon: "Opens soon",
  sold_out: "Sold out",
  closed: "Closed"
};
