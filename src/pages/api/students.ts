import type { APIRoute } from "astro";
import { getEnv } from "@/lib/runtime";

export const POST: APIRoute = async ({ request, locals, session, redirect }) => {
  const userId = await session?.get("userId");
  if (typeof userId !== "string") return redirect("/sign-in", 303);
  const form = await request.formData();
  const response = await getEnv(locals).API.fetch("https://pencilscope-api.internal/api/parents/students", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-pencilscope-user-id": userId
    },
    body: JSON.stringify({
      displayName: form.get("displayName"),
      primaryLevel: form.get("primaryLevel")
    })
  });
  if (!response.ok) {
    const result = await response.json<{ error?: { message?: string } }>();
    return redirect(`/dashboard?error=${encodeURIComponent(result.error?.message ?? "Could not add learner.")}`, 303);
  }
  return redirect("/dashboard?added=learner", 303);
};
