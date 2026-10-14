import type { APIRoute } from "astro";
import { getEnv } from "@/lib/runtime";

export const GET: APIRoute = async ({ request, locals, session, redirect }) => {
  const userId = await session?.get("userId");
  if (typeof userId !== "string") return redirect("/sign-in?next=/profile", 303);
  const expectedState = await session?.get("googleIntegrationState");
  const verifier = await session?.get("googleIntegrationVerifier");
  const startedAt = Number(await session?.get("googleIntegrationStartedAt"));
  const clear = () => {
    session?.delete("googleIntegrationState");
    session?.delete("googleIntegrationVerifier");
    session?.delete("googleIntegrationStartedAt");
  };
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  if (url.searchParams.get("error") || url.searchParams.get("state") !== expectedState || !code || typeof verifier !== "string" || !Number.isFinite(startedAt) || Date.now() - startedAt > 10 * 60_000) {
    clear();
    return redirect("/profile?error=Google%20Calendar%20connection%20was%20cancelled%20or%20expired.", 303);
  }
  const env = getEnv(locals);
  const response = await env.API.fetch("https://pencilscope-api.internal/api/integrations/google/exchange", {
    method: "POST",
    headers: { "content-type": "application/json", "x-pencilscope-user-id": userId },
    body: JSON.stringify({ code, codeVerifier: verifier, redirectUri: new URL("/api/integrations/google/callback", request.url).toString() })
  });
  const result = await response.json<{ error?: { message?: string } }>();
  clear();
  return response.ok ? redirect("/profile?google=connected", 303) : redirect(`/profile?error=${encodeURIComponent(result.error?.message ?? "Google Calendar could not be connected.")}`, 303);
};
