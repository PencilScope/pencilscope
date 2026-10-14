import type { APIRoute } from "astro";
import { getEnv } from "@/lib/runtime";

type Provider = "google" | "facebook";

const safeNext = (value: unknown): string => typeof value === "string" && value.startsWith("/") && !value.startsWith("//")
  ? value
  : "/dashboard";

export const GET: APIRoute = async ({ params, request, locals, session, redirect }) => {
  const provider = params.provider === "google" || params.provider === "facebook"
    ? params.provider as Provider
    : null;
  const expectedState = await session?.get("oauthState");
  const expectedProvider = await session?.get("oauthProvider");
  const next = safeNext(await session?.get("oauthNext"));
  const intent = await session?.get("oauthIntent") === "signup" ? "signup" : "signin";
  const startedAt = Number(await session?.get("oauthStartedAt"));
  const codeVerifier = await session?.get("oauthCodeVerifier");
  const returnPath = intent === "signup" ? "/register" : "/sign-in";
  const clearState = () => {
    session?.delete("oauthState");
    session?.delete("oauthProvider");
    session?.delete("oauthNext");
    session?.delete("oauthIntent");
    session?.delete("oauthStartedAt");
    session?.delete("oauthCodeVerifier");
  };
  const fail = (message: string) => {
    clearState();
    return redirect(`${returnPath}?error=${encodeURIComponent(message)}&next=${encodeURIComponent(next)}`, 303);
  };
  if (!provider || typeof expectedState !== "string" || expectedProvider !== provider ||
      !Number.isFinite(startedAt) || Date.now() - startedAt > 10 * 60_000) {
    return fail("This social sign-in request expired. Please try again.");
  }
  const url = new URL(request.url);
  if (url.searchParams.get("error")) return fail("Social sign-in was cancelled or permission was not granted.");
  const state = url.searchParams.get("state");
  const code = url.searchParams.get("code");
  if (state !== expectedState || !code) return fail("The social sign-in response could not be verified.");

  const env = getEnv(locals);
  const redirectUri = new URL(`/api/auth/${provider}/callback`, request.url).toString();
  const response = await env.API.fetch("https://pencilscope-api.internal/api/auth/oauth/exchange", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      provider,
      code,
      redirectUri,
      codeVerifier: typeof codeVerifier === "string" ? codeVerifier : null
    })
  });
  const result = await response.json<{
    user?: { id: string };
    isNew?: boolean;
    error?: { message?: string };
  }>();
  if (!response.ok || !result.user) {
    return fail(result.error?.message ?? "Social sign-in could not be completed.");
  }

  clearState();
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
  return redirect(result.isNew ? `/onboarding?next=${encodeURIComponent(next)}` : next, 303);
};
