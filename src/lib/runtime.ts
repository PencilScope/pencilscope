import { env as cloudflareEnv } from "cloudflare:workers";

export function getEnv(_locals?: App.Locals): AppEnvironment {
  return cloudflareEnv as unknown as AppEnvironment;
}
