import type { APIRoute } from "astro";

export const POST: APIRoute = async ({ session, redirect }) => {
  session?.delete("userId");
  return redirect("/", 303);
};
