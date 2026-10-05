export const deliveryModes = ["self-paced", "live", "hybrid", "ai-supported"] as const;
export type DeliveryMode = (typeof deliveryModes)[number];

export type CreateCourseInput = {
  title: string;
  description: string;
  subject: string;
  primaryLevel: string;
  deliveryMode: DeliveryMode;
  priceCents: number;
  currency: "SGD";
  publish: boolean;
  categorySlugs: string[];
};

export function parseCreateCourseInput(value: unknown): CreateCourseInput {
  if (!value || typeof value !== "object") throw new Error("A course payload is required");
  const input = value as Record<string, unknown>;
  const title = requiredText(input.title, "title", 3, 120);
  const description = requiredText(input.description, "description", 20, 2000);
  const subject = requiredText(input.subject, "subject", 2, 80);
  const primaryLevel = requiredText(input.primaryLevel, "primaryLevel", 2, 40);
  if (typeof input.deliveryMode !== "string" || !deliveryModes.includes(input.deliveryMode as DeliveryMode)) {
    throw new Error("deliveryMode is invalid");
  }
  if (!Number.isSafeInteger(input.priceCents) || Number(input.priceCents) < 50 || Number(input.priceCents) > 1_000_000) {
    throw new Error("priceCents must be an integer between 50 and 1000000");
  }
  if (input.currency !== "SGD") throw new Error("Only SGD pricing is currently supported");

  const categorySlugs = Array.isArray(input.categorySlugs)
    ? input.categorySlugs
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean)
      .slice(0, 10)
    : [];

  return {
    title,
    description,
    subject,
    primaryLevel,
    deliveryMode: input.deliveryMode as DeliveryMode,
    priceCents: Number(input.priceCents),
    currency: "SGD",
    publish: input.publish === true,
    categorySlugs
  };
}

function requiredText(value: unknown, field: string, min: number, max: number): string {
  if (typeof value !== "string") throw new Error(`${field} is required`);
  const text = value.trim();
  if (text.length < min || text.length > max) {
    throw new Error(`${field} must contain between ${min} and ${max} characters`);
  }
  return text;
}

export function slugifyCourse(title: string, id: string): string {
  const slug = title
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 70);
  return `${slug || "course"}-${id.slice(0, 8)}`;
}
