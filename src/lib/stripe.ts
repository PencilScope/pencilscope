import Stripe from "stripe";

export function createStripe(secretKey: string): Stripe {
  return new Stripe(secretKey, {
    httpClient: Stripe.createFetchHttpClient(),
    maxNetworkRetries: 2,
    appInfo: { name: "PencilScope", version: "0.1.0" }
  });
}

export async function constructStripeEvent(
  stripe: Stripe,
  payload: string,
  signature: string,
  webhookSecret: string
): Promise<Stripe.Event> {
  return stripe.webhooks.constructEventAsync(
    payload,
    signature,
    webhookSecret,
    undefined,
    Stripe.createSubtleCryptoProvider()
  );
}

