import type { APIRoute } from "astro";
import { getEnv } from "@/lib/runtime";
import { turnstileErrorMessage, verifyTurnstile } from "@/lib/turnstile";

export const POST: APIRoute = async ({ request, locals, session, redirect }) => {
  const form = await request.formData();
  const requestedNext = form.get("next");
  const next = typeof requestedNext === "string" && requestedNext.startsWith("/") && !requestedNext.startsWith("//")
    ? requestedNext
    : "/dashboard";
  const env = getEnv(locals);
  const verification = await verifyTurnstile(env, {
    token: form.get("cf-turnstile-response"),
    remoteIp: request.headers.get("CF-Connecting-IP"),
    expectedAction: "register",
    expectedHostname: new URL(request.url).hostname
  });
  if (!verification.success) {
    const email = typeof form.get("email") === "string" ? String(form.get("email")) : "";
    return redirect(`/register?error=${encodeURIComponent(turnstileErrorMessage(verification))}&next=${encodeURIComponent(next)}&email=${encodeURIComponent(email)}`, 303);
  }
  const response = await env.API.fetch("https://pencilscope-api.internal/api/auth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      displayName: form.get("displayName"),
      email: form.get("email"),
      password: form.get("password")
    })
  });
  const result = await response.json<{ user?: { id: string }; error?: { message?: string } }>();
  if (!response.ok || !result.user) {
    const email = typeof form.get("email") === "string" ? String(form.get("email")) : "";
    return redirect(`/register?error=${encodeURIComponent(result.error?.message ?? "Registration failed.")}&next=${encodeURIComponent(next)}&email=${encodeURIComponent(email)}`, 303);
  }
  session?.set("userId", result.user.id);
  return redirect(`/onboarding?next=${encodeURIComponent(next)}`, 303);
};
