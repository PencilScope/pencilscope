export type ProductCatalogueKey =
  | "online_course"
  | "in_person_course"
  | "video_course"
  | "audio_book"
  | "ebook"
  | "quiz"
  | "test"
  | "mock_exam";

export type ProductIconName = ProductCatalogueKey | "reading" | "course";

export const creatorProductCatalogue: Array<{
  key: ProductCatalogueKey;
  label: string;
  shortDescription: string;
  href: string;
}> = [
  { key: "online_course", label: "Online course", shortDescription: "Live classes with scheduled online meetings", href: "/tutor?mode=new&product=online_course" },
  { key: "in_person_course", label: "In-person course", shortDescription: "Venue-based classes and workshops", href: "/tutor?mode=new&product=in_person_course" },
  { key: "video_course", label: "Video course", shortDescription: "Recorded, self-paced lessons", href: "/tutor?mode=new&product=video_course" },
  { key: "audio_book", label: "Audio book", shortDescription: "Listen-first narrated learning", href: "/create?type=audio#create-product" },
  { key: "ebook", label: "Ebook", shortDescription: "Write and publish a digital book", href: "/ebook-studio" },
  { key: "quiz", label: "Quiz", shortDescription: "A quick knowledge check", href: "/create?type=quiz#create-product" },
  { key: "test", label: "Test", shortDescription: "A structured assessment", href: "/create?type=test#create-product" },
  { key: "mock_exam", label: "Mock exam", shortDescription: "Realistic timed exam practice", href: "/create?type=mock_exam#create-product" }
];

export function productCatalogueKey(contentType: string, deliveryMode?: string | null): ProductIconName {
  if (contentType === "course") {
    if (deliveryMode === "live") return "online_course";
    if (deliveryMode === "hybrid") return "in_person_course";
    return "video_course";
  }
  if (contentType === "audio") return "audio_book";
  if (contentType === "ebook" || contentType === "quiz" || contentType === "test" || contentType === "mock_exam" || contentType === "reading") return contentType;
  return "course";
}

export function productDisplayLabel(contentType: string, deliveryMode?: string | null): string {
  const key = productCatalogueKey(contentType, deliveryMode);
  return creatorProductCatalogue.find((item) => item.key === key)?.label
    ?? (key === "reading" ? "Reading material" : "Course");
}

export function courseDeliveryModeForProduct(key: string | null): "live" | "hybrid" | "self-paced" {
  if (key === "online_course") return "live";
  if (key === "in_person_course") return "hybrid";
  return "self-paced";
}
