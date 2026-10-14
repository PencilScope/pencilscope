import type { APIRoute } from "astro";
import { getEnv } from "@/lib/runtime";

function safeNext(value: FormDataEntryValue | null): string {
  return typeof value === "string" && value.startsWith("/") && !value.startsWith("//")
    ? value
    : "/dashboard";
}

export const POST: APIRoute = async ({ request, locals, session, redirect }) => {
  const userId = await session?.get("userId");
  if (typeof userId !== "string") return redirect("/sign-in", 303);

  const form = await request.formData();
  const next = safeNext(form.get("next"));
  const response = await getEnv(locals).API.fetch("https://pencilscope-api.internal/api/onboarding", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-pencilscope-user-id": userId
    },
    body: JSON.stringify({
      countryCode: form.get("countryCode"),
      interestSlugs: form.getAll("interestSlugs")
    })
  });
  if (!response.ok) {
    const result = await response.json<{ error?: { message?: string } }>();
    const message = result.error?.message ?? "Could not save your preferences.";
    return redirect(`/onboarding?error=${encodeURIComponent(message)}&next=${encodeURIComponent(next)}`, 303);
  }
  return redirect(next, 303);
};
