import { offeringCommerceReadySql } from "./offering-readiness";

export type CourseFeature =
  | "live-online"
  | "in-person"
  | "self-paced"
  | "video"
  | "ebook"
  | "quiz"
  | "test"
  | "mock-exam"
  | "flashcards"
  | "ai-practice";

export type CourseSummary = {
  id: string;
  slug: string;
  title: string;
  description: string;
  subject: string;
  level: string;
  deliveryMode: string;
  priceCents: number;
  currency: string;
  tutorName: string;
  accent: string;
  stripePriceId?: string;
  coverAssetId?: string;
  categories: string[];
  features: CourseFeature[];
};

export const sampleCourses: CourseSummary[] = [
  {
    id: "course-maths-5",
    slug: "primary-5-maths-mastery",
    title: "Primary 5 Maths Mastery",
    description: "Build confident problem-solving habits with visual models, guided practice and weekly checkpoints.",
    subject: "Mathematics",
    level: "Primary 5",
    deliveryMode: "Self-paced + live",
    priceCents: 8900,
    currency: "SGD",
    tutorName: "Ms Tan",
    accent: "lime",
    categories: ["Academic"],
    features: ["live-online", "self-paced", "video", "quiz", "test", "mock-exam", "ebook"]
  },
  {
    id: "course-science-4",
    slug: "primary-4-science-lab",
    title: "Primary 4 Science Lab",
    description: "Turn core science topics into memorable experiments, diagrams and exam-ready explanations.",
    subject: "Science",
    level: "Primary 4",
    deliveryMode: "Live cohort",
    priceCents: 12000,
    currency: "SGD",
    tutorName: "Mr Lim",
    accent: "blue",
    categories: ["Academic", "Enrichment"],
    features: ["live-online", "video", "quiz", "test"]
  },
  {
    id: "course-english-3",
    slug: "confident-english-conversations",
    title: "Confident English Conversations",
    description: "Friendly speaking practice with stories, role play and age-appropriate AI-guided revision.",
    subject: "English",
    level: "Primary 3–4",
    deliveryMode: "AI-supported",
    priceCents: 5900,
    currency: "SGD",
    tutorName: "Mrs Koh",
    accent: "coral",
    categories: ["Enrichment", "Personal development"],
    features: ["self-paced", "video", "quiz", "flashcards", "ai-practice"]
  }
];

type CourseRow = {
  id: string;
  slug: string;
  title: string;
  description: string;
  subject: string;
  primary_level: string;
  delivery_mode: string;
  price_cents: number;
  currency: string;
  tutor_name: string;
  accent: string | null;
  stripe_price_id: string | null;
  cover_asset_id: string | null;
  categories: string;
  has_live_online: number;
  has_in_person: number;
  has_self_paced: number;
  has_video: number;
  has_ebook: number;
  has_quiz: number;
  has_test: number;
  has_mock_exam: number;
  has_flashcards: number;
  has_ai_practice: number;
};

const mapCourse = (row: CourseRow): CourseSummary => {
  const featureFlags: Array<[CourseFeature, number]> = [
    ["live-online", row.has_live_online],
    ["in-person", row.has_in_person],
    ["self-paced", row.has_self_paced],
    ["video", row.has_video],
    ["ebook", row.has_ebook],
    ["quiz", row.has_quiz],
    ["test", row.has_test],
    ["mock-exam", row.has_mock_exam],
    ["flashcards", row.has_flashcards],
    ["ai-practice", row.has_ai_practice]
  ];
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    description: row.description,
    subject: row.subject,
    level: row.primary_level,
    deliveryMode: row.delivery_mode,
    priceCents: row.price_cents,
    currency: row.currency,
    tutorName: row.tutor_name,
    accent: row.accent ?? "lime",
    stripePriceId: row.stripe_price_id ?? undefined,
    coverAssetId: row.cover_asset_id ?? undefined,
    categories: row.categories ? row.categories.split("|") : [],
    features: featureFlags.filter(([, enabled]) => Boolean(enabled)).map(([feature]) => feature)
  };
};

export async function listPublishedCourses(db?: D1Database): Promise<CourseSummary[]> {
  if (!db) return sampleCourses;
  try {
    const result = await db
      .prepare(
        `SELECT c.id, c.slug, c.title, c.description, c.subject, c.primary_level,
          c.delivery_mode,
          COALESCE((SELECT MIN(o.price_cents) FROM course_offerings o
            WHERE o.course_id = c.id AND o.status = 'published' AND o.pricing_status = 'ready'
              AND o.stripe_price_id IS NOT NULL AND o.price_cents >= 50), c.price_cents) AS price_cents,
          c.currency, c.accent, c.stripe_price_id, c.cover_asset_id,
          COALESCE(ap.organization_name, cp.public_name, u.display_name, tp.display_name, 'PencilScope Creator') AS tutor_name,
          COALESCE((SELECT GROUP_CONCAT(cc.title, '|') FROM course_category_links cl
            JOIN course_categories cc ON cc.id = cl.category_id
            WHERE cl.course_id = c.id AND cc.active = 1), '') AS categories,
          (EXISTS(SELECT 1 FROM course_offerings o WHERE o.course_id = c.id AND o.status = 'published'
            AND o.delivery_mode IN ('live_online', 'hybrid'))
           OR EXISTS(SELECT 1 FROM course_offerings o JOIN course_sessions s ON s.course_offering_id = o.id
            WHERE o.course_id = c.id AND o.status = 'published' AND s.status = 'scheduled'
              AND s.delivery_mode = 'live_online')) AS has_live_online,
          (EXISTS(SELECT 1 FROM course_offerings o WHERE o.course_id = c.id AND o.status = 'published'
            AND o.delivery_mode IN ('in_person', 'hybrid'))
           OR EXISTS(SELECT 1 FROM course_offerings o JOIN course_sessions s ON s.course_offering_id = o.id
            WHERE o.course_id = c.id AND o.status = 'published' AND s.status = 'scheduled'
              AND s.delivery_mode = 'in_person')) AS has_in_person,
          EXISTS(SELECT 1 FROM course_offerings o WHERE o.course_id = c.id AND o.status = 'published'
            AND o.delivery_mode IN ('recorded', 'hybrid')) AS has_self_paced,
          (EXISTS(SELECT 1 FROM course_offerings o
            JOIN course_offering_modules om ON om.course_offering_id = o.id
            JOIN lessons l ON l.module_id = om.module_id
            WHERE o.course_id = c.id AND o.status = 'published' AND l.lesson_type = 'video')
           OR EXISTS(SELECT 1 FROM course_offerings o
            JOIN course_offering_materials om ON om.course_offering_id = o.id
            JOIN course_materials m ON m.id = om.material_id
            WHERE o.course_id = c.id AND o.status = 'published' AND m.status = 'published'
              AND m.material_type = 'video')
           OR EXISTS(SELECT 1 FROM course_offerings o
            JOIN course_offering_learning_products olp ON olp.course_offering_id = o.id
            JOIN learning_products p ON p.id = olp.learning_product_id
            WHERE o.course_id = c.id AND o.status = 'published' AND p.status = 'published'
              AND p.product_type = 'video')) AS has_video,
          (EXISTS(SELECT 1 FROM course_offerings o
            JOIN course_offering_materials om ON om.course_offering_id = o.id
            JOIN course_materials m ON m.id = om.material_id
            WHERE o.course_id = c.id AND o.status = 'published' AND m.status = 'published'
              AND m.resource_kind = 'ebook')
           OR EXISTS(SELECT 1 FROM course_offerings o
            JOIN course_offering_learning_products olp ON olp.course_offering_id = o.id
            JOIN learning_products p ON p.id = olp.learning_product_id
            WHERE o.course_id = c.id AND o.status = 'published' AND p.status = 'published'
              AND p.product_type = 'ebook')) AS has_ebook,
          (EXISTS(SELECT 1 FROM course_offerings o
            JOIN course_offering_assessments oa ON oa.course_offering_id = o.id
            JOIN assessments a ON a.id = oa.assessment_id
            WHERE o.course_id = c.id AND o.status = 'published' AND a.status = 'published'
              AND a.assessment_type = 'quiz')
           OR EXISTS(SELECT 1 FROM course_offerings o
            JOIN course_offering_learning_products olp ON olp.course_offering_id = o.id
            JOIN learning_products p ON p.id = olp.learning_product_id
            WHERE o.course_id = c.id AND o.status = 'published' AND p.status = 'published'
              AND p.product_type = 'quiz')) AS has_quiz,
          (EXISTS(SELECT 1 FROM course_offerings o
            JOIN course_offering_assessments oa ON oa.course_offering_id = o.id
            JOIN assessments a ON a.id = oa.assessment_id
            WHERE o.course_id = c.id AND o.status = 'published' AND a.status = 'published'
              AND a.assessment_type = 'test')
           OR EXISTS(SELECT 1 FROM course_offerings o
            JOIN course_offering_learning_products olp ON olp.course_offering_id = o.id
            JOIN learning_products p ON p.id = olp.learning_product_id
            WHERE o.course_id = c.id AND o.status = 'published' AND p.status = 'published'
              AND p.product_type = 'test')) AS has_test,
          (EXISTS(SELECT 1 FROM course_offerings o
            JOIN course_offering_assessments oa ON oa.course_offering_id = o.id
            JOIN assessments a ON a.id = oa.assessment_id
            WHERE o.course_id = c.id AND o.status = 'published' AND a.status = 'published'
              AND a.assessment_type = 'mock_exam')
           OR EXISTS(SELECT 1 FROM course_offerings o
            JOIN course_offering_learning_products olp ON olp.course_offering_id = o.id
            JOIN learning_products p ON p.id = olp.learning_product_id
            WHERE o.course_id = c.id AND o.status = 'published' AND p.status = 'published'
              AND p.product_type = 'mock_exam')) AS has_mock_exam,
          EXISTS(SELECT 1 FROM course_offerings o
            JOIN course_offering_flashcard_decks od ON od.course_offering_id = o.id
            JOIN flashcard_decks d ON d.id = od.deck_id
            WHERE o.course_id = c.id AND o.status = 'published' AND d.status = 'published') AS has_flashcards,
          EXISTS(SELECT 1 FROM course_offerings o
            JOIN course_offering_modules om ON om.course_offering_id = o.id
            JOIN lessons l ON l.module_id = om.module_id
            WHERE o.course_id = c.id AND o.status = 'published' AND l.lesson_type = 'ai') AS has_ai_practice
        FROM courses c
        LEFT JOIN users u ON u.id = c.tutor_id
        LEFT JOIN account_profiles ap ON ap.user_id = c.tutor_id
        LEFT JOIN creator_profiles cp ON cp.user_id = c.tutor_id
        LEFT JOIN tutor_profiles tp ON tp.user_id = c.tutor_id
        WHERE c.status = 'published' AND c.listing_status = 'listed'
          AND EXISTS (SELECT 1 FROM course_offerings sale_o
            WHERE sale_o.course_id = c.id AND ${offeringCommerceReadySql("sale_o")})
        ORDER BY c.published_at DESC, c.created_at DESC`
      )
      .all<CourseRow>();
    return result.results.map(mapCourse);
  } catch {
    return [];
  }
}

export async function findCourseBySlug(slug: string, db?: D1Database): Promise<CourseSummary | undefined> {
  const courses = await listPublishedCourses(db);
  return courses.find((course) => course.slug === slug);
}

export function formatPrice(cents: number, currency = "SGD"): string {
  return new Intl.NumberFormat("en-SG", {
    style: "currency",
    currency,
    maximumFractionDigits: 0
  }).format(cents / 100);
}
