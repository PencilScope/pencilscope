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
    accent: "lime"
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
    accent: "blue"
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
    accent: "coral"
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
};

const mapCourse = (row: CourseRow): CourseSummary => ({
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
  stripePriceId: row.stripe_price_id ?? undefined
});

export async function listPublishedCourses(db?: D1Database): Promise<CourseSummary[]> {
  if (!db) return sampleCourses;
  try {
    const result = await db
      .prepare(
        `SELECT c.id, c.slug, c.title, c.description, c.subject, c.primary_level,
          c.delivery_mode, c.price_cents, c.currency, c.accent, c.stripe_price_id,
          COALESCE(tp.display_name, 'PencilScope Tutor') AS tutor_name
        FROM courses c
        LEFT JOIN tutor_profiles tp ON tp.user_id = c.tutor_id
        WHERE c.status = 'published'
        ORDER BY c.published_at DESC, c.created_at DESC`
      )
      .all<CourseRow>();
    return result.results.length ? result.results.map(mapCourse) : sampleCourses;
  } catch {
    return sampleCourses;
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

