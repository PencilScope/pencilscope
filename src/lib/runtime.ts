import { env as cloudflareEnv } from "cloudflare:workers";

export function getEnv(_locals?: App.Locals): AppEnvironment {
  return cloudflareEnv as unknown as AppEnvironment;
}

export function requireSecret(
  env: AppEnvironment,
  name: "STRIPE_SECRET_KEY" | "STRIPE_WEBHOOK_SECRET" | "RESEND_API_KEY"
): string {
  const value = env[name];
  if (!value) {
    throw new Error(`${name} is not configured`);
  }
  return value;
}
