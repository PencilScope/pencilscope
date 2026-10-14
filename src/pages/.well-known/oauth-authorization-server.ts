import type { APIRoute } from "astro";
import { getEnv } from "@/lib/runtime";

export const GET: APIRoute = ({ url, locals }) => {
  const issuer = url.origin;
  const mcpOrigin = new URL(getEnv(locals).MCP_SERVER_URL).origin;
  return new Response(JSON.stringify({
    issuer,
    authorization_endpoint: `${issuer}/oauth/authorize`,
    // OAuth clients post form-encoded token and revocation requests from their
    // own origin. Keep those protocol endpoints on the MCP Worker so Astro's
    // browser-facing CSRF protection remains enabled for PencilScope forms.
    token_endpoint: `${mcpOrigin}/oauth/token`,
    registration_endpoint: `${mcpOrigin}/oauth/register`,
    revocation_endpoint: `${mcpOrigin}/oauth/revoke`,
    authorization_response_iss_parameter_supported: true,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    token_endpoint_auth_methods_supported: ["none"],
    code_challenge_methods_supported: ["S256"],
    scopes_supported: ["products:read", "products:write", "products:publish", "courses:write", "offline_access"]
  }), {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "public, max-age=300"
    }
  });
};
