import { json, problem } from "../../../src/lib/http";
import type { ApiEnvironment } from "./index";

const supportedScopes = new Set([
  "products:read", "products:write", "products:publish", "courses:write",
  "library:read", "library:write", "offline_access"
]);

type ClientRow = {
  client_id: string;
  client_name: string;
  redirect_uris_json: string;
};

type CodeRow = {
  code_hash: string;
  client_id: string;
  user_id: string;
  redirect_uri: string;
  code_challenge: string;
  scopes_json: string;
  resource: string;
  expires_at: string;
  used_at: string | null;
};

type TokenRow = {
  id: string;
  client_id: string;
  user_id: string;
  scopes_json: string;
  resource: string;
  refresh_expires_at: string;
};

const base64url = (bytes: Uint8Array) => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
};

const randomToken = (prefix: string) => {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return `${prefix}${base64url(bytes)}`;
};

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return base64url(new Uint8Array(digest));
}

function allowedOrigin(value: unknown, configured: string | undefined): string | null {
  if (typeof value !== "string") return null;
  try {
    const parsed = new URL(value);
    const allowed = new Set((configured ?? "").split(",").map((item) => item.trim()).filter(Boolean));
    if (parsed.pathname !== "/" || parsed.search || parsed.hash) return null;
    if (allowed.has(parsed.origin)) return parsed.origin;
    if (parsed.hostname === "localhost" && parsed.protocol === "http:") return parsed.origin;
  } catch {
    return null;
  }
  return null;
}

function resourceAllowed(value: unknown, configured: string | undefined): string | null {
  if (typeof value !== "string") return null;
  try {
    const parsed = new URL(value);
    if (parsed.search || parsed.hash || parsed.pathname !== "/mcp") return null;
    const allowed = new Set((configured ?? "").split(",").map((item) => item.trim()).filter(Boolean));
    const exact = `${parsed.origin}/mcp`;
    if (allowed.has(parsed.origin) || allowed.has(exact)) return exact;
    if (parsed.hostname === "localhost" && parsed.protocol === "http:") return exact;
  } catch {
    return null;
  }
  return null;
}

function validRedirectUris(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > 10) return null;
  const result: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string" || entry.length > 1000) return null;
    try {
      const parsed = new URL(entry);
      const local = ["localhost", "127.0.0.1"].includes(parsed.hostname);
      if (parsed.hash || (!local && parsed.protocol !== "https:") || (local && !["http:", "https:"].includes(parsed.protocol))) {
        return null;
      }
      result.push(parsed.toString());
    } catch {
      return null;
    }
  }
  return [...new Set(result)];
}

function requestedScopes(value: unknown): string[] | null {
  const requested = typeof value === "string" && value.trim()
    ? value.split(/\s+/).filter(Boolean)
    : ["products:read", "products:write", "courses:write", "library:read", "library:write"];
  if (!requested.length || requested.some((scope) => !supportedScopes.has(scope))) return null;
  return [...new Set(requested)];
}

function oauthError(code: string, description: string, status = 400): Response {
  return json({ error: code, error_description: description }, {
    status,
    headers: { "cache-control": "no-store", pragma: "no-cache" }
  });
}

async function client(env: ApiEnvironment, clientId: unknown): Promise<ClientRow | null> {
  if (typeof clientId !== "string" || !clientId) return null;
  return env.DB.prepare(
    "SELECT client_id, client_name, redirect_uris_json FROM mcp_oauth_clients WHERE client_id = ?"
  ).bind(clientId).first<ClientRow>();
}

function redirectAllowed(row: ClientRow, redirectUri: unknown): redirectUri is string {
  if (typeof redirectUri !== "string") return false;
  try {
    return (JSON.parse(row.redirect_uris_json) as string[]).includes(new URL(redirectUri).toString());
  } catch {
    return false;
  }
}

async function registerClient(request: Request, env: ApiEnvironment): Promise<Response> {
  let input: Record<string, unknown>;
  try {
    input = await request.json<Record<string, unknown>>();
  } catch {
    return oauthError("invalid_client_metadata", "A JSON request body is required.");
  }
  const redirects = validRedirectUris(input.redirect_uris);
  const name = typeof input.client_name === "string" ? input.client_name.trim().slice(0, 120) : "";
  if (!redirects || !name) return oauthError("invalid_client_metadata", "A client name and valid redirect URIs are required.");
  if (input.token_endpoint_auth_method && input.token_endpoint_auth_method !== "none") {
    return oauthError("invalid_client_metadata", "Only public clients using PKCE are supported.");
  }
  const clientId = randomToken("ps_client_");
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO mcp_oauth_clients
      (client_id, client_name, redirect_uris_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)`
  ).bind(clientId, name, JSON.stringify(redirects), now, now).run();
  return json({
    client_id: clientId,
    client_name: name,
    redirect_uris: redirects,
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"]
  }, { status: 201, headers: { "cache-control": "no-store" } });
}

async function authorizationRequest(request: Request, env: ApiEnvironment): Promise<Response> {
  const url = new URL(request.url);
  const row = await client(env, url.searchParams.get("client_id"));
  if (!row || !redirectAllowed(row, url.searchParams.get("redirect_uri"))) {
    return problem(400, "invalid_oauth_request", "The OAuth client or redirect URI is invalid.");
  }
  const scopes = requestedScopes(url.searchParams.get("scope"));
  const resource = resourceAllowed(url.searchParams.get("resource"), env.MCP_RESOURCE_ORIGINS);
  if (url.searchParams.get("response_type") !== "code" || !scopes || !resource ||
      url.searchParams.get("code_challenge_method") !== "S256" ||
      !/^[A-Za-z0-9_-]{43,128}$/.test(url.searchParams.get("code_challenge") ?? "")) {
    return problem(400, "invalid_oauth_request", "The OAuth request is incomplete or unsupported.");
  }
  return json({ clientName: row.client_name, scopes, resource });
}

async function authorize(request: Request, env: ApiEnvironment): Promise<Response> {
  const userId = request.headers.get("x-pencilscope-user-id")?.trim();
  if (!userId) return problem(401, "authentication_required", "Sign in before connecting an AI assistant.");
  let input: Record<string, unknown>;
  try {
    input = await request.json<Record<string, unknown>>();
  } catch {
    return problem(400, "invalid_json", "A JSON request body is required.");
  }
  const row = await client(env, input.client_id);
  if (!row || !redirectAllowed(row, input.redirect_uri)) {
    return problem(400, "invalid_oauth_request", "The OAuth client or redirect URI is invalid.");
  }
  const issuer = allowedOrigin(input.issuer, env.OAUTH_ALLOWED_REDIRECT_ORIGINS);
  const resource = resourceAllowed(input.resource, env.MCP_RESOURCE_ORIGINS);
  const scopes = requestedScopes(input.scope);
  const challenge = typeof input.code_challenge === "string" ? input.code_challenge : "";
  const state = typeof input.state === "string" ? input.state : "";
  if (state.length > 8192) {
    return problem(400, "invalid_oauth_request", "The OAuth state value is too long.");
  }
  const originalRedirectUri = new URL(String(input.redirect_uri)).toString();
  const redirectUrl = new URL(originalRedirectUri);
  if (!issuer || !resource || !scopes || input.response_type !== "code" ||
      input.code_challenge_method !== "S256" || !/^[A-Za-z0-9_-]{43,128}$/.test(challenge)) {
    return problem(400, "invalid_oauth_request", "The OAuth request is incomplete or unsupported.");
  }
  redirectUrl.searchParams.set("iss", issuer);
  if (state) redirectUrl.searchParams.set("state", state);
  if (input.decision !== "allow") {
    redirectUrl.searchParams.set("error", "access_denied");
    redirectUrl.searchParams.set("error_description", "The user declined access.");
    return json({ redirectUrl: redirectUrl.toString() });
  }
  const code = randomToken("ps_code_");
  const now = new Date();
  await env.DB.prepare(
    `INSERT INTO mcp_oauth_codes
      (code_hash, client_id, user_id, redirect_uri, code_challenge, scopes_json,
       resource, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    await sha256(code), row.client_id, userId, originalRedirectUri,
    challenge, JSON.stringify(scopes), resource,
    new Date(now.getTime() + 5 * 60_000).toISOString(), now.toISOString()
  ).run();
  redirectUrl.searchParams.set("code", code);
  return json({ redirectUrl: redirectUrl.toString() });
}

async function issueTokens(
  env: ApiEnvironment,
  details: { clientId: string; userId: string; scopes: string[]; resource: string },
  existingId?: string
): Promise<{ accessToken: string; refreshToken: string; expiresIn: number }> {
  const accessToken = randomToken("ps_at_");
  const refreshToken = randomToken("ps_rt_");
  const now = new Date();
  const id = existingId ?? crypto.randomUUID();
  const values = [
    await sha256(accessToken), await sha256(refreshToken), details.clientId, details.userId,
    JSON.stringify(details.scopes), details.resource,
    new Date(now.getTime() + 60 * 60_000).toISOString(),
    new Date(now.getTime() + 30 * 24 * 60 * 60_000).toISOString(),
    now.toISOString(), id
  ];
  if (existingId) {
    await env.DB.prepare(
      `UPDATE mcp_oauth_tokens SET access_token_hash = ?, refresh_token_hash = ?,
       client_id = ?, user_id = ?, scopes_json = ?, resource = ?, access_expires_at = ?,
       refresh_expires_at = ?, revoked_at = NULL, updated_at = ? WHERE id = ?`
    ).bind(...values).run();
  } else {
    await env.DB.prepare(
      `INSERT INTO mcp_oauth_tokens
       (access_token_hash, refresh_token_hash, client_id, user_id, scopes_json, resource,
        access_expires_at, refresh_expires_at, created_at, id, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(...values.slice(0, 8), now.toISOString(), id, now.toISOString()).run();
  }
  return { accessToken, refreshToken, expiresIn: 3600 };
}

async function token(request: Request, env: ApiEnvironment): Promise<Response> {
  const form = await request.formData();
  const grantType = String(form.get("grant_type") ?? "");
  const clientId = String(form.get("client_id") ?? "");
  const resource = resourceAllowed(form.get("resource"), env.MCP_RESOURCE_ORIGINS);
  if (!clientId || !resource) return oauthError("invalid_request", "client_id and resource are required.");
  if (grantType === "authorization_code") {
    const code = String(form.get("code") ?? "");
    const verifier = String(form.get("code_verifier") ?? "");
    const redirectUri = String(form.get("redirect_uri") ?? "");
    if (!code || !verifier || !redirectUri) return oauthError("invalid_request", "The authorization code request is incomplete.");
    const stored = await env.DB.prepare(
      `SELECT code_hash, client_id, user_id, redirect_uri, code_challenge, scopes_json,
       resource, expires_at, used_at FROM mcp_oauth_codes WHERE code_hash = ?`
    ).bind(await sha256(code)).first<CodeRow>();
    if (!stored || stored.used_at || stored.expires_at <= new Date().toISOString() ||
        stored.client_id !== clientId || stored.redirect_uri !== redirectUri ||
        stored.resource !== resource || await sha256(verifier) !== stored.code_challenge) {
      return oauthError("invalid_grant", "The authorization code is invalid or expired.");
    }
    const consumed = await env.DB.prepare(
      "UPDATE mcp_oauth_codes SET used_at = ? WHERE code_hash = ? AND used_at IS NULL AND expires_at > ?"
    ).bind(new Date().toISOString(), stored.code_hash, new Date().toISOString()).run();
    if (Number(consumed.meta.changes ?? 0) !== 1) {
      return oauthError("invalid_grant", "The authorization code has already been used.");
    }
    const issued = await issueTokens(env, {
      clientId, userId: stored.user_id, scopes: JSON.parse(stored.scopes_json), resource
    });
    return json({
      access_token: issued.accessToken,
      token_type: "Bearer",
      expires_in: issued.expiresIn,
      refresh_token: issued.refreshToken,
      scope: (JSON.parse(stored.scopes_json) as string[]).join(" ")
    }, { headers: { "cache-control": "no-store", pragma: "no-cache" } });
  }
  if (grantType === "refresh_token") {
    const refreshToken = String(form.get("refresh_token") ?? "");
    const stored = await env.DB.prepare(
      `SELECT id, client_id, user_id, scopes_json, resource, refresh_expires_at
       FROM mcp_oauth_tokens WHERE refresh_token_hash = ? AND revoked_at IS NULL`
    ).bind(await sha256(refreshToken)).first<TokenRow>();
    if (!stored || stored.client_id !== clientId || stored.resource !== resource ||
        stored.refresh_expires_at <= new Date().toISOString()) {
      return oauthError("invalid_grant", "The refresh token is invalid or expired.");
    }
    const scopes = JSON.parse(stored.scopes_json) as string[];
    const issued = await issueTokens(env, {
      clientId, userId: stored.user_id, scopes, resource
    }, stored.id);
    return json({
      access_token: issued.accessToken,
      token_type: "Bearer",
      expires_in: issued.expiresIn,
      refresh_token: issued.refreshToken,
      scope: scopes.join(" ")
    }, { headers: { "cache-control": "no-store", pragma: "no-cache" } });
  }
  return oauthError("unsupported_grant_type", "Use authorization_code or refresh_token.");
}

async function revoke(request: Request, env: ApiEnvironment): Promise<Response> {
  const form = await request.formData();
  const value = String(form.get("token") ?? "");
  if (value) {
    const hash = await sha256(value);
    await env.DB.prepare(
      `UPDATE mcp_oauth_tokens SET revoked_at = ?, updated_at = ?
       WHERE access_token_hash = ? OR refresh_token_hash = ?`
    ).bind(new Date().toISOString(), new Date().toISOString(), hash, hash).run();
  }
  return new Response(null, { status: 200, headers: { "cache-control": "no-store" } });
}

export async function handleMcpOAuthRequest(
  request: Request,
  env: ApiEnvironment,
  pathname: string
): Promise<Response | null> {
  if (request.method === "POST" && pathname === "/api/mcp/oauth/register") return registerClient(request, env);
  if (request.method === "GET" && pathname === "/api/mcp/oauth/authorize-request") return authorizationRequest(request, env);
  if (request.method === "POST" && pathname === "/api/mcp/oauth/authorize") return authorize(request, env);
  if (request.method === "POST" && pathname === "/api/mcp/oauth/token") return token(request, env);
  if (request.method === "POST" && pathname === "/api/mcp/oauth/revoke") return revoke(request, env);
  return null;
}
