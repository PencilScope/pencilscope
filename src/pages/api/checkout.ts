import type { APIRoute } from "astro";
import { getEnv } from "@/lib/runtime";

export const POST: APIRoute = async ({ request, locals, session, redirect }) => {
  const form = await request.formData();
  const returnTo = typeof form.get("returnTo") === "string" ? String(form.get("returnTo")) : "/courses";
  form.delete("returnTo");
  const userId = await session?.get("userId");
  if (typeof userId !== "string") return redirect(`/sign-in?next=${encodeURIComponent(returnTo)}`, 303);
  const response = await getEnv(locals).API.fetch("https://pencilscope-api.internal/api/checkout", {
    method: "POST",
    headers: { "x-pencilscope-user-id": userId },
    body: form
  });
  if (response.status >= 300 && response.status < 400) return response;
  const result: { error?: { message?: string } } =
    await response.json<{ error?: { message?: string } }>().catch(() => ({}));
  return redirect(`${returnTo}?error=${encodeURIComponent(result.error?.message ?? "Checkout could not be started.")}`, 303);
};
