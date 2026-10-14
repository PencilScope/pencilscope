import type { APIRoute } from "astro";
import { getEnv } from "@/lib/runtime";

export const POST: APIRoute = async ({ request, locals, session, redirect }) => {
  const form = await request.formData();
  const requestedNext = form.get("next");
  const next = typeof requestedNext === "string" && requestedNext.startsWith("/") && !requestedNext.startsWith("//")
    ? requestedNext
    : "/dashboard";
  const response = await getEnv(locals).API.fetch("https://pencilscope-api.internal/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email: form.get("email"),
      password: form.get("password")
    })
  });
  const result = await response.json<{ user?: { id: string }; error?: { message?: string } }>();
  if (!response.ok || !result.user) {
    return redirect(`/sign-in?error=${encodeURIComponent(result.error?.message ?? "Sign in failed.")}&next=${encodeURIComponent(next)}`, 303);
  }
  session?.set("userId", result.user.id);
  const sessionId = crypto.randomUUID();
  session?.set("sessionId", sessionId);
  await getEnv(locals).API.fetch("https://pencilscope-api.internal/api/sessions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-pencilscope-user-id": result.user.id
    },
    body: JSON.stringify({ sessionId, userAgent: request.headers.get("user-agent") ?? "" })
  });
  return redirect(next, 303);
};
