import type { APIRoute } from "astro";
import { PORTAL_LOCALE_COOKIE, portalLocale, portalLocales } from "@/lib/i18n";
import { requestApi } from "@/lib/api-client";

const supported = new Set<string>(portalLocales.map((locale) => locale.code));

function safeReturnTo(value: FormDataEntryValue | null): string {
  return typeof value === "string" && value.startsWith("/") && !value.startsWith("//") ? value : "/";
}

export const POST: APIRoute = async ({ request, cookies, session, redirect, url }) => {
  const form = await request.formData();
  const requested = form.get("locale");
  if (typeof requested !== "string" || !supported.has(requested)) {
    return new Response("Unsupported language", { status: 400 });
  }
  const locale = portalLocale(requested);
  cookies.set(PORTAL_LOCALE_COOKIE, locale, {
    path: "/", httpOnly: true, sameSite: "lax", secure: url.protocol === "https:", maxAge: 60 * 60 * 24 * 365
  });
  const userId = await session?.get("userId");
  if (typeof userId === "string") {
    await requestApi("/api/profile/language", { userId, method: "POST", body: { locale } });
  }
  return redirect(safeReturnTo(form.get("returnTo")), 303);
};
