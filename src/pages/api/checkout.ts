import type { APIRoute } from "astro";
import { getEnv } from "@/lib/runtime";

export const POST: APIRoute = async ({ request, locals, session, redirect }) => {
  const form = await request.formData();
  const returnTo = typeof form.get("returnTo") === "string" ? String(form.get("returnTo")) : "/courses";
  const courseId = typeof form.get("courseId") === "string" ? String(form.get("courseId")) : "";
  form.delete("returnTo");
  const userId = await session?.get("userId");
  if (typeof userId !== "string") return redirect(`/sign-in?next=${encodeURIComponent(returnTo)}`, 303);
  const traceId = crypto.randomUUID();
  const payload = new URLSearchParams();
  for (const [key, value] of form.entries()) {
    if (typeof value === "string") payload.append(key, value);
  }
  const apiRequest = new Request("https://pencilscope-api.internal/api/checkout", {
    method: "POST",
    redirect: "manual",
    headers: {
      "content-type": "application/x-www-form-urlencoded;charset=UTF-8",
      "x-pencilscope-user-id": userId,
      "x-pencilscope-route-source": "web-checkout",
      "x-pencilscope-trace-id": traceId
    },
    body: payload
  });
  const response = await getEnv(locals).API.fetch(apiRequest);
  if (response.status >= 300 && response.status < 400) return response;
  const result: { error?: { code?: string; message?: string } } =
    await response.json<{ error?: { code?: string; message?: string } }>().catch(() => ({}));
  if (result.error?.code === "already_enrolled" && courseId) {
    return redirect(`/learn/${encodeURIComponent(courseId)}`, 303);
  }
  console.warn("checkout.api_rejected", {
    traceId,
    status: response.status,
    code: result.error?.code ?? "unknown_error",
    returnTo
  });
  const separator = returnTo.includes("?") ? "&" : "?";
  return redirect(`${returnTo}${separator}error=${encodeURIComponent(result.error?.message ?? "Checkout could not be started.")}&trace=${encodeURIComponent(traceId)}`, 303);
};
