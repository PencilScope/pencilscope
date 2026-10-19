import { json, problem } from "../../../src/lib/http";
import type { ApiEnvironment } from "./index";

const ENQUIRY_TYPES = new Set([
  "general", "learning_enrolment", "creator_support", "business_partnership",
  "technical_problem", "billing", "privacy_account", "other"
]);

type ContactInput = {
  submissionId?: unknown; name?: unknown; countryCode?: unknown; countryName?: unknown;
  callingCode?: unknown; phone?: unknown; enquiryType?: unknown; message?: unknown;
  sourcePath?: unknown; consentVersion?: unknown;
};

const clean = (value: unknown, maximum: number): string =>
  typeof value === "string" ? value.trim().slice(0, maximum) : "";

const digestHex = async (value: string): Promise<string> => {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(bytes)].map((part) => part.toString(16).padStart(2, "0")).join("");
};

export async function handleContactEnquiryRequest(
  request: Request, env: ApiEnvironment, pathname: string
): Promise<Response | null> {
  if (pathname !== "/api/contact-enquiries") return null;
  if (request.method !== "POST") return problem(405, "method_not_allowed", "Method not allowed.");

  let input: ContactInput;
  try { input = await request.json<ContactInput>(); }
  catch { return problem(400, "invalid_json", "A valid submission is required."); }

  const submissionId = clean(input.submissionId, 36);
  const name = clean(input.name, 100);
  const countryCode = clean(input.countryCode, 2).toUpperCase();
  const countryName = clean(input.countryName, 80);
  const callingCode = clean(input.callingCode, 5);
  const nationalPhone = clean(input.phone, 24).replace(/[\s().-]/g, "");
  const enquiryType = clean(input.enquiryType, 40);
  const message = clean(input.message, 4000);
  const sourcePath = clean(input.sourcePath, 300);
  const consentVersion = clean(input.consentVersion, 30);

  if (!/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(submissionId)) {
    return problem(400, "invalid_submission", "Refresh the page and try again.");
  }
  if (name.length < 2 || !/^[A-Z]{2}$/.test(countryCode) || countryName.length < 2) {
    return problem(400, "invalid_contact", "Name and country are required.");
  }
  if (!/^\+[1-9]\d{0,3}$/.test(callingCode) || !/^\d{6,14}$/.test(nationalPhone)) {
    return problem(400, "invalid_phone", "Enter a valid country code and contact number.");
  }
  const e164 = callingCode + nationalPhone;
  if (e164.length < 8 || e164.length > 16) {
    return problem(400, "invalid_phone", "Enter a valid contact number.");
  }
  if (!ENQUIRY_TYPES.has(enquiryType) || message.length < 10) {
    return problem(400, "invalid_enquiry", "Choose an enquiry type and enter at least 10 characters.");
  }
  if (!/^\/(?!\/)[^\s]*$/.test(sourcePath) || consentVersion !== "2026-10") {
    return problem(400, "invalid_submission", "Refresh the page and try again.");
  }

  const existing = await env.DB.prepare(
    "SELECT id, reference_code, status, created_at FROM contact_enquiries WHERE submission_key = ?"
  ).bind(submissionId).first<{ id: string; reference_code: string; status: string; created_at: string }>();
  if (existing) return json({ enquiry: {
    id: existing.id, referenceCode: existing.reference_code,
    status: existing.status, createdAt: existing.created_at
  }});

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const date = now.slice(0, 10).replaceAll("-", "");
  const referenceCode = `ENQ-${date}-${id.slice(0, 6).toUpperCase()}`;
  const dayPath = now.slice(0, 10).replaceAll("-", "/");
  const objectKey = `contact-enquiries/v1/${env.ENVIRONMENT}/${dayPath}/${id.slice(0, 2)}/${id}.json`;
  const payload = {
    schemaVersion: 1, id, referenceCode, submissionId,
    contact: { name, country: { code: countryCode, name: countryName, callingCode }, phone: { national: nationalPhone, e164 } },
    enquiry: { type: enquiryType, message },
    sourcePath, consentVersion, submittedAt: now
  };
  const serialized = JSON.stringify(payload);
  const checksum = await digestHex(serialized);
  const sizeBytes = new TextEncoder().encode(serialized).byteLength;

  await env.CONTACT_ENQUIRIES.put(objectKey, serialized, {
    httpMetadata: { contentType: "application/json; charset=utf-8", cacheControl: "private, no-store" },
    customMetadata: { id, referenceCode, schemaVersion: "1", checksum }
  });

  try {
    await env.DB.prepare(
      `INSERT INTO contact_enquiries
        (id, reference_code, submission_key, object_key, checksum_sha256, size_bytes, schema_version,
         display_name, country_code, country_name, enquiry_type, phone_last4, source_path,
         consent_version, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, 'new', ?, ?)`
    ).bind(
      id, referenceCode, submissionId, objectKey, checksum, sizeBytes,
      name, countryCode, countryName, enquiryType, nationalPhone.slice(-4),
      sourcePath, consentVersion, now, now
    ).run();
  } catch (error) {
    await env.CONTACT_ENQUIRIES.delete(objectKey);
    const retry = await env.DB.prepare(
      "SELECT id, reference_code, status, created_at FROM contact_enquiries WHERE submission_key = ?"
    ).bind(submissionId).first<{ id: string; reference_code: string; status: string; created_at: string }>();
    if (retry) return json({ enquiry: {
      id: retry.id, referenceCode: retry.reference_code, status: retry.status, createdAt: retry.created_at
    }});
    console.error("contact_enquiry.catalogue_failed", { id, error });
    return problem(503, "enquiry_unavailable", "Your enquiry could not be saved. Please try again.");
  }

  return json({ enquiry: { id, referenceCode, status: "new", createdAt: now } }, { status: 201 });
}
