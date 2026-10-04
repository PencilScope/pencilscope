import { env as cloudflareEnv } from "cloudflare:workers";
import { sampleCourses, type CourseSummary } from "@/lib/courses";

type CourseListResponse = { courses: CourseSummary[] };
type CourseResponse = { course: CourseSummary };

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
