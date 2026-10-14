import type { APIRoute } from "astro";
import { getEnv } from "@/lib/runtime";

export const POST: APIRoute = async ({ locals, session, redirect }) => {
  const userId = await session?.get("userId");
  const sessionId = await session?.get("sessionId");
  if (typeof userId === "string" && typeof sessionId === "string") {
    await getEnv(locals).API.fetch(`https://pencilscope-api.internal/api/sessions/${encodeURIComponent(sessionId)}`, {
      method: "DELETE",
      headers: { "x-pencilscope-user-id": userId }
    });
  }
  session?.delete("userId");
  session?.delete("sessionId");
  return redirect("/", 303);
};
