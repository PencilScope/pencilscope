import type { APIRoute } from "astro";
import { getEnv } from "@/lib/runtime";

const base64Url = (bytes: Uint8Array): string => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "");
};

export const GET: APIRoute = async ({ request, locals, session, redirect }) => {
  const userId = await session?.get("userId");
  if (typeof userId !== "string") return redirect("/sign-in?next=/profile", 303);
  const env = getEnv(locals);
  if (!env.GOOGLE_CLIENT_ID) return redirect("/profile?error=Google%20Calendar%20is%20not%20configured.", 303);
  const state = crypto.randomUUID();
  const verifier = `${crypto.randomUUID()}${crypto.randomUUID()}`.replaceAll("-", "");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  session?.set("googleIntegrationState", state);
  session?.set("googleIntegrationVerifier", verifier);
  session?.set("googleIntegrationStartedAt", Date.now());
  const requestedNext = new URL(request.url).searchParams.get("next");
  const safeNext = requestedNext && requestedNext.startsWith("/") && !requestedNext.startsWith("//") && !requestedNext.includes("\\")
    ? requestedNext
    : "/profile";
  session?.set("googleIntegrationNext", safeNext);
  const redirectUri = new URL("/api/integrations/google/callback", request.url).toString();
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("client_id", env.GOOGLE_CLIENT_ID);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", ["openid", "email", "profile", "https://www.googleapis.com/auth/calendar.events"].join(" "));
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", base64Url(new Uint8Array(digest)));
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent select_account");
  return redirect(url.toString(), 302);
};
