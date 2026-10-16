import type { APIRoute } from "astro";
import { getEnv } from "@/lib/runtime";
import { turnstileErrorMessage, verifyTurnstile } from "@/lib/turnstile";

export const POST: APIRoute = async ({ request, locals, session, redirect }) => {
  const form = await request.formData();
  const requestedNext = form.get("next");
  const next = typeof requestedNext === "string" && requestedNext.startsWith("/") && !requestedNext.startsWith("//")
    ? requestedNext
    : "/dashboard";
  const email = typeof form.get("email") === "string" ? String(form.get("email")) : "";
  const env = getEnv(locals);
  const verification = await verifyTurnstile(env, {
    token: form.get("cf-turnstile-response"),
    remoteIp: request.headers.get("CF-Connecting-IP"),
    expectedAction: "login",
    expectedHostname: new URL(request.url).hostname
  });
  if (!verification.success) {
    return redirect(`/sign-in?error=${encodeURIComponent(turnstileErrorMessage(verification))}&next=${encodeURIComponent(next)}&email=${encodeURIComponent(email)}`, 303);
  }
  const response = await env.API.fetch("https://pencilscope-api.internal/api/auth/login", {
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
  await env.API.fetch("https://pencilscope-api.internal/api/sessions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-pencilscope-user-id": result.user.id
    },
    body: JSON.stringify({ sessionId, userAgent: request.headers.get("user-agent") ?? "" })
  });
  return redirect(next, 303);
};
