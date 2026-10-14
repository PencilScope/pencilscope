import { json, problem } from "../../../src/lib/http";
import type { ApiEnvironment } from "./index";

type OAuthProvider = "google" | "facebook";

type ProviderIdentity = {
  provider: OAuthProvider;
  providerUserId: string;
  email: string;
  displayName: string;
  avatarUrl: string | null;
};

type OAuthUser = {
  id: string;
  email: string;
  display_name: string;
  role: string;
  status: string;
};

function configured(env: ApiEnvironment, key: "GOOGLE_CLIENT_ID" | "GOOGLE_CLIENT_SECRET" | "FACEBOOK_APP_ID" | "FACEBOOK_APP_SECRET"): string {
  const value = env[key]?.trim();
  if (!value) throw new Error(`${key} is not configured`);
  return value;
}

function facebookVersion(env: ApiEnvironment): string {
  const value = env.FACEBOOK_GRAPH_VERSION?.trim() || "v26.0";
  return /^v\d+\.\d+$/.test(value) ? value : "v26.0";
}

function validRedirectUri(env: ApiEnvironment, provider: OAuthProvider, value: string): boolean {
  try {
    const url = new URL(value);
    if (url.username || url.password || url.search || url.hash) return false;
    if (url.pathname !== `/api/auth/${provider}/callback`) return false;
    if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname))) {
      return false;
    }
    const configuredOrigins = (env.OAUTH_ALLOWED_REDIRECT_ORIGINS || env.APP_URL)
      .split(",")
      .map((origin) => origin.trim())
      .filter(Boolean)
      .map((origin) => new URL(origin).origin);
    return configuredOrigins.includes(url.origin);
  } catch {
    return false;
  }
}

async function googleIdentity(
  env: ApiEnvironment,
  code: string,
  redirectUri: string,
  codeVerifier: string | null
): Promise<ProviderIdentity> {
  const body = new URLSearchParams({
    code,
    client_id: configured(env, "GOOGLE_CLIENT_ID"),
    client_secret: configured(env, "GOOGLE_CLIENT_SECRET"),
    redirect_uri: redirectUri,
    grant_type: "authorization_code"
  });
  if (codeVerifier) body.set("code_verifier", codeVerifier);
  const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body
  });
  const token = await tokenResponse.json<{ access_token?: string; error?: string }>();
  if (!tokenResponse.ok || !token.access_token) throw new Error(`Google token exchange failed: ${token.error ?? tokenResponse.status}`);
  const profileResponse = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
    headers: { authorization: `Bearer ${token.access_token}` }
  });
  const profile = await profileResponse.json<{
    sub?: string;
    email?: string;
    email_verified?: boolean;
    name?: string;
    picture?: string;
  }>();
  if (!profileResponse.ok || !profile.sub || !profile.email || profile.email_verified !== true) {
    throw new Error("Google did not return a verified email address.");
  }
  return {
    provider: "google",
    providerUserId: profile.sub,
    email: profile.email.trim().toLowerCase(),
    displayName: profile.name?.trim().slice(0, 80) || profile.email.split("@")[0].slice(0, 80),
    avatarUrl: profile.picture?.slice(0, 1000) || null
  };
}

async function facebookIdentity(env: ApiEnvironment, code: string, redirectUri: string): Promise<ProviderIdentity> {
  const appId = configured(env, "FACEBOOK_APP_ID");
  const appSecret = configured(env, "FACEBOOK_APP_SECRET");
  const version = facebookVersion(env);
  const tokenResponse = await fetch(`https://graph.facebook.com/${version}/oauth/access_token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: appId, client_secret: appSecret, redirect_uri: redirectUri, code })
  });
  const token = await tokenResponse.json<{ access_token?: string; error?: { message?: string } }>();
  if (!tokenResponse.ok || !token.access_token) {
    throw new Error(`Facebook token exchange failed: ${token.error?.message ?? tokenResponse.status}`);
  }
  const debugUrl = new URL(`https://graph.facebook.com/${version}/debug_token`);
  debugUrl.searchParams.set("input_token", token.access_token);
  const debugResponse = await fetch(debugUrl, {
    headers: { authorization: `Bearer ${appId}|${appSecret}` }
  });
  const debug = await debugResponse.json<{ data?: { app_id?: string; is_valid?: boolean; user_id?: string } }>();
  if (!debugResponse.ok || debug.data?.is_valid !== true || debug.data.app_id !== appId || !debug.data.user_id) {
    throw new Error("Facebook returned an invalid access token.");
  }
  const profileUrl = new URL(`https://graph.facebook.com/${version}/me`);
  profileUrl.searchParams.set("fields", "id,name,email,picture.type(large)");
  const profileResponse = await fetch(profileUrl, {
    headers: { authorization: `Bearer ${token.access_token}` }
  });
  const profile = await profileResponse.json<{
    id?: string;
    name?: string;
    email?: string;
    picture?: { data?: { url?: string } };
  }>();
  if (!profileResponse.ok || !profile.id || profile.id !== debug.data.user_id || !profile.email) {
    throw new Error("Facebook did not return the email permission required by PencilScope.");
  }
  return {
    provider: "facebook",
    providerUserId: profile.id,
    email: profile.email.trim().toLowerCase(),
    displayName: profile.name?.trim().slice(0, 80) || profile.email.split("@")[0].slice(0, 80),
    avatarUrl: profile.picture?.data?.url?.slice(0, 1000) || null
  };
}

async function findOrCreateOAuthUser(env: ApiEnvironment, identity: ProviderIdentity): Promise<{ user: OAuthUser; isNew: boolean }> {
  const existingIdentity = await env.DB.prepare(
    `SELECT u.id, u.email, u.display_name, u.role, u.status
     FROM oauth_identities oi JOIN users u ON u.id = oi.user_id
     WHERE oi.provider = ? AND oi.provider_user_id = ?`
  ).bind(identity.provider, identity.providerUserId).first<OAuthUser>();
  const now = new Date().toISOString();
  if (existingIdentity) {
    if (existingIdentity.status !== "active") throw new Error("This PencilScope account is not active.");
    await env.DB.prepare(
      `UPDATE oauth_identities SET provider_email = ?, display_name = ?, avatar_url = ?,
       updated_at = ?, last_login_at = ? WHERE provider = ? AND provider_user_id = ?`
    ).bind(
      identity.email, identity.displayName, identity.avatarUrl, now, now,
      identity.provider, identity.providerUserId
    ).run();
    return { user: existingIdentity, isNew: false };
  }

  const existingUser = await env.DB.prepare(
    "SELECT id, email, display_name, role, status FROM users WHERE LOWER(email) = ?"
  ).bind(identity.email).first<OAuthUser>();
  if (existingUser) {
    if (existingUser.status !== "active") throw new Error("This PencilScope account is not active.");
    const providerAlreadyLinked = await env.DB.prepare(
      "SELECT 1 FROM oauth_identities WHERE user_id = ? AND provider = ?"
    ).bind(existingUser.id, identity.provider).first();
    if (providerAlreadyLinked) throw new Error(`This account is already linked to a different ${identity.provider} profile.`);
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO oauth_identities
          (id, user_id, provider, provider_user_id, provider_email, display_name,
           avatar_url, created_at, updated_at, last_login_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        crypto.randomUUID(), existingUser.id, identity.provider, identity.providerUserId,
        identity.email, identity.displayName, identity.avatarUrl, now, now, now
      ),
      env.DB.prepare(
        `INSERT INTO audit_logs
          (id, actor_user_id, action, entity_type, entity_id, metadata_json, created_at)
         VALUES (?, ?, 'auth.oauth_linked', 'user', ?, ?, ?)`
      ).bind(crypto.randomUUID(), existingUser.id, existingUser.id, JSON.stringify({ provider: identity.provider }), now)
    ]);
    return { user: existingUser, isNew: false };
  }

  const userId = crypto.randomUUID();
  const user: OAuthUser = {
    id: userId,
    email: identity.email,
    display_name: identity.displayName,
    role: "student",
    status: "active"
  };
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO users (id, email, display_name, role, status, created_at, updated_at)
       VALUES (?, ?, ?, 'student', 'active', ?, ?)`
    ).bind(userId, identity.email, identity.displayName, now, now),
    env.DB.prepare(
      `INSERT INTO account_profiles
        (user_id, account_type, organization_name, created_at, updated_at)
       VALUES (?, 'individual', NULL, ?, ?)`
    ).bind(userId, now, now),
    env.DB.prepare(
      `INSERT INTO creator_profiles
        (user_id, public_name, biography, verification_status, payout_status, created_at, updated_at)
       VALUES (?, ?, '', 'unverified', 'not_configured', ?, ?)`
    ).bind(userId, identity.displayName, now, now),
    env.DB.prepare(
      `INSERT INTO oauth_identities
        (id, user_id, provider, provider_user_id, provider_email, display_name,
         avatar_url, created_at, updated_at, last_login_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      crypto.randomUUID(), userId, identity.provider, identity.providerUserId,
      identity.email, identity.displayName, identity.avatarUrl, now, now, now
    ),
    env.DB.prepare(
      `INSERT INTO audit_logs
        (id, actor_user_id, action, entity_type, entity_id, metadata_json, created_at)
       VALUES (?, ?, 'auth.oauth_registered', 'user', ?, ?, ?)`
    ).bind(crypto.randomUUID(), userId, userId, JSON.stringify({ provider: identity.provider }), now)
  ]);
  return { user, isNew: true };
}

async function exchange(request: Request, env: ApiEnvironment): Promise<Response> {
  let input: { provider?: unknown; code?: unknown; redirectUri?: unknown; codeVerifier?: unknown };
  try {
    input = await request.json();
  } catch {
    return problem(400, "invalid_json", "A JSON body is required.");
  }
  const provider = input.provider === "google" || input.provider === "facebook" ? input.provider : null;
  const code = typeof input.code === "string" ? input.code.trim() : "";
  const redirectUri = typeof input.redirectUri === "string" ? input.redirectUri.trim() : "";
  const codeVerifier = typeof input.codeVerifier === "string" ? input.codeVerifier.trim() : null;
  if (!provider || !code || code.length > 4096 || !validRedirectUri(env, provider, redirectUri)) {
    return problem(400, "invalid_oauth_callback", "The social sign-in callback is invalid or expired.");
  }
  try {
    const identity = provider === "google"
      ? await googleIdentity(env, code, redirectUri, codeVerifier)
      : await facebookIdentity(env, code, redirectUri);
    const result = await findOrCreateOAuthUser(env, identity);
    return json({
      user: {
        id: result.user.id,
        email: result.user.email,
        displayName: result.user.display_name,
        role: result.user.role
      },
      isNew: result.isNew,
      provider
    });
  } catch (error) {
    console.error("auth.oauth.exchange_failed", { provider, error });
    const message = error instanceof Error && (
      error.message.includes("not active") || error.message.includes("already linked") || error.message.includes("email permission")
    ) ? error.message : "Social sign-in could not be completed. Please try again.";
    return problem(401, "oauth_exchange_failed", message);
  }
}

export async function handleOAuthRequest(
  request: Request,
  env: ApiEnvironment,
  pathname: string
): Promise<Response | null> {
  if (request.method === "POST" && pathname === "/api/auth/oauth/exchange") {
    return exchange(request, env);
  }
  return null;
}
