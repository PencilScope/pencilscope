import type { APIRoute } from "astro";
import { getEnv } from "@/lib/runtime";

export const POST: APIRoute = async ({ request, locals, session, redirect }) => {
  const form = await request.formData();
  const response = await getEnv(locals).API.fetch("https://pencilscope-api.internal/api/auth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      displayName: form.get("displayName"),
      email: form.get("email"),
      password: form.get("password"),
      accountType: form.get("accountType"),
      organizationName: form.get("organizationName")
    })
  });
  const result = await response.json<{ user?: { id: string }; error?: { message?: string } }>();
  if (!response.ok || !result.user) {
    return redirect(`/register?error=${encodeURIComponent(result.error?.message ?? "Registration failed.")}`, 303);
  }
  session?.set("userId", result.user.id);
  return redirect("/dashboard", 303);
};
