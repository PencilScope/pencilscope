import type { APIRoute } from "astro";
import { getEnv } from "@/lib/runtime";

const actions = new Set(["create", "accept", "sharing", "message", "block", "unblock"]);

export const POST: APIRoute = async ({ request, params, locals, session, redirect }) => {
  const userId = await session?.get("userId");
  if (typeof userId !== "string") return redirect("/sign-in?next=/network", 303);
  const action = params.action ?? "";
  if (!actions.has(action)) return new Response("Not found", { status: 404 });

  const form = await request.formData();
  const connectionId = typeof form.get("connectionId") === "string"
    ? String(form.get("connectionId"))
    : "";
  if (action !== "create" && !connectionId) {
    return redirect("/network?error=Connection%20not%20found.", 303);
  }
  const endpoint = action === "create"
    ? "/api/connections"
    : `/api/connections/${encodeURIComponent(connectionId)}/${action}`;
  const response = await getEnv(locals).API.fetch(`https://pencilscope-api.internal${endpoint}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-pencilscope-user-id": userId
    },
    body: JSON.stringify({
      email: form.get("email"),
      body: form.get("body"),
      shareProgress: form.get("shareProgress") === "on"
    })
  });
  if (!response.ok) {
    const result: { error?: { message?: string } } =
      await response.json<{ error?: { message?: string } }>().catch(() => ({}));
    return redirect(`/network?error=${encodeURIComponent(result.error?.message ?? "The network could not be updated.")}`, 303);
  }
  const notices: Record<string, string> = {
    create: "request-sent",
    accept: "accepted",
    sharing: "sharing-updated",
    message: "message-sent",
    block: "blocked",
    unblock: "unblocked"
  };
  const sections: Record<string, string> = {
    create: "invitations",
    accept: "invitations",
    sharing: "sharing",
    message: "messages",
    block: "blocked",
    unblock: "blocked"
  };
  return redirect(`/network?section=${sections[action]}&notice=${notices[action]}`, 303);
};
