export const TURNSTILE_TEST_SITE_KEY = "1x00000000000000000000AA";
export const TURNSTILE_TEST_SECRET_KEY = "1x0000000000000000000000000000000AA";

type TurnstileEnvironment = {
  ENVIRONMENT: string;
  TURNSTILE_SITE_KEY?: string;
  TURNSTILE_SECRET_KEY?: string;
};

type TurnstileResponse = {
  success?: boolean;
  hostname?: string;
  action?: string;
  "error-codes"?: string[];
};

export type TurnstileVerification = {
  success: boolean;
  reason?: "missing" | "unavailable" | "invalid";
};

const configuredValue = (value: string | undefined): string => value?.trim() ?? "";

export function turnstileSiteKey(env: TurnstileEnvironment): string {
  return configuredValue(env.TURNSTILE_SITE_KEY) ||
    (env.ENVIRONMENT === "development" ? TURNSTILE_TEST_SITE_KEY : "");
}

function turnstileSecretKey(env: TurnstileEnvironment): string {
  return configuredValue(env.TURNSTILE_SECRET_KEY) ||
    (env.ENVIRONMENT === "development" ? TURNSTILE_TEST_SECRET_KEY : "");
}

export async function verifyTurnstile(
  env: TurnstileEnvironment,
  options: {
    token: FormDataEntryValue | null;
    remoteIp?: string | null;
    expectedAction: string;
    expectedHostname: string;
  },
  fetcher: typeof fetch = fetch
): Promise<TurnstileVerification> {
  const token = typeof options.token === "string" ? options.token.trim() : "";
  if (!token || token.length > 2048) return { success: false, reason: "missing" };

  const secret = turnstileSecretKey(env);
  if (!secret) return { success: false, reason: "unavailable" };

  try {
    const response = await fetcher("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        secret,
        response: token,
        ...(options.remoteIp ? { remoteip: options.remoteIp } : {}),
        idempotency_key: crypto.randomUUID()
      })
    });
    if (!response.ok) return { success: false, reason: "unavailable" };

    const result = await response.json<TurnstileResponse>();
    const hostnameMatches = env.ENVIRONMENT === "development" ||
      result.hostname === options.expectedHostname;
    if (!result.success || result.action !== options.expectedAction || !hostnameMatches) {
      return { success: false, reason: "invalid" };
    }
    return { success: true };
  } catch {
    return { success: false, reason: "unavailable" };
  }
}

export function turnstileErrorMessage(result: TurnstileVerification): string {
  return result.reason === "unavailable"
    ? "Security verification is temporarily unavailable. Please try again later."
    : "Complete the security verification and try again.";
}
