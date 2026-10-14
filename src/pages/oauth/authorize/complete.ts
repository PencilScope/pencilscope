import type { APIRoute } from "astro";
import { getEnv } from "@/lib/runtime";

export const POST: APIRoute = async ({ request, locals, session, redirect, url }) => {
  const userId = await session?.get("userId");
  const form = await request.formData();
  if (typeof userId !== "string") {
    const next = `/oauth/authorize?${new URLSearchParams(
      [...form.entries()].map(([key, value]) => [key, String(value)])
    )}`;
    return redirect(`/sign-in?next=${encodeURIComponent(next)}`, 303);
  }
  const response = await getEnv(locals).API.fetch("https://pencilscope-api.internal/api/mcp/oauth/authorize", {
    method: "POST",
    headers: { "content-type": "application/json", "x-pencilscope-user-id": userId },
    body: JSON.stringify({
      client_id: form.get("client_id"),
      redirect_uri: form.get("redirect_uri"),
      response_type: form.get("response_type"),
      scope: form.get("scope"),
      state: form.get("state"),
      code_challenge: form.get("code_challenge"),
      code_challenge_method: form.get("code_challenge_method"),
      resource: form.get("resource"),
      issuer: url.origin,
      decision: form.get("decision")
    })
  });
  const result = await response.json<{ redirectUrl?: string; error?: { message?: string } }>();
  if (!response.ok || !result.redirectUrl) {
    return new Response(result.error?.message ?? "The connection request could not be completed.", { status: response.status });
  }
  return redirect(result.redirectUrl, 303);
};
