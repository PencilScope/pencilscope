import { json, problem } from "../../../src/lib/http";
import type { ApiEnvironment } from "./index";

type GoogleIntegration = {
  user_id: string;
  google_email: string;
  access_token_encrypted: string;
  refresh_token_encrypted: string | null;
  token_expires_at: string;
  scopes: string;
  status: string;
};

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function userId(request: Request): string | null {
  return request.headers.get("x-pencilscope-user-id")?.trim() || null;
}

function encode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "");
}

function decode(value: string): Uint8Array<ArrayBuffer> {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function encryptionKey(env: ApiEnvironment): Promise<CryptoKey> {
  if (!env.GOOGLE_CLIENT_SECRET) throw new Error("Google integration is not configured.");
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(`pencilscope-google:${env.GOOGLE_CLIENT_SECRET}`));
  return crypto.subtle.importKey("raw", digest, "AES-GCM", false, ["encrypt", "decrypt"]);
}

async function encrypt(env: ApiEnvironment, value: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await encryptionKey(env), encoder.encode(value));
  return `${encode(iv)}.${encode(new Uint8Array(ciphertext))}`;
}

async function decrypt(env: ApiEnvironment, value: string): Promise<string> {
  const [iv, ciphertext] = value.split(".");
  if (!iv || !ciphertext) throw new Error("Stored Google credential is invalid.");
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: decode(iv) }, await encryptionKey(env), decode(ciphertext)
  );
  return decoder.decode(plaintext);
}

function validRedirect(env: ApiEnvironment, value: string): boolean {
  try {
    const url = new URL(value);
    if (url.pathname !== "/api/integrations/google/callback" || url.search || url.hash) return false;
    const origins = (env.OAUTH_ALLOWED_REDIRECT_ORIGINS || env.APP_URL).split(",").map((item) => new URL(item.trim()).origin);
    return origins.includes(url.origin);
  } catch {
    return false;
  }
}

async function integration(env: ApiEnvironment, ownerUserId: string): Promise<GoogleIntegration | null> {
  return env.DB.prepare("SELECT * FROM google_integrations WHERE user_id = ? AND status = 'active'")
    .bind(ownerUserId).first<GoogleIntegration>();
}

async function accessToken(env: ApiEnvironment, row: GoogleIntegration): Promise<string> {
  if (new Date(row.token_expires_at).getTime() > Date.now() + 120_000) {
    return decrypt(env, row.access_token_encrypted);
  }
  if (!row.refresh_token_encrypted || !env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
    throw new Error("Reconnect Google Calendar to continue.");
  }
  const refreshToken = await decrypt(env, row.refresh_token_encrypted);
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: "refresh_token"
    })
  });
  const token = await response.json<{ access_token?: string; expires_in?: number; error?: string }>();
  if (!response.ok || !token.access_token) {
    await env.DB.prepare("UPDATE google_integrations SET status = 'error', updated_at = ? WHERE user_id = ?")
      .bind(new Date().toISOString(), row.user_id).run();
    throw new Error(`Google token refresh failed: ${token.error ?? response.status}`);
  }
  const expiresAt = new Date(Date.now() + Number(token.expires_in ?? 3600) * 1000).toISOString();
  await env.DB.prepare(
    "UPDATE google_integrations SET access_token_encrypted = ?, token_expires_at = ?, updated_at = ? WHERE user_id = ?"
  ).bind(await encrypt(env, token.access_token), expiresAt, new Date().toISOString(), row.user_id).run();
  return token.access_token;
}

async function exchange(request: Request, env: ApiEnvironment): Promise<Response> {
  const actor = userId(request);
  if (!actor) return problem(401, "authentication_required", "Sign in to connect Google Calendar.");
  let input: { code?: unknown; redirectUri?: unknown; codeVerifier?: unknown };
  try { input = await request.json(); } catch { return problem(400, "invalid_json", "A JSON body is required."); }
  const code = typeof input.code === "string" ? input.code.trim() : "";
  const redirectUri = typeof input.redirectUri === "string" ? input.redirectUri.trim() : "";
  const verifier = typeof input.codeVerifier === "string" ? input.codeVerifier.trim() : "";
  if (!code || !verifier || !validRedirect(env, redirectUri) || !env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
    return problem(400, "invalid_google_connection", "The Google connection request is invalid or expired.");
  }
  const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code, client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: redirectUri, grant_type: "authorization_code", code_verifier: verifier
    })
  });
  const token = await tokenResponse.json<{
    access_token?: string; refresh_token?: string; expires_in?: number; scope?: string; error?: string;
  }>();
  if (!tokenResponse.ok || !token.access_token) {
    return problem(401, "google_connection_failed", `Google authorization failed: ${token.error ?? tokenResponse.status}`);
  }
  const profileResponse = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
    headers: { authorization: `Bearer ${token.access_token}` }
  });
  const profile = await profileResponse.json<{ email?: string; email_verified?: boolean }>();
  if (!profileResponse.ok || !profile.email || profile.email_verified !== true) {
    return problem(401, "google_profile_missing", "Google did not return a verified account email.");
  }
  const existing = await env.DB.prepare("SELECT refresh_token_encrypted FROM google_integrations WHERE user_id = ?")
    .bind(actor).first<{ refresh_token_encrypted: string | null }>();
  const refreshEncrypted = token.refresh_token
    ? await encrypt(env, token.refresh_token)
    : existing?.refresh_token_encrypted ?? null;
  if (!refreshEncrypted) return problem(409, "google_refresh_token_missing", "Reconnect Google and approve offline access.");
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO google_integrations
      (user_id, google_email, access_token_encrypted, refresh_token_encrypted,
       token_expires_at, scopes, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET google_email = excluded.google_email,
       access_token_encrypted = excluded.access_token_encrypted,
       refresh_token_encrypted = excluded.refresh_token_encrypted,
       token_expires_at = excluded.token_expires_at, scopes = excluded.scopes,
       status = 'active', updated_at = excluded.updated_at`
  ).bind(
    actor, profile.email.toLowerCase(), await encrypt(env, token.access_token), refreshEncrypted,
    new Date(Date.now() + Number(token.expires_in ?? 3600) * 1000).toISOString(),
    token.scope ?? "", now, now
  ).run();
  return json({ connected: true, email: profile.email.toLowerCase() });
}

export async function createGoogleMeetForSession(env: ApiEnvironment, input: {
  ownerUserId: string;
  title: string;
  description: string;
  startsAt: string;
  endsAt: string;
  timezone: string;
  attendeeEmails: string[];
}): Promise<{ eventId: string; meetingUrl: string; meetingCode: string | null }> {
  const row = await integration(env, input.ownerUserId);
  if (!row) throw new Error("The course owner must connect Google Calendar in Preferences before adding an online session.");
  const token = await accessToken(env, row);
  const response = await fetch(
    "https://www.googleapis.com/calendar/v3/calendars/primary/events?conferenceDataVersion=1&sendUpdates=all",
    {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        summary: input.title,
        description: input.description,
        start: { dateTime: input.startsAt, timeZone: input.timezone },
        end: { dateTime: input.endsAt, timeZone: input.timezone },
        attendees: [...new Set(input.attendeeEmails.map((email) => email.toLowerCase()))].map((email) => ({ email })),
        guestsCanInviteOthers: false,
        guestsCanModify: false,
        conferenceData: { createRequest: { requestId: crypto.randomUUID(), conferenceSolutionKey: { type: "hangoutsMeet" } } },
        reminders: {
          useDefault: false,
          overrides: [
            { method: "popup", minutes: 1440 },
            { method: "popup", minutes: 60 },
            { method: "popup", minutes: 10 },
            { method: "email", minutes: 60 }
          ]
        }
      })
    }
  );
  const event = await response.json<{
    id?: string; hangoutLink?: string;
    conferenceData?: { conferenceId?: string; entryPoints?: Array<{ entryPointType?: string; uri?: string }> };
    error?: { message?: string };
  }>();
  const meetingUrl = event.hangoutLink
    ?? event.conferenceData?.entryPoints?.find((entry) => entry.entryPointType === "video")?.uri;
  if (!response.ok || !event.id || !meetingUrl) {
    throw new Error(event.error?.message ?? "Google did not finish creating the Meet link. Please try again.");
  }
  return { eventId: event.id, meetingUrl, meetingCode: event.conferenceData?.conferenceId ?? null };
}

export async function updateGoogleMeetForSession(env: ApiEnvironment, input: {
  ownerUserId: string;
  eventId: string;
  title: string;
  description: string;
  startsAt: string;
  endsAt: string;
  timezone: string;
}): Promise<void> {
  const row = await integration(env, input.ownerUserId);
  if (!row) throw new Error("The course owner must reconnect Google Calendar before changing this online session.");
  const token = await accessToken(env, row);
  const response = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(input.eventId)}?sendUpdates=all`,
    {
      method: "PATCH",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        summary: input.title,
        description: input.description,
        start: { dateTime: input.startsAt, timeZone: input.timezone },
        end: { dateTime: input.endsAt, timeZone: input.timezone }
      })
    }
  );
  if (!response.ok) {
    const payload: { error?: { message?: string } } = await response.json<{ error?: { message?: string } }>().catch(() => ({}));
    throw new Error(payload.error?.message ?? "Google Calendar could not update this session.");
  }
}
async function syncEventAttendees(env: ApiEnvironment, session: {
  google_calendar_event_id: string; tutor_id: string;
}): Promise<void> {
  const row = await integration(env, session.tutor_id);
  if (!row) return;
  const attendees = await env.DB.prepare(
    `SELECT DISTINCT u.email FROM course_sessions s
     JOIN enrolment_offerings eo ON eo.course_offering_id = s.course_offering_id AND eo.status = 'active'
     JOIN users u ON u.id = eo.student_user_id AND u.status = 'active'
     WHERE s.google_calendar_event_id = ?`
  ).bind(session.google_calendar_event_id).all<{ email: string }>();
  const token = await accessToken(env, row);
  await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(session.google_calendar_event_id)}?sendUpdates=all`,
    {
      method: "PATCH",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ attendees: attendees.results.map(({ email }) => ({ email })) })
    }
  );
}

export async function sendSessionReminders(env: ApiEnvironment): Promise<void> {
  const nowMs = Date.now();
  const horizon = new Date(nowMs + 24 * 60 * 60_000 + 6 * 60_000).toISOString();
  const sessions = await env.DB.prepare(
    `SELECT s.id, s.title, s.starts_at, s.google_calendar_event_id,
      o.course_id, c.title AS course_title, c.tutor_id
     FROM course_sessions s JOIN course_offerings o ON o.id = s.course_offering_id
     JOIN courses c ON c.id = o.course_id
     WHERE s.status = 'scheduled' AND s.starts_at > ? AND s.starts_at <= ?`
  ).bind(new Date(nowMs).toISOString(), horizon).all<{
    id: string; title: string; starts_at: string; google_calendar_event_id: string | null;
    course_id: string; course_title: string; tutor_id: string;
  }>();
  for (const session of sessions.results) {
    const minutesUntil = (new Date(session.starts_at).getTime() - nowMs) / 60_000;
    const reminderMinutes = [10, 60, 1440].find((minutes) => minutesUntil <= minutes);
    if (!reminderMinutes) continue;
    if (session.google_calendar_event_id) {
      await syncEventAttendees(env, { google_calendar_event_id: session.google_calendar_event_id, tutor_id: session.tutor_id }).catch(() => undefined);
    }
    const recipients = await env.DB.prepare(
      `SELECT DISTINCT eo.student_user_id AS user_id
       FROM course_sessions s JOIN enrolment_offerings eo ON eo.course_offering_id = s.course_offering_id
       WHERE s.id = ? AND eo.status = 'active'`
    ).bind(session.id).all<{ user_id: string }>();
    if (!recipients.results.length) continue;
    const campaignId = `session-reminder:${session.id}:${reminderMinutes}`;
    const deliveredAt = new Date().toISOString();
    const label = reminderMinutes === 1440 ? "tomorrow" : reminderMinutes === 60 ? "in one hour" : "in 10 minutes";
    const statements = [env.DB.prepare(
      `INSERT OR IGNORE INTO notification_campaigns
        (id, title, body, category, priority, action_url, action_label,
         audience_type, audience_json, status, recipient_count, created_by, created_at, published_at)
       VALUES (?, ?, ?, 'learning', 'important', ?, 'Open course',
         'specific_users', ?, 'published', ?, ?, ?, ?)`
    ).bind(
      campaignId, `${session.title} starts ${label}`,
      `${session.course_title} has an online session scheduled for ${new Date(session.starts_at).toISOString()}.`,
      `/learn/${session.course_id}`, JSON.stringify({ sessionId: session.id }),
      recipients.results.length, session.tutor_id, deliveredAt, deliveredAt
    )];
    for (const recipient of recipients.results) {
      statements.push(env.DB.prepare(
        `INSERT OR IGNORE INTO session_reminder_deliveries
          (session_id, user_id, reminder_minutes, delivered_at) VALUES (?, ?, ?, ?)`
      ).bind(session.id, recipient.user_id, reminderMinutes, deliveredAt));
      statements.push(env.DB.prepare(
        `INSERT OR IGNORE INTO in_app_notifications (id, campaign_id, user_id, delivered_at)
         VALUES (?, ?, ?, ?)`
      ).bind(crypto.randomUUID(), campaignId, recipient.user_id, deliveredAt));
    }
    await env.DB.batch(statements);
  }
}

export async function handleGoogleMeetRequest(
  request: Request,
  env: ApiEnvironment,
  pathname: string
): Promise<Response | null> {
  if (!pathname.startsWith("/api/integrations/google")) return null;
  const actor = userId(request);
  if (!actor) return problem(401, "authentication_required", "Sign in to manage Google Calendar.");
  if (request.method === "GET" && pathname === "/api/integrations/google/status") {
    const row = await env.DB.prepare(
      "SELECT google_email, status, updated_at FROM google_integrations WHERE user_id = ?"
    ).bind(actor).first();
    return json({ integration: row ?? null });
  }
  if (request.method === "POST" && pathname === "/api/integrations/google/exchange") return exchange(request, env);
  if (request.method === "DELETE" && pathname === "/api/integrations/google") {
    await env.DB.prepare("DELETE FROM google_integrations WHERE user_id = ?").bind(actor).run();
    return json({ connected: false });
  }
  return problem(405, "method_not_allowed", "Method not allowed.");
}
