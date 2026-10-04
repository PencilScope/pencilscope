import type { APIRoute } from "astro";
import { getEnv } from "@/lib/runtime";

export const ALL: APIRoute = async ({ request, locals, session }) => {
  const env = getEnv(locals);
  const headers = new Headers(request.headers);
  headers.delete("host");
  headers.delete("x-pencilscope-user-id");

  const userId = await session?.get("userId");
  if (typeof userId === "string" && userId) {
    headers.set("x-pencilscope-user-id", userId);
  }

  return env.API.fetch(new Request(request, { headers }));
};
