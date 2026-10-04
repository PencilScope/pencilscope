import type { APIRoute } from "astro";
import { json } from "@/lib/http";
import { getEnv } from "@/lib/runtime";

export const GET: APIRoute = async ({ locals }) => {
  const env = getEnv(locals);
  let database = "unavailable";
  try {
    await env.DB.prepare("SELECT 1").first();
    database = "ready";
  } catch {
    database = "not-initialised";
  }
  return json({ status: "ok", service: "pencilscope", environment: env.ENVIRONMENT, database, time: new Date().toISOString() });
};

