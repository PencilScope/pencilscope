import { Resend } from "resend";

export type EmailMessage = { to: string; subject: string; html: string };

export async function sendEmail(env: AppEnvironment, message: EmailMessage): Promise<string> {
  if (!env.RESEND_API_KEY) throw new Error("RESEND_API_KEY is not configured");
  const resend = new Resend(env.RESEND_API_KEY);
  const result = await resend.emails.send({
    from: env.EMAIL_FROM ?? "PencilScope <onboarding@resend.dev>",
    to: message.to,
    subject: message.subject,
    html: message.html
  });
  if (result.error) throw new Error(result.error.message);
  if (!result.data?.id) throw new Error("Resend did not return a message ID");
  return result.data.id;
}

