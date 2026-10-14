import type { APIRoute } from "astro";
import { getEnv } from "@/lib/runtime";

type Provider = "google" | "facebook";

const safeNext = (value: string | null): string => value?.startsWith("/") && !value.startsWith("//")
  ? value
  : "/dashboard";

const base64Url = (bytes: Uint8Array): string => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "");
};

export const GET: APIRoute = async ({ params, request, locals, session, redirect }) => {
  const provider = params.provider === "google" || params.provider === "facebook"
    ? params.provider as Provider
    : null;
  const url = new URL(request.url);
  const next = safeNext(url.searchParams.get("next"));
  const intent = url.searchParams.get("intent") === "signup" ? "signup" : "signin";
  const returnPath = intent === "signup" ? "/register" : "/sign-in";
  if (!provider || !session) {
    return redirect(`${returnPath}?error=${encodeURIComponent("Social sign-in is unavailable.")}&next=${encodeURIComponent(next)}`, 303);
  }
  const env = getEnv(locals);
  const clientId = provider === "google" ? env.GOOGLE_CLIENT_ID : env.FACEBOOK_APP_ID;
  if (!clientId) {
    return redirect(`${returnPath}?error=${encodeURIComponent(`${provider === "google" ? "Google" : "Facebook"} sign-in is not configured yet.`)}&next=${encodeURIComponent(next)}`, 303);
  }

  const state = crypto.randomUUID();
  const redirectUri = new URL(`/api/auth/${provider}/callback`, request.url).toString();
  session.set("oauthState", state);
  session.set("oauthProvider", provider);
  session.set("oauthNext", next);
  session.set("oauthIntent", intent);
  session.set("oauthStartedAt", Date.now());

  let authorizationUrl: URL;
  if (provider === "google") {
    const verifier = `${crypto.randomUUID()}${crypto.randomUUID()}`.replaceAll("-", "");
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
    session.set("oauthCodeVerifier", verifier);
    authorizationUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    authorizationUrl.searchParams.set("client_id", clientId);
    authorizationUrl.searchParams.set("redirect_uri", redirectUri);
    authorizationUrl.searchParams.set("response_type", "code");
    authorizationUrl.searchParams.set("scope", "openid email profile");
    authorizationUrl.searchParams.set("state", state);
    authorizationUrl.searchParams.set("code_challenge", base64Url(new Uint8Array(digest)));
    authorizationUrl.searchParams.set("code_challenge_method", "S256");
    authorizationUrl.searchParams.set("prompt", "select_account");
  } else {
    session.delete("oauthCodeVerifier");
    const version = /^v\d+\.\d+$/.test(env.FACEBOOK_GRAPH_VERSION ?? "")
      ? env.FACEBOOK_GRAPH_VERSION
      : "v26.0";
    authorizationUrl = new URL(`https://www.facebook.com/${version}/dialog/oauth`);
    authorizationUrl.searchParams.set("client_id", clientId);
    authorizationUrl.searchParams.set("redirect_uri", redirectUri);
    authorizationUrl.searchParams.set("response_type", "code");
    authorizationUrl.searchParams.set("scope", "email,public_profile");
    authorizationUrl.searchParams.set("state", state);
    authorizationUrl.searchParams.set("return_scopes", "true");
  }
  return redirect(authorizationUrl.toString(), 302);
};
