import type { APIRoute } from "astro";
import { getEnv } from "@/lib/runtime";
import { turnstileErrorMessage, verifyTurnstile } from "@/lib/turnstile";

export const POST: APIRoute = async ({ request, locals, session }) => {
  const requestUrl = new URL(request.url);
  const origin = request.headers.get("origin");
  if (origin && origin !== requestUrl.origin) {
    return Response.json({ error: "This submission could not be verified." }, { status: 403 });
  }

  const form = await request.formData();
  if (String(form.get("companyWebsite") ?? "").trim()) {
    return Response.json({ error: "Your enquiry could not be submitted." }, { status: 400 });
  }
  const startedAt = Number(form.get("startedAt"));
  const elapsed = Date.now() - startedAt;
  if (!Number.isFinite(startedAt) || elapsed < 1_500 || elapsed > 2 * 60 * 60_000) {
    return Response.json({ error: "Please reopen the contact form and try again." }, { status: 400 });
  }

  const env = getEnv(locals);
  const verification = await verifyTurnstile(env, {
    token: form.get("cf-turnstile-response"),
    remoteIp: request.headers.get("CF-Connecting-IP"),
    expectedAction: "contact",
    expectedHostname: requestUrl.hostname
  });
  if (!verification.success) {
    return Response.json(
      { error: turnstileErrorMessage(verification) },
      { status: verification.reason === "unavailable" ? 503 : 400 }
    );
  }

  const response = await env.API.fetch("https://pencilscope-api.internal/api/contact-enquiries", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      submissionId: form.get("submissionId"),
      name: form.get("name"),
      countryCode: form.get("countryCode"),
      countryName: form.get("countryName"),
      callingCode: form.get("callingCode"),
      phone: form.get("phone"),
      enquiryType: form.get("enquiryType"),
      message: form.get("message"),
      sourcePath: form.get("sourcePath"),
      consentVersion: form.get("consentVersion"),
      submittedUserId: await session?.get("userId")
    })
  });
  const result = await response.json<{ enquiry?: unknown; error?: { message?: string } }>()
    .catch(() => ({ enquiry: undefined, error: undefined }));
  if (!response.ok) {
    return Response.json(
      { error: result.error?.message ?? "Your enquiry could not be saved. Please try again." },
      { status: response.status >= 400 && response.status < 500 ? response.status : 503 }
    );
  }
  return Response.json(result, { status: response.status });
};
