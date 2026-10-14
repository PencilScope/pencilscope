import type { APIRoute } from "astro";
import { getEnv } from "@/lib/runtime";

export const POST: APIRoute = async ({ request, locals }) => {
  const headers = new Headers(request.headers);
  headers.delete("host");
  return getEnv(locals).API.fetch("https://pencilscope-api.internal/api/mcp/oauth/revoke", {
    method: "POST",
    headers,
    body: request.body
  });
};
