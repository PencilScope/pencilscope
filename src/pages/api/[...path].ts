import type { APIRoute } from "astro";
import { getEnv } from "@/lib/runtime";

export const ALL: APIRoute = async ({ request, locals, session }) => {
  const env = getEnv(locals);
  const headers = new Headers(request.headers);
  headers.delete("host");
  headers.delete("x-pencilscope-user-id");
  headers.delete("x-pencilscope-session-id");

  const userId = await session?.get("userId");
  if (typeof userId === "string" && userId) {
    headers.set("x-pencilscope-user-id", userId);
  }
  const sessionId = await session?.get("sessionId");
  if (typeof sessionId === "string" && sessionId) {
    headers.set("x-pencilscope-session-id", sessionId);
  }

  return env.API.fetch(new Request(request, { headers }));
};
