import type { APIRoute } from "astro";
import { getEnv } from "@/lib/runtime";

export const GET: APIRoute = async ({ request, locals, session, redirect }) => {
  const userId = await session?.get("userId");
  if (typeof userId !== "string") return redirect("/sign-in?next=/profile", 303);
  const expectedState = await session?.get("googleIntegrationState");
  const verifier = await session?.get("googleIntegrationVerifier");
  const startedAt = Number(await session?.get("googleIntegrationStartedAt"));
  const requestedNext = await session?.get("googleIntegrationNext");
  const next = typeof requestedNext === "string" && requestedNext.startsWith("/") && !requestedNext.startsWith("//") && !requestedNext.includes("\\")
    ? requestedNext
    : "/profile";
  const clear = () => {
    session?.delete("googleIntegrationState");
    session?.delete("googleIntegrationVerifier");
    session?.delete("googleIntegrationStartedAt");
    session?.delete("googleIntegrationNext");
  };
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  if (url.searchParams.get("error") || url.searchParams.get("state") !== expectedState || !code || typeof verifier !== "string" || !Number.isFinite(startedAt) || Date.now() - startedAt > 10 * 60_000) {
    clear();
    const destination = new URL(next, request.url);
    destination.searchParams.set("error", "Google Calendar connection was cancelled or expired.");
    return redirect(`${destination.pathname}${destination.search}`, 303);
  }
  const env = getEnv(locals);
  const response = await env.API.fetch("https://pencilscope-api.internal/api/integrations/google/exchange", {
    method: "POST",
    headers: { "content-type": "application/json", "x-pencilscope-user-id": userId },
    body: JSON.stringify({ code, codeVerifier: verifier, redirectUri: new URL("/api/integrations/google/callback", request.url).toString() })
  });
  const result = await response.json<{ error?: { message?: string } }>();
  clear();
  const destination = new URL(next, request.url);
  destination.searchParams.set(response.ok ? "google" : "error", response.ok ? "connected" : result.error?.message ?? "Google Calendar could not be connected.");
  return redirect(`${destination.pathname}${destination.search}`, 303);
};
