export const learningProductTypes = [
  "ebook",
  "reading",
  "quiz",
  "test",
  "mock_exam",
  "video",
  "audio"
] as const;

export type LearningProductType = typeof learningProductTypes[number];

export type LearningProductQuestion = {
  id?: string;
  prompt: string;
  options: string[];
  correctIndex?: number;
  explanation?: string;
  media?: {
    libraryItemId: string;
    mediaType: "image" | "video" | "audio";
    altText: string;
    caption: string;
    contentUrl?: string;
  };
};

export type LearningProduct = {
  id: string;
  creator_id: string;
  creator_name: string;
  slug: string;
  product_type: LearningProductType;
  title: string;
  description: string;
  subject: string;
  audience: string;
  content_url: string | null;
  content_json?: string;
  estimated_minutes: number | null;
  price_cents: number;
  currency: string;
  status: "draft" | "published" | "archived";
  listing_status?: "listed" | "unpublished";
  source_product_id?: string | null;
  content_version?: number;
  published_at: string | null;
  created_at?: string;
  updated_at?: string;
  question_count?: number;
  questions?: LearningProductQuestion[];
  passing_score?: number;
  time_limit_minutes?: number | null;
  owned?: number | boolean;
  has_access?: number | boolean;
  offer_course_slug?: string | null;
  offer_title?: string | null;
  offer_price_cents?: number | null;
};

export const learningProductMeta: Record<LearningProductType, {
  label: string;
  plural: string;
  symbol: string;
  action: string;
  description: string;
  assessment: boolean;
}> = {
  ebook: { label: "Ebook", plural: "Ebooks", symbol: "▤", action: "Read ebook", description: "A focused digital book you can read on its own.", assessment: false },
  reading: { label: "Reading", plural: "Readings", symbol: "¶", action: "Open reading", description: "An article, guide or reference for focused study.", assessment: false },
  quiz: { label: "Quiz", plural: "Quizzes", symbol: "✓", action: "Take quiz", description: "A quick knowledge check with immediate results.", assessment: true },
  test: { label: "Test", plural: "Tests", symbol: "T", action: "Start test", description: "A structured assessment of your understanding.", assessment: true },
  mock_exam: { label: "Mock exam", plural: "Mock exams", symbol: "M", action: "Start mock exam", description: "Realistic practice before the real assessment.", assessment: true },
  video: { label: "Video", plural: "Videos", symbol: "▶", action: "Watch video", description: "A standalone video lesson or demonstration.", assessment: false },
  audio: { label: "Audio book", plural: "Audio books", symbol: "♫", action: "Listen now", description: "A narrated book or listen-first learning experience.", assessment: false }
};

export function isLearningProductType(value: unknown): value is LearningProductType {
  return typeof value === "string" && learningProductTypes.includes(value as LearningProductType);
}

export function isAssessmentProduct(type: LearningProductType): boolean {
  return learningProductMeta[type].assessment;
}
