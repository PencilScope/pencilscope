import { env as cloudflareEnv } from "cloudflare:workers";
import { sampleCourses, type CourseSummary } from "@/lib/courses";

type CourseListResponse = { courses: CourseSummary[] };
type CourseResponse = { course: CourseSummary };

async function requestApi(path: string): Promise<Response> {
  const env = cloudflareEnv as unknown as AppEnvironment;
  return env.API.fetch(new Request(`https://pencilscope-api.internal${path}`));
}

export async function listPublishedCourses(): Promise<CourseSummary[]> {
  try {
    const response = await requestApi("/api/courses");
    if (!response.ok) throw new Error(`Course API returned ${response.status}`);
    const result = await response.json<CourseListResponse>();
    return result.courses.length ? result.courses : sampleCourses;
  } catch (error) {
    console.warn("courses.api.unavailable", { error });
    return sampleCourses;
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
    return sampleCourses.find((course) => course.slug === slug);
  }
}
