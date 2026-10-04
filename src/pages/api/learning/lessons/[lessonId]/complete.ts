import type { APIRoute } from "astro";
import { getEnv } from "@/lib/runtime";

export const POST: APIRoute = async ({ request, params, locals, session, redirect }) => {
  const userId = await session?.get("userId");
  if (typeof userId !== "string") return redirect("/sign-in", 303);
  const form = await request.formData();
  const studentId = form.get("studentId");
  const courseId = form.get("courseId");
  const lessonId = params.lessonId;
  if (!lessonId || typeof courseId !== "string") return new Response("Invalid lesson", { status: 400 });
  const response = await getEnv(locals).API.fetch(
    `https://pencilscope-api.internal/api/learning/lessons/${encodeURIComponent(lessonId)}/progress`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-pencilscope-user-id": userId
      },
      body: JSON.stringify({
        studentId: typeof studentId === "string" && studentId ? studentId : undefined,
        progressPercent: 100
      })
    }
  );
  if (!response.ok) return new Response(await response.text(), { status: response.status });
  const query = typeof studentId === "string" && studentId ? `?studentId=${encodeURIComponent(studentId)}` : "";
  return redirect(`/learn/${encodeURIComponent(courseId)}${query}`, 303);
};
