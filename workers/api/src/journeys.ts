import { getCreatorActorById } from "../../../src/lib/auth";
import { json, problem } from "../../../src/lib/http";
import type { ApiEnvironment } from "./index";
import { calculateOfferingPrice } from "./platform-pricing";
import { createGoogleMeetForSession, deleteGoogleMeetForSession, updateGoogleMeetForSession } from "./google-meet";
import { questionMediaInsert, resolveQuestionMedia, serveQuestionMediaVersion } from "./question-media";

type UserRow = {
  id: string;
  email: string;
  display_name: string;
  role: "parent" | "student" | "tutor" | "admin";
  status: string;
  account_type: "individual" | "organization";
  organization_name: string | null;
};

const encoder = new TextEncoder();
// Cloudflare Workers Web Crypto currently caps PBKDF2 at 100,000 iterations.
const passwordIterations = 100_000;

function userIdFrom(request: Request): string | null {
  return request.headers.get("x-pencilscope-user-id")?.trim() || null;
}

async function currentUser(request: Request, env: ApiEnvironment): Promise<UserRow | null> {
  const id = userIdFrom(request);
  if (!id) return null;
  return env.DB.prepare(
    `SELECT u.id, u.email, u.display_name, u.role, u.status,
      COALESCE(ap.account_type, 'individual') AS account_type,
      ap.organization_name
     FROM users u LEFT JOIN account_profiles ap ON ap.user_id = u.id
     WHERE u.id = ? AND u.status = 'active'`
  ).bind(id).first<UserRow>();
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function constantTimeEqual(left: string, right: string): boolean {
  const length = Math.max(left.length, right.length);
  let difference = left.length ^ right.length;
  for (let index = 0; index < length; index += 1) {
    difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return difference === 0;
}

async function derivePassword(password: string, salt: Uint8Array, iterations: number): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(password),
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: new Uint8Array(salt).buffer, iterations },
    key,
    256
  );
  return encodeBase64(new Uint8Array(bits));
}

async function parseJson(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const value = await request.json();
    return value && typeof value === "object" ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function text(value: unknown, min: number, max: number): string | null {
  if (typeof value !== "string") return null;
  const result = value.trim();
  return result.length >= min && result.length <= max ? result : null;
}

async function register(request: Request, env: ApiEnvironment): Promise<Response> {
  const input = await parseJson(request);
  const displayName = text(input?.displayName, 2, 80);
  const email = text(input?.email, 5, 254)?.toLowerCase();
  const password = text(input?.password, 10, 128);
  const accountType = input?.accountType === "organization" ? "organization" : "individual";
  const organizationName = accountType === "organization" ? text(input?.organizationName, 2, 160) : null;
  if (!displayName || !email || !email.includes("@") || !password || !accountType ||
      (accountType === "organization" && !organizationName)) {
    return problem(400, "invalid_registration", "Provide a name, valid email, and password of at least 10 characters.");
  }
  const role = accountType === "organization" ? "tutor" : "student";

  const existing = await env.DB.prepare("SELECT id FROM users WHERE email = ?").bind(email).first();
  if (existing) return problem(409, "email_registered", "An account already exists for this email.");

  const id = crypto.randomUUID();
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await derivePassword(password, salt, passwordIterations);
  const now = new Date().toISOString();
  const statements = [
    env.DB.prepare(
      "INSERT INTO users (id, email, display_name, role, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'active', ?, ?)"
    ).bind(id, email, displayName, role, now, now),
    env.DB.prepare(
      "INSERT INTO user_credentials (user_id, password_hash, password_salt, password_iterations, created_at) VALUES (?, ?, ?, ?, ?)"
    ).bind(id, hash, encodeBase64(salt), passwordIterations, now),
    env.DB.prepare(
      `INSERT INTO account_profiles
        (user_id, account_type, organization_name, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`
    ).bind(id, accountType, organizationName, now, now),
    env.DB.prepare(
      `INSERT INTO creator_profiles
        (user_id, public_name, biography, verification_status, payout_status, created_at, updated_at)
       VALUES (?, ?, '', 'unverified', 'not_configured', ?, ?)`
    ).bind(id, organizationName ?? displayName, now, now),
    env.DB.prepare(
      `INSERT INTO audit_logs (id, actor_user_id, action, entity_type, entity_id, metadata_json, created_at)
       VALUES (?, ?, 'auth.registered', 'user', ?, ?, ?)`
    ).bind(crypto.randomUUID(), id, id, JSON.stringify({ accountType }), now)
  ];
  if (role === "tutor") {
    statements.push(env.DB.prepare(
      "INSERT INTO tutor_profiles (user_id, display_name, biography, verification_status, created_at, updated_at) VALUES (?, ?, '', 'pending', ?, ?)"
    ).bind(id, displayName, now, now));
  }
  await env.DB.batch(statements);
  return json({
    user: { id, email, displayName, role, accountType, organizationName }
  }, { status: 201 });
}

async function onboarding(request: Request, env: ApiEnvironment): Promise<Response> {
  const user = await currentUser(request, env);
  if (!user) return problem(401, "authentication_required", "Sign in to update your profile.");

  if (request.method === "GET") {
    const profile = await env.DB.prepare(
      "SELECT country_code, phone_e164 FROM account_profiles WHERE user_id = ?"
    ).bind(user.id).first<{ country_code: string | null; phone_e164: string | null }>();
    const categories = await env.DB.prepare(
      `SELECT cc.slug, cc.title, cc.description,
        EXISTS(
          SELECT 1 FROM user_interest_categories uic
          WHERE uic.user_id = ? AND uic.category_id = cc.id
        ) AS selected
       FROM course_categories cc
       WHERE cc.active = 1
       ORDER BY cc.position, cc.title`
    ).bind(user.id).all<{ slug: string; title: string; description: string; selected: number }>();
    const contacts = await env.DB.prepare(
      `SELECT id, contact_type, label, contact_value, is_primary, verified_at, created_at
       FROM user_contacts WHERE user_id = ? ORDER BY is_primary DESC, created_at`
    ).bind(user.id).all();
    return json({
      profile: {
        countryCode: profile?.country_code ?? null,
        phoneE164: profile?.phone_e164 ?? null
      },
      contacts: contacts.results,
      categories: categories.results.map((category) => ({
        slug: category.slug,
        title: category.title,
        description: category.description,
        selected: Boolean(category.selected)
      }))
    });
  }

  const input = await parseJson(request);
  const countryCode = text(input?.countryCode, 2, 2)?.toUpperCase();
  const supportedCountries = new Set([
    "SG", "MY", "ID", "PH", "TH", "VN", "BN", "KH", "IN", "CN",
    "HK", "TW", "JP", "KR", "AU", "NZ", "GB", "US", "CA", "AE"
  ]);
  if (!countryCode || !supportedCountries.has(countryCode)) {
    return problem(400, "invalid_country", "Choose a valid country or region.");
  }

  const requestedInterests = Array.isArray(input?.interestSlugs)
    ? [...new Set(input.interestSlugs.filter((value): value is string =>
        typeof value === "string" && /^[a-z0-9-]{2,60}$/.test(value)
      ))]
    : [];
  if (requestedInterests.length < 3 || requestedInterests.length > 10 ||
      (Array.isArray(input?.interestSlugs) && requestedInterests.length !== input.interestSlugs.length)) {
    return problem(400, "invalid_interests", "Choose between 3 and 10 available interests.");
  }

  const available = await env.DB.prepare(
    "SELECT id, slug FROM course_categories WHERE active = 1 ORDER BY position"
  ).all<{ id: string; slug: string }>();
  const idsBySlug = new Map(available.results.map((category) => [category.slug, category.id]));
  if (requestedInterests.some((slug) => !idsBySlug.has(slug))) {
    return problem(400, "invalid_interests", "Choose only the available interests.");
  }

  const now = new Date().toISOString();
  const statements = [
    env.DB.prepare(
      "UPDATE account_profiles SET country_code = ?, updated_at = ? WHERE user_id = ?"
    ).bind(countryCode, now, user.id),
    env.DB.prepare("DELETE FROM user_interest_categories WHERE user_id = ?").bind(user.id),
    ...requestedInterests.map((slug) => env.DB.prepare(
      "INSERT INTO user_interest_categories (user_id, category_id, created_at) VALUES (?, ?, ?)"
    ).bind(user.id, idsBySlug.get(slug), now)),
    env.DB.prepare(
      `INSERT INTO audit_logs (id, actor_user_id, action, entity_type, entity_id, metadata_json, created_at)
       VALUES (?, ?, 'preferences.updated', 'user', ?, ?, ?)`
    ).bind(crypto.randomUUID(), user.id, user.id, JSON.stringify({ countryCode, interestCount: requestedInterests.length }), now)
  ];
  await env.DB.batch(statements);
  return json({
    profile: { countryCode, interestSlugs: requestedInterests }
  });
}

async function profileLanguage(request: Request, env: ApiEnvironment): Promise<Response> {
  const user = await currentUser(request, env);
  if (!user) return problem(401, "authentication_required", "Sign in to update your language.");
  const input = await parseJson(request);
  const locale = typeof input?.locale === "string" ? input.locale : "";
  if (!["en", "zh-SG", "ms", "ta"].includes(locale)) {
    return problem(400, "invalid_locale", "Choose a supported portal language.");
  }
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare("UPDATE account_profiles SET preferred_locale = ?, updated_at = ? WHERE user_id = ?")
      .bind(locale, now, user.id),
    env.DB.prepare(
      `INSERT INTO audit_logs (id, actor_user_id, action, entity_type, entity_id, metadata_json, created_at)
       VALUES (?, ?, 'preferences.language_updated', 'user', ?, ?, ?)`
    ).bind(crypto.randomUUID(), user.id, user.id, JSON.stringify({ locale }), now)
  ]);
  return json({ locale });
}

async function profileContacts(request: Request, env: ApiEnvironment, pathname: string): Promise<Response | null> {
  if (pathname !== "/api/profile/contacts" && !/^\/api\/profile\/contacts\/[^/]+$/.test(pathname)) return null;
  const user = await currentUser(request, env);
  if (!user) return problem(401, "authentication_required", "Sign in to manage contacts.");

  if (request.method === "GET" && pathname === "/api/profile/contacts") {
    const contacts = await env.DB.prepare(
      `SELECT id, contact_type, label, contact_value, is_primary, verified_at, created_at
       FROM user_contacts WHERE user_id = ? ORDER BY is_primary DESC, created_at`
    ).bind(user.id).all();
    return json({ contacts: contacts.results });
  }

  if (request.method === "POST" && pathname === "/api/profile/contacts") {
    const input = await parseJson(request);
    const contactType = input?.contactType === "email" ? "email" : "mobile";
    const label = text(input?.label, 2, 40) ?? "Personal";
    let contactValue = "";
    if (contactType === "email") {
      contactValue = typeof input?.contactValue === "string" ? input.contactValue.trim().toLowerCase() : "";
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contactValue) || contactValue.length > 254) {
        return problem(400, "invalid_contact", "Enter a valid email address.");
      }
    } else {
      const raw = typeof input?.contactValue === "string" ? input.contactValue.trim() : "";
      const diallingCode = typeof input?.diallingCode === "string" ? input.diallingCode.trim() : "";
      contactValue = raw.startsWith("+")
        ? `+${raw.slice(1).replace(/\D/g, "")}`
        : `${diallingCode}${raw.replace(/\D/g, "").replace(/^0+/, "")}`;
      if (!/^\+[1-9]\d{7,14}$/.test(contactValue) || (!raw.startsWith("+") && !/^\+[1-9]\d{0,3}$/.test(diallingCode))) {
        return problem(400, "invalid_contact", "Enter a valid mobile number with its calling code.");
      }
    }
    const existing = await env.DB.prepare(
      "SELECT COUNT(*) AS total FROM user_contacts WHERE user_id = ? AND contact_type = ?"
    ).bind(user.id, contactType).first<{ total: number }>();
    const makePrimary = Boolean(input?.isPrimary) || Number(existing?.total ?? 0) === 0;
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const statements = [];
    if (makePrimary) statements.push(env.DB.prepare(
      "UPDATE user_contacts SET is_primary = 0, updated_at = ? WHERE user_id = ? AND contact_type = ?"
    ).bind(now, user.id, contactType));
    statements.push(env.DB.prepare(
      `INSERT INTO user_contacts
        (id, user_id, contact_type, label, contact_value, is_primary, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(id, user.id, contactType, label, contactValue, makePrimary ? 1 : 0, now, now));
    if (contactType === "mobile" && makePrimary) statements.push(env.DB.prepare(
      "UPDATE account_profiles SET phone_e164 = ?, updated_at = ? WHERE user_id = ?"
    ).bind(contactValue, now, user.id));
    try {
      await env.DB.batch(statements);
    } catch {
      return problem(409, "contact_exists", "This contact is already saved.");
    }
    return json({ contact: { id, contactType, label, contactValue, isPrimary: makePrimary } }, { status: 201 });
  }

  const contactId = decodeURIComponent(pathname.split("/").pop() ?? "");
  if (request.method === "DELETE" && contactId) {
    const contact = await env.DB.prepare(
      "SELECT id, contact_type, is_primary FROM user_contacts WHERE id = ? AND user_id = ?"
    ).bind(contactId, user.id).first<{ id: string; contact_type: string; is_primary: number }>();
    if (!contact) return problem(404, "contact_not_found", "Contact not found.");
    await env.DB.prepare("DELETE FROM user_contacts WHERE id = ? AND user_id = ?").bind(contactId, user.id).run();
    if (contact.is_primary) {
      const replacement = await env.DB.prepare(
        "SELECT id, contact_value FROM user_contacts WHERE user_id = ? AND contact_type = ? ORDER BY created_at LIMIT 1"
      ).bind(user.id, contact.contact_type).first<{ id: string; contact_value: string }>();
      if (replacement) await env.DB.prepare("UPDATE user_contacts SET is_primary = 1, updated_at = ? WHERE id = ?")
        .bind(new Date().toISOString(), replacement.id).run();
      if (contact.contact_type === "mobile") await env.DB.prepare(
        "UPDATE account_profiles SET phone_e164 = ?, updated_at = ? WHERE user_id = ?"
      ).bind(replacement?.contact_value ?? null, new Date().toISOString(), user.id).run();
    }
    return json({ deleted: true });
  }
  return problem(405, "method_not_allowed", "Method not allowed.");
}

type ConnectionRow = {
  id: string;
  requester_user_id: string;
  status: "pending" | "accepted" | "declined" | "blocked";
  user_low_id: string;
  user_high_id: string;
  low_shares_progress: number;
  high_shares_progress: number;
  other_user_id: string;
  other_display_name: string;
  other_email: string;
  other_avatar_asset_id: string | null;
  blocker_user_id: string | null;
  created_at: string;
  accepted_at: string | null;
};

async function connections(
  request: Request,
  env: ApiEnvironment,
  pathname: string
): Promise<Response | null> {
  if (pathname !== "/api/connections" && !pathname.startsWith("/api/connections/")) return null;
  const actor = await currentUser(request, env);
  if (!actor) return problem(401, "authentication_required", "Sign in to manage connections.");

  if (request.method === "GET" && pathname === "/api/connections") {
    const result = await env.DB.prepare(
      `SELECT uc.id, uc.requester_user_id, uc.status, uc.user_low_id, uc.user_high_id,
        uc.low_shares_progress, uc.high_shares_progress, uc.blocker_user_id, uc.created_at, uc.accepted_at,
        u.id AS other_user_id, u.display_name AS other_display_name, u.email AS other_email,
        u.avatar_asset_id AS other_avatar_asset_id
       FROM user_connections uc
       JOIN users u ON u.id = CASE WHEN uc.user_low_id = ? THEN uc.user_high_id ELSE uc.user_low_id END
       WHERE (uc.user_low_id = ? OR uc.user_high_id = ?) AND uc.status != 'declined'
       ORDER BY CASE uc.status WHEN 'pending' THEN 0 WHEN 'accepted' THEN 1 ELSE 2 END, uc.updated_at DESC`
    ).bind(actor.id, actor.id, actor.id).all<ConnectionRow>();

    const items = [];
    for (const connection of result.results) {
      const actorIsLow = connection.user_low_id === actor.id;
      const sharesMyProgress = Boolean(actorIsLow
        ? connection.low_shares_progress
        : connection.high_shares_progress);
      const canViewTheirProgress = Boolean(actorIsLow
        ? connection.high_shares_progress
        : connection.low_shares_progress);
      let progress: unknown[] = [];
      if (connection.status === "accepted") {
        if (canViewTheirProgress) {
          progress = (await env.DB.prepare(
            `SELECT c.id AS course_id, c.title,
              ROUND(COALESCE(AVG(pr.progress_percent), 0)) AS progress_percent
             FROM enrolments e JOIN courses c ON c.id = e.course_id
             LEFT JOIN progress_records pr ON pr.enrolment_id = e.id
             WHERE e.student_user_id = ? AND e.status = 'active'
             GROUP BY e.id, c.id ORDER BY e.enrolled_at DESC LIMIT 12`
          ).bind(connection.other_user_id).all()).results;
        }
      }
      items.push({
        id: connection.id,
        status: connection.status,
        incoming: connection.status === "pending" && connection.requester_user_id !== actor.id,
        other: {
          id: connection.other_user_id,
          displayName: connection.other_display_name,
          email: connection.other_email,
          avatarAssetId: connection.other_avatar_asset_id
        },
        sharesMyProgress,
        canViewTheirProgress,
        blockedByMe: connection.status === "blocked" && connection.blocker_user_id === actor.id,
        progress,
        createdAt: connection.created_at,
        acceptedAt: connection.accepted_at
      });
    }
    return json({ connections: items });
  }

  if (request.method !== "POST") return problem(405, "method_not_allowed", "Method not allowed.");
  const input = await parseJson(request);

  if (pathname === "/api/connections") {
    const email = text(input?.email, 5, 254)?.toLowerCase();
    const pendingCount = await env.DB.prepare(
      "SELECT COUNT(*) AS total FROM user_connections WHERE requester_user_id = ? AND status = 'pending'"
    ).bind(actor.id).first<{ total: number }>();
    if (Number(pendingCount?.total ?? 0) >= 50) {
      return problem(429, "connection_limit", "Resolve existing connection requests before sending more.");
    }
    const other = email ? await env.DB.prepare(
      "SELECT id FROM users WHERE LOWER(email) = ? AND status = 'active'"
    ).bind(email).first<{ id: string }>() : null;
    if (!other || other.id === actor.id) {
      return problem(400, "connection_unavailable", "A connection request could not be sent to that account.");
    }
    const [low, high] = actor.id < other.id ? [actor.id, other.id] : [other.id, actor.id];
    const existing = await env.DB.prepare(
      "SELECT id, status FROM user_connections WHERE user_low_id = ? AND user_high_id = ?"
    ).bind(low, high).first<{ id: string; status: string }>();
    if (existing) {
      if (existing.status !== "declined") {
        return problem(409, "connection_exists", "A connection with this user already exists.");
      }
      const now = new Date().toISOString();
      await env.DB.prepare(
        `UPDATE user_connections SET requester_user_id = ?, status = 'pending',
          low_shares_progress = 0, high_shares_progress = 0, blocker_user_id = NULL,
          accepted_at = NULL, updated_at = ? WHERE id = ?`
      ).bind(actor.id, now, existing.id).run();
      return json({ connection: { id: existing.id, status: "pending" } }, { status: 201 });
    }
    try {
      const id = crypto.randomUUID();
      const now = new Date().toISOString();
      await env.DB.prepare(
        `INSERT INTO user_connections
          (id, user_low_id, user_high_id, requester_user_id, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'pending', ?, ?)`
      ).bind(id, low, high, actor.id, now, now).run();
      return json({ connection: { id, status: "pending" } }, { status: 201 });
    } catch {
      return problem(409, "connection_exists", "A connection with this user already exists.");
    }
  }

  const actionMatch = pathname.match(/^\/api\/connections\/([^/]+)\/(accept|sharing|message|block|unblock)$/);
  if (!actionMatch) return problem(404, "not_found", "Connection action not found.");
  const connectionId = decodeURIComponent(actionMatch[1]);
  const action = actionMatch[2];
  const connection = await env.DB.prepare(
    `SELECT id, user_low_id, user_high_id, requester_user_id, status, blocker_user_id
     FROM user_connections WHERE id = ? AND (user_low_id = ? OR user_high_id = ?)`
  ).bind(connectionId, actor.id, actor.id).first<{
    id: string; user_low_id: string; user_high_id: string;
    requester_user_id: string; status: string; blocker_user_id: string | null;
  }>();
  if (!connection) return problem(404, "connection_not_found", "This connection does not exist.");
  const actorShareColumn = connection.user_low_id === actor.id
    ? "low_shares_progress"
    : "high_shares_progress";
  const now = new Date().toISOString();

  if (action === "accept") {
    if (connection.status !== "pending" || connection.requester_user_id === actor.id) {
      return problem(409, "connection_not_pending", "This connection request cannot be accepted.");
    }
    const shareProgress = input?.shareProgress === true ? 1 : 0;
    await env.DB.prepare(
      `UPDATE user_connections SET status = 'accepted', accepted_at = ?, updated_at = ?,
        ${actorShareColumn} = ? WHERE id = ?`
    ).bind(now, now, shareProgress, connectionId).run();
    return json({ connection: { id: connectionId, status: "accepted" } });
  }

  if (action === "block") {
    await env.DB.prepare(
      "UPDATE user_connections SET status = 'blocked', blocker_user_id = ?, updated_at = ? WHERE id = ?"
    ).bind(actor.id, now, connectionId).run();
    return json({ connection: { id: connectionId, status: "blocked" } });
  }

  if (action === "unblock") {
    if (connection.status !== "blocked" || connection.blocker_user_id !== actor.id) {
      return problem(403, "unblock_forbidden", "Only the person who blocked this connection can unblock it.");
    }
    await env.DB.prepare(
      `UPDATE user_connections SET status = 'declined', blocker_user_id = NULL,
        low_shares_progress = 0, high_shares_progress = 0, accepted_at = NULL, updated_at = ?
       WHERE id = ?`
    ).bind(now, connectionId).run();
    return json({ connection: { id: connectionId, status: "removed" } });
  }

  if (connection.status !== "accepted") {
    return problem(409, "connection_not_accepted", "Accept the connection before using this feature.");
  }
  if (action === "sharing") {
    const shareProgress = input?.shareProgress === true ? 1 : 0;
    await env.DB.prepare(
      `UPDATE user_connections SET ${actorShareColumn} = ?, updated_at = ? WHERE id = ?`
    ).bind(shareProgress, now, connectionId).run();
    return json({ connection: { id: connectionId, sharesMyProgress: Boolean(shareProgress) } });
  }
  const body = text(input?.body, 1, 2000);
  if (!body) return problem(400, "message_required", "Write a message before sending.");
  const id = crypto.randomUUID();
  await env.DB.prepare(
    "INSERT INTO connection_messages (id, connection_id, sender_user_id, body, created_at) VALUES (?, ?, ?, ?, ?)"
  ).bind(id, connectionId, actor.id, body, now).run();
  return json({ message: { id, connectionId, body, createdAt: now } }, { status: 201 });
}

async function login(request: Request, env: ApiEnvironment): Promise<Response> {
  const input = await parseJson(request);
  const email = text(input?.email, 5, 254)?.toLowerCase();
  const password = text(input?.password, 1, 128);
  if (!email || !password) return problem(400, "invalid_login", "Email and password are required.");

  const account = await env.DB.prepare(
    `SELECT u.id, u.email, u.display_name, u.role, u.status,
      COALESCE(ap.account_type, 'individual') AS account_type, ap.organization_name,
      c.password_hash, c.password_salt, c.password_iterations
     FROM users u JOIN user_credentials c ON c.user_id = u.id
     LEFT JOIN account_profiles ap ON ap.user_id = u.id WHERE u.email = ?`
  ).bind(email).first<UserRow & {
    password_hash: string;
    password_salt: string;
    password_iterations: number;
  }>();
  if (!account || account.status !== "active") {
    return problem(401, "invalid_credentials", "Email or password is incorrect.");
  }
  const candidate = await derivePassword(password, decodeBase64(account.password_salt), account.password_iterations);
  if (!constantTimeEqual(candidate, account.password_hash)) {
    return problem(401, "invalid_credentials", "Email or password is incorrect.");
  }
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare("UPDATE user_credentials SET last_login_at = ? WHERE user_id = ?").bind(now, account.id),
    env.DB.prepare(
      `INSERT INTO audit_logs (id, actor_user_id, action, entity_type, entity_id, metadata_json, created_at)
       VALUES (?, ?, 'auth.credentials_verified', 'user', ?, '{}', ?)`
    ).bind(crypto.randomUUID(), account.id, account.id, now)
  ]);
  return json({ user: {
    id: account.id,
    email: account.email,
    displayName: account.display_name,
    role: account.role,
    accountType: account.account_type,
    organizationName: account.organization_name
  } });
}

async function me(request: Request, env: ApiEnvironment): Promise<Response> {
  const user = await currentUser(request, env);
  return user
    ? json({ user: {
        id: user.id, email: user.email, displayName: user.display_name, role: user.role,
        accountType: user.account_type, organizationName: user.organization_name
      } })
    : problem(401, "authentication_required", "Sign in to continue.");
}

async function parentStudents(request: Request, env: ApiEnvironment): Promise<Response> {
  const parent = await currentUser(request, env);
  if (!parent || parent.account_type !== "individual") {
    return problem(403, "individual_required", "An Individual account is required to manage learners.");
  }
  if (request.method === "GET") {
    const result = await env.DB.prepare(
      `SELECT u.id, u.display_name, sp.primary_level
       FROM parent_student_relationships ps
       JOIN users u ON u.id = ps.student_user_id
       LEFT JOIN student_profiles sp ON sp.user_id = u.id
       WHERE ps.parent_user_id = ? AND u.status = 'active'
       ORDER BY u.display_name`
    ).bind(parent.id).all<{ id: string; display_name: string; primary_level: string | null }>();
    return json({ students: result.results.map((student) => ({
      id: student.id,
      displayName: student.display_name,
      primaryLevel: student.primary_level
    })) });
  }

  const input = await parseJson(request);
  const displayName = text(input?.displayName, 2, 80);
  const primaryLevel = text(input?.primaryLevel, 2, 40);
  if (!displayName || !primaryLevel) {
    return problem(400, "invalid_student", "Student name and primary level are required.");
  }
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO users (id, email, display_name, role, status, created_at, updated_at) VALUES (?, ?, ?, 'student', 'active', ?, ?)"
    ).bind(id, `${id}@student.pencilscope.invalid`, displayName, now, now),
    env.DB.prepare(
      "INSERT INTO student_profiles (user_id, primary_level, managed_by_parent, created_at, updated_at) VALUES (?, ?, 1, ?, ?)"
    ).bind(id, primaryLevel, now, now),
    env.DB.prepare(
      `INSERT INTO account_profiles
        (user_id, account_type, organization_name, created_at, updated_at)
       VALUES (?, 'individual', NULL, ?, ?)`
    ).bind(id, now, now),
    env.DB.prepare(
      "INSERT INTO parent_student_relationships (parent_user_id, student_user_id, relationship, permissions_json, created_at) VALUES (?, ?, 'guardian', ?, ?)"
    ).bind(parent.id, id, '{"purchase":true,"progress":true}', now)
  ]);
  return json({ student: { id, displayName, primaryLevel } }, { status: 201 });
}

async function permittedStudent(
  request: Request,
  env: ApiEnvironment,
  requestedStudentId?: string | null
): Promise<{ actor: UserRow; studentId: string } | Response> {
  const actor = await currentUser(request, env);
  if (!actor) return problem(401, "authentication_required", "Sign in to continue.");
  if (!requestedStudentId || requestedStudentId === actor.id || actor.role === "student") {
    return { actor, studentId: actor.id };
  }
  const relationship = await env.DB.prepare(
    "SELECT 1 FROM parent_student_relationships WHERE parent_user_id = ? AND student_user_id = ?"
  ).bind(actor.id, requestedStudentId).first();
  return relationship
    ? { actor, studentId: requestedStudentId }
    : problem(403, "student_forbidden", "This student is not linked to your account.");
}

async function dashboard(request: Request, env: ApiEnvironment): Promise<Response> {
  const actor = await currentUser(request, env);
  if (!actor) return problem(401, "authentication_required", "Sign in to continue.");

  const creatorCourses = await env.DB.prepare(
      `SELECT c.id, c.slug, c.title, c.status, c.pricing_status, c.listing_status, c.content_version,
        COUNT(eo.id) AS enrolment_count
       FROM courses c LEFT JOIN course_offerings o ON o.course_id = c.id
       LEFT JOIN enrolment_offerings eo ON eo.course_offering_id = o.id
       WHERE c.tutor_id = ? OR ? = 'admin'
         OR EXISTS (SELECT 1 FROM course_members cm WHERE cm.course_id = c.id AND cm.user_id = ? AND cm.status = 'active')
       GROUP BY c.id ORDER BY c.updated_at DESC`
    ).bind(actor.id, actor.role, actor.id).all();

  const students = actor.account_type === "individual" && actor.role !== "student"
    ? (await env.DB.prepare(
        `SELECT u.id, u.display_name, sp.primary_level
         FROM parent_student_relationships ps JOIN users u ON u.id = ps.student_user_id
         LEFT JOIN student_profiles sp ON sp.user_id = u.id
         WHERE ps.parent_user_id = ? ORDER BY u.display_name`
      ).bind(actor.id).all()).results
    : [];
  const studentIds = [actor.id, ...students.map((student) => String(student.id))];
  let enrolments: unknown[] = [];
  if (studentIds.length) {
    const placeholders = studentIds.map(() => "?").join(",");
    enrolments = (await env.DB.prepare(
      `SELECT e.id, e.student_user_id, e.course_id, eo.status, eo.enrolled_at, eo.order_id,
        eo.course_offering_id, o.title AS offering_title,
        t.academic_year, t.term_number, c.title, c.slug, c.subject,
        COALESCE(AVG(pr.progress_percent), 0) AS progress_percent
       FROM enrolments e JOIN courses c ON c.id = e.course_id
       JOIN enrolment_offerings eo ON eo.enrolment_id = e.id
       JOIN course_offerings o ON o.id = eo.course_offering_id
       JOIN academic_terms t ON t.id = o.academic_term_id
       LEFT JOIN progress_records pr ON pr.enrolment_id = e.id
       WHERE e.student_user_id IN (${placeholders})
         AND NOT EXISTS (SELECT 1 FROM product_offers po WHERE po.commerce_course_id = e.course_id)
       GROUP BY eo.id ORDER BY eo.enrolled_at DESC`
    ).bind(...studentIds).all()).results;
  }
  return json({
    user: actor,
    selfLearner: { id: actor.id, display_name: actor.display_name, primary_level: null },
    students,
    enrolments,
    creatorCourses: creatorCourses.results,
    tutorCourses: creatorCourses.results
  });
}

async function activeEnrolment(
  env: ApiEnvironment,
  studentId: string,
  courseId: string
): Promise<{ id: string } | null> {
  return env.DB.prepare(
    "SELECT id FROM enrolments WHERE student_user_id = ? AND course_id = ? AND status = 'active'"
  ).bind(studentId, courseId).first<{ id: string }>();
}

async function hasAssessmentAccess(
  env: ApiEnvironment,
  studentId: string,
  assessmentId: string
): Promise<{ id: string } | null> {
  return env.DB.prepare(
    `SELECT e.id FROM enrolments e
     JOIN enrolment_offerings eo ON eo.enrolment_id = e.id
     JOIN course_offerings o ON o.id = eo.course_offering_id
     JOIN course_offering_assessments oa ON oa.course_offering_id = o.id
     WHERE e.student_user_id = ? AND oa.assessment_id = ?
       AND e.status = 'active' AND eo.status = 'active'
       AND (o.access_ends_at IS NULL OR o.access_ends_at >= ?)
     LIMIT 1`
  ).bind(studentId, assessmentId, new Date().toISOString()).first<{ id: string }>();
}

async function hasDeckAccess(
  env: ApiEnvironment,
  studentId: string,
  deckId: string
): Promise<boolean> {
  return Boolean(await env.DB.prepare(
    `SELECT 1 FROM enrolment_offerings eo
     JOIN course_offerings o ON o.id = eo.course_offering_id
     JOIN course_offering_flashcard_decks od ON od.course_offering_id = o.id
     WHERE eo.student_user_id = ? AND od.deck_id = ? AND eo.status = 'active'
       AND (o.access_ends_at IS NULL OR o.access_ends_at >= ?) LIMIT 1`
  ).bind(studentId, deckId, new Date().toISOString()).first());
}

async function courseLearning(request: Request, env: ApiEnvironment, courseId: string): Promise<Response> {
  const student = new URL(request.url).searchParams.get("studentId");
  const permitted = await permittedStudent(request, env, student);
  if (permitted instanceof Response) return permitted;
  const enrolment = await activeEnrolment(env, permitted.studentId, courseId);
  if (!enrolment) return problem(403, "enrolment_required", "An active enrolment is required.");
  const offeringAccess = await env.DB.prepare(
    `SELECT o.id, o.title, o.access_ends_at, o.offering_type, o.delivery_mode,
      o.starts_at, o.ends_at, o.timezone, t.academic_year, t.term_number
     FROM enrolment_offerings eo JOIN course_offerings o ON o.id = eo.course_offering_id
     JOIN academic_terms t ON t.id = o.academic_term_id
     WHERE eo.enrolment_id = ? AND eo.status = 'active'
       AND (o.access_ends_at IS NULL OR o.access_ends_at >= ?)
     ORDER BY COALESCE(o.starts_at, t.starts_at, o.created_at), o.title`
  ).bind(enrolment.id, new Date().toISOString()).all();
  if (!offeringAccess.results.length) {
    return problem(403, "offering_enrolment_required", "An active course-offering enrolment is required.");
  }

  const course = await env.DB.prepare(
    "SELECT id, slug, title, description, subject, primary_level, delivery_mode FROM courses WHERE id = ?"
  ).bind(courseId).first();
  if (!course) return problem(404, "course_not_found", "The course does not exist.");
  const modules = await env.DB.prepare(
    `SELECT DISTINCT m.id, m.title, om.position FROM course_modules m
     JOIN course_offering_modules om ON om.module_id = m.id
     JOIN enrolment_offerings eo ON eo.course_offering_id = om.course_offering_id
     JOIN course_offerings o ON o.id = eo.course_offering_id
     WHERE m.course_id = ? AND eo.enrolment_id = ? AND eo.status = 'active'
       AND (o.access_ends_at IS NULL OR o.access_ends_at >= ?)
     ORDER BY om.position`
  ).bind(courseId, enrolment.id, new Date().toISOString()).all();
  const lessons = await env.DB.prepare(
    `SELECT l.id, l.module_id, l.title, l.lesson_type, l.delivery_mode,
      l.course_session_id, l.content_json, l.position,
      l.estimated_minutes,
      (SELECT '/api/creator/content-library/items/' || rl.item_id || '/content'
       FROM creator_library_resource_links rl
       WHERE rl.entity_type = 'lesson' AND rl.entity_id = l.id
         AND rl.resource_role = 'lesson_media'
       ORDER BY rl.position LIMIT 1) AS library_media_url,
      COALESCE(pr.status, 'not-started') AS progress_status,
      COALESCE(pr.progress_percent, 0) AS progress_percent
     FROM lessons l JOIN course_modules m ON m.id = l.module_id
     JOIN course_offering_modules om ON om.module_id = m.id
     JOIN enrolment_offerings eo ON eo.course_offering_id = om.course_offering_id
     JOIN course_offerings o ON o.id = eo.course_offering_id
     LEFT JOIN progress_records pr ON pr.lesson_id = l.id AND pr.enrolment_id = ?
     WHERE m.course_id = ? AND eo.enrolment_id = ? AND eo.status = 'active'
       AND (o.access_ends_at IS NULL OR o.access_ends_at >= ?)
     GROUP BY l.id ORDER BY om.position, l.position`
  ).bind(enrolment.id, courseId, enrolment.id, new Date().toISOString()).all();
  const assessments = await env.DB.prepare(
    `SELECT a.id, a.lesson_id, a.assessment_type, a.title, a.time_limit_seconds,
      a.attempt_limit, a.passing_score FROM assessments a
     JOIN course_offering_assessments oa ON oa.assessment_id = a.id
     JOIN enrolment_offerings eo ON eo.course_offering_id = oa.course_offering_id
     JOIN course_offerings o ON o.id = eo.course_offering_id
     WHERE a.course_id = ? AND a.status = 'published' AND eo.enrolment_id = ?
       AND eo.status = 'active' AND (o.access_ends_at IS NULL OR o.access_ends_at >= ?)
     GROUP BY a.id ORDER BY oa.position`
  ).bind(courseId, enrolment.id, new Date().toISOString()).all();
  const decks = await env.DB.prepare(
    `SELECT d.id, d.lesson_id, d.title, d.description FROM flashcard_decks d
     JOIN course_offering_flashcard_decks od ON od.deck_id = d.id
     JOIN enrolment_offerings eo ON eo.course_offering_id = od.course_offering_id
     JOIN course_offerings o ON o.id = eo.course_offering_id
     WHERE d.course_id = ? AND d.status = 'published' AND eo.enrolment_id = ?
       AND eo.status = 'active' AND (o.access_ends_at IS NULL OR o.access_ends_at >= ?)
     GROUP BY d.id ORDER BY od.position`
  ).bind(courseId, enrolment.id, new Date().toISOString()).all();
  const materials = await env.DB.prepare(
    `SELECT m.id, m.title, m.description, m.material_type, m.resource_kind, m.content_kind FROM course_materials m
     JOIN course_offering_materials om ON om.material_id = m.id
     JOIN enrolment_offerings eo ON eo.course_offering_id = om.course_offering_id
     JOIN course_offerings o ON o.id = eo.course_offering_id
     WHERE m.course_id = ? AND m.status = 'published' AND eo.enrolment_id = ?
       AND eo.status = 'active' AND (o.access_ends_at IS NULL OR o.access_ends_at >= ?)
     GROUP BY m.id ORDER BY om.position`
  ).bind(courseId, enrolment.id, new Date().toISOString()).all();
  const learningProducts = await env.DB.prepare(
    `SELECT DISTINCT p.id, p.slug, p.title, p.description, p.product_type,
      p.estimated_minutes, p.price_cents, p.currency, olp.position,
      COALESCE(NULLIF(u.display_name, ''), 'PencilScope creator') AS creator_name
     FROM learning_products p
     JOIN users u ON u.id = p.creator_id
     JOIN course_offering_learning_products olp ON olp.learning_product_id = p.id
     JOIN enrolment_offerings eo ON eo.course_offering_id = olp.course_offering_id
     JOIN course_offerings o ON o.id = eo.course_offering_id
     WHERE p.status = 'published' AND eo.enrolment_id = ? AND eo.status = 'active'
       AND (olp.release_at IS NULL OR olp.release_at <= ?)
       AND (o.access_ends_at IS NULL OR o.access_ends_at >= ?)
     ORDER BY olp.position, p.title`
  ).bind(enrolment.id, new Date().toISOString(), new Date().toISOString()).all();
  const sessions = await env.DB.prepare(
    `SELECT s.id, s.course_offering_id, s.title, s.delivery_mode, s.starts_at, s.ends_at,
      s.timezone, s.capacity, s.meeting_url, s.meeting_provider,
      v.name AS venue_name, v.address_line_1, v.address_line_2, v.city, v.postal_code,
      v.arrival_instructions
     FROM course_sessions s JOIN enrolment_offerings eo ON eo.course_offering_id = s.course_offering_id
     LEFT JOIN venues v ON v.id = s.venue_id
     WHERE eo.enrolment_id = ? AND eo.status = 'active' AND s.status = 'scheduled'
     ORDER BY s.starts_at`
  ).bind(enrolment.id).all();
  return json({
    course,
    enrolment,
    offerings: offeringAccess.results,
    modules: modules.results,
    lessons: lessons.results,
    assessments: assessments.results,
    flashcardDecks: decks.results,
    materials: materials.results,
    learningProducts: learningProducts.results,
    sessions: sessions.results
  });
}

async function updateProgress(request: Request, env: ApiEnvironment, lessonId: string): Promise<Response> {
  const input = await parseJson(request);
  const requestedStudentId = typeof input?.studentId === "string" ? input.studentId : null;
  const permitted = await permittedStudent(request, env, requestedStudentId);
  if (permitted instanceof Response) return permitted;
  const lesson = await env.DB.prepare(
    "SELECT m.course_id FROM lessons l JOIN course_modules m ON m.id = l.module_id WHERE l.id = ?"
  ).bind(lessonId).first<{ course_id: string }>();
  if (!lesson) return problem(404, "lesson_not_found", "The lesson does not exist.");
  const enrolment = await activeEnrolment(env, permitted.studentId, lesson.course_id);
  if (!enrolment) return problem(403, "enrolment_required", "An active enrolment is required.");
  const lessonAccess = await env.DB.prepare(
    `SELECT 1 FROM lessons l JOIN course_offering_modules om ON om.module_id = l.module_id
     JOIN enrolment_offerings eo ON eo.course_offering_id = om.course_offering_id
     JOIN course_offerings o ON o.id = eo.course_offering_id
     WHERE l.id = ? AND eo.enrolment_id = ? AND eo.status = 'active'
       AND (o.access_ends_at IS NULL OR o.access_ends_at >= ?) LIMIT 1`
  ).bind(lessonId, enrolment.id, new Date().toISOString()).first();
  if (!lessonAccess) return problem(403, "lesson_forbidden", "This lesson is not included in the purchased term.");
  const percent = Math.max(0, Math.min(100, Number(input?.progressPercent ?? 0)));
  const status = percent >= 100 ? "completed" : percent > 0 ? "started" : "not-started";
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO progress_records
      (id, enrolment_id, lesson_id, status, progress_percent, started_at, completed_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(enrolment_id, lesson_id) DO UPDATE SET
      status = excluded.status, progress_percent = excluded.progress_percent,
      started_at = COALESCE(progress_records.started_at, excluded.started_at),
      completed_at = excluded.completed_at, updated_at = excluded.updated_at`
  ).bind(
    crypto.randomUUID(), enrolment.id, lessonId, status, percent,
    percent > 0 ? now : null, percent >= 100 ? now : null, now
  ).run();
  return json({ progress: { lessonId, status, progressPercent: percent } });
}

async function assessmentDetails(request: Request, env: ApiEnvironment, assessmentId: string): Promise<Response> {
  const studentId = new URL(request.url).searchParams.get("studentId");
  const permitted = await permittedStudent(request, env, studentId);
  if (permitted instanceof Response) return permitted;
  const assessment = await env.DB.prepare(
    `SELECT id, course_id, assessment_type, title, instructions, time_limit_seconds,
      attempt_limit, passing_score, feedback_mode, version
     FROM assessments WHERE id = ? AND status = 'published'`
  ).bind(assessmentId).first<{
    id: string;
    course_id: string;
    assessment_type: string;
    title: string;
    instructions: string;
    time_limit_seconds: number | null;
    attempt_limit: number | null;
    passing_score: number;
    feedback_mode: string;
    version: number;
  }>();
  if (!assessment) return problem(404, "assessment_not_found", "The assessment does not exist.");
  const enrolment = await hasAssessmentAccess(env, permitted.studentId, assessment.id);
  if (!enrolment) return problem(403, "enrolment_required", "An active enrolment is required.");
  const [questions, options, media] = await Promise.all([
    env.DB.prepare(
      "SELECT id, question_type, prompt, points, position FROM assessment_questions WHERE assessment_id = ? ORDER BY position"
    ).bind(assessmentId).all(),
    env.DB.prepare(
      `SELECT o.id, o.question_id, o.label, o.position FROM assessment_options o
       JOIN assessment_questions q ON q.id = o.question_id
       WHERE q.assessment_id = ? ORDER BY q.position, o.position`
    ).bind(assessmentId).all(),
    env.DB.prepare(
      `SELECT m.course_question_id AS question_id, m.media_type, m.alt_text, m.caption
       FROM assessment_question_media m JOIN assessment_questions q ON q.id = m.course_question_id
       WHERE q.assessment_id = ?`
    ).bind(assessmentId).all<{ question_id: string; media_type: string; alt_text: string; caption: string }>()
  ]);
  return json({
    assessment,
    questions: questions.results.map((question) => {
      const attached = media.results.find((entry) => entry.question_id === String(question.id));
      return attached ? {
        ...question,
        media: {
          mediaType: attached.media_type,
          altText: attached.alt_text,
          caption: attached.caption,
          contentUrl: `/api/assessments/${encodeURIComponent(assessmentId)}/questions/${encodeURIComponent(String(question.id))}/media`
        }
      } : question;
    }),
    options: options.results
  });
}

async function assessmentQuestionMedia(
  request: Request,
  env: ApiEnvironment,
  assessmentId: string,
  questionId: string
): Promise<Response> {
  const studentId = new URL(request.url).searchParams.get("studentId");
  const permitted = await permittedStudent(request, env, studentId);
  if (permitted instanceof Response) return permitted;
  if (!await hasAssessmentAccess(env, permitted.studentId, assessmentId)) {
    return problem(403, "enrolment_required", "An active enrolment is required.");
  }
  const media = await env.DB.prepare(
    `SELECT m.asset_version_id FROM assessment_question_media m
     JOIN assessment_questions q ON q.id = m.course_question_id
     JOIN assessments a ON a.id = q.assessment_id
     WHERE a.id = ? AND a.status = 'published' AND q.id = ?`
  ).bind(assessmentId, questionId).first<{ asset_version_id: string }>();
  return media
    ? serveQuestionMediaVersion(env, media.asset_version_id)
    : problem(404, "question_media_not_found", "This question does not have media.");
}

async function startAttempt(request: Request, env: ApiEnvironment, assessmentId: string): Promise<Response> {
  const input = await parseJson(request);
  const studentId = typeof input?.studentId === "string" ? input.studentId : null;
  const permitted = await permittedStudent(request, env, studentId);
  if (permitted instanceof Response) return permitted;
  const now = new Date();
  const assessment = await env.DB.prepare(
    `SELECT id, course_id, version, time_limit_seconds, attempt_limit
     FROM assessments WHERE id = ? AND status = 'published'
       AND (available_from IS NULL OR available_from <= ?)
       AND (available_until IS NULL OR available_until >= ?)`
  ).bind(assessmentId, now.toISOString(), now.toISOString()).first<{
    id: string;
    course_id: string;
    version: number;
    time_limit_seconds: number | null;
    attempt_limit: number | null;
  }>();
  if (!assessment) return problem(404, "assessment_unavailable", "The assessment is not available.");
  const enrolment = await hasAssessmentAccess(env, permitted.studentId, assessment.id);
  if (!enrolment) return problem(403, "enrolment_required", "An active enrolment is required.");
  const attemptCount = await env.DB.prepare(
    "SELECT COUNT(*) AS count FROM assessment_attempts WHERE assessment_id = ? AND student_user_id = ?"
  ).bind(assessmentId, permitted.studentId).first<{ count: number }>();
  if (assessment.attempt_limit && Number(attemptCount?.count ?? 0) >= assessment.attempt_limit) {
    return problem(409, "attempt_limit_reached", "No assessment attempts remain.");
  }
  const id = crypto.randomUUID();
  const expiresAt = assessment.time_limit_seconds
    ? new Date(now.getTime() + assessment.time_limit_seconds * 1000).toISOString()
    : null;
  await env.DB.prepare(
    `INSERT INTO assessment_attempts
      (id, assessment_id, assessment_version, enrolment_id, student_user_id, status, started_at, expires_at)
     VALUES (?, ?, ?, ?, ?, 'in_progress', ?, ?)`
  ).bind(id, assessment.id, assessment.version, enrolment.id, permitted.studentId, now.toISOString(), expiresAt).run();
  return json({
    attempt: { id, assessmentId, status: "in_progress", startedAt: now.toISOString(), expiresAt }
  }, { status: 201 });
}

async function attemptOwner(
  request: Request,
  env: ApiEnvironment,
  attemptId: string
): Promise<{ attempt: { student_user_id: string; status: string; expires_at: string | null }; actor: UserRow } | Response> {
  const actor = await currentUser(request, env);
  if (!actor) return problem(401, "authentication_required", "Sign in to continue.");
  const attempt = await env.DB.prepare(
    "SELECT student_user_id, status, expires_at FROM assessment_attempts WHERE id = ?"
  ).bind(attemptId).first<{ student_user_id: string; status: string; expires_at: string | null }>();
  if (!attempt) return problem(404, "attempt_not_found", "The assessment attempt does not exist.");
  const parentAccess = actor.role === "parent" && await env.DB.prepare(
    "SELECT 1 FROM parent_student_relationships WHERE parent_user_id = ? AND student_user_id = ?"
  ).bind(actor.id, attempt.student_user_id).first();
  if (actor.id !== attempt.student_user_id && !parentAccess) {
    return problem(403, "attempt_forbidden", "You cannot access this attempt.");
  }
  return { attempt, actor };
}

async function saveResponse(
  request: Request,
  env: ApiEnvironment,
  attemptId: string,
  questionId: string
): Promise<Response> {
  const ownership = await attemptOwner(request, env, attemptId);
  if (ownership instanceof Response) return ownership;
  const { attempt } = ownership;
  if (attempt.status !== "in_progress") {
    return problem(409, "attempt_not_active", "This assessment attempt is not active.");
  }
  if (attempt.expires_at && attempt.expires_at < new Date().toISOString()) {
    await env.DB.prepare("UPDATE assessment_attempts SET status = 'expired' WHERE id = ?").bind(attemptId).run();
    return problem(409, "attempt_expired", "The assessment time has expired.");
  }
  const input = await parseJson(request);
  const question = await env.DB.prepare(
    `SELECT q.id FROM assessment_questions q
     JOIN assessment_attempts aa ON aa.assessment_id = q.assessment_id
     WHERE aa.id = ? AND q.id = ?`
  ).bind(attemptId, questionId).first();
  if (!question) return problem(404, "question_not_found", "The question does not belong to this attempt.");
  const selectedOptionId = typeof input?.selectedOptionId === "string" ? input.selectedOptionId : null;
  const textResponse = typeof input?.textResponse === "string" ? input.textResponse.slice(0, 5000) : null;
  if (!selectedOptionId && !textResponse) return problem(400, "response_required", "Provide an answer.");
  if (selectedOptionId) {
    const option = await env.DB.prepare(
      "SELECT 1 FROM assessment_options WHERE id = ? AND question_id = ?"
    ).bind(selectedOptionId, questionId).first();
    if (!option) return problem(400, "invalid_option", "Choose a valid answer option.");
  }
  await env.DB.prepare(
    `INSERT INTO assessment_responses
      (attempt_id, question_id, selected_option_id, text_response, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(attempt_id, question_id) DO UPDATE SET
      selected_option_id = excluded.selected_option_id,
      text_response = excluded.text_response,
      awarded_points = NULL, is_correct = NULL, updated_at = excluded.updated_at`
  ).bind(attemptId, questionId, selectedOptionId, textResponse, new Date().toISOString()).run();
  return json({ saved: true });
}

async function submitAttempt(request: Request, env: ApiEnvironment, attemptId: string): Promise<Response> {
  const ownership = await attemptOwner(request, env, attemptId);
  if (ownership instanceof Response) return ownership;
  const { attempt } = ownership;
  if (attempt.status !== "in_progress") {
    return problem(409, "attempt_not_active", "This assessment attempt is not active.");
  }
  const grading = await env.DB.prepare(
    `SELECT r.question_id, q.question_type, q.points, r.selected_option_id,
      o.is_correct AS option_correct
     FROM assessment_responses r
     JOIN assessment_questions q ON q.id = r.question_id
     LEFT JOIN assessment_options o ON o.id = r.selected_option_id
     WHERE r.attempt_id = ?`
  ).bind(attemptId).all<{
    question_id: string;
    question_type: string;
    points: number;
    selected_option_id: string | null;
    option_correct: number | null;
  }>();
  const totals = await env.DB.prepare(
    `SELECT SUM(q.points) AS max_score,
      SUM(CASE WHEN q.question_type = 'short_text' THEN 1 ELSE 0 END) AS manual_count,
      a.passing_score
     FROM assessment_questions q
     JOIN assessment_attempts aa ON aa.assessment_id = q.assessment_id
     JOIN assessments a ON a.id = aa.assessment_id
     WHERE aa.id = ?`
  ).bind(attemptId).first<{ max_score: number; manual_count: number; passing_score: number }>();
  const awarded = grading.results.reduce(
    (sum, response) => sum + (response.option_correct ? response.points : 0),
    0
  );
  const maxScore = Number(totals?.max_score ?? 0);
  const score = maxScore ? Math.round((awarded / maxScore) * 100) : 0;
  const needsManualGrading = Number(totals?.manual_count ?? 0) > 0;
  const passingScore = Number(totals?.passing_score ?? 50);
  const now = new Date().toISOString();
  const statements = grading.results.map((response) => env.DB.prepare(
    "UPDATE assessment_responses SET awarded_points = ?, is_correct = ? WHERE attempt_id = ? AND question_id = ?"
  ).bind(
    response.option_correct ? response.points : 0,
    response.option_correct ? 1 : 0,
    attemptId,
    response.question_id
  ));
  statements.push(env.DB.prepare(
    `UPDATE assessment_attempts SET status = ?, submitted_at = ?, graded_at = ?,
      score = ?, max_score = ?, passed = ? WHERE id = ?`
  ).bind(
    needsManualGrading ? "grading" : "graded",
    now,
    needsManualGrading ? null : now,
    score,
    maxScore,
    score >= passingScore ? 1 : 0,
    attemptId
  ));
  await env.DB.batch(statements);
  return json({ result: {
    attemptId,
    status: needsManualGrading ? "grading" : "graded",
    score,
    maxScore,
    passed: score >= passingScore
  } });
}

async function flashcardDeck(request: Request, env: ApiEnvironment, deckId: string): Promise<Response> {
  const studentId = new URL(request.url).searchParams.get("studentId");
  const permitted = await permittedStudent(request, env, studentId);
  if (permitted instanceof Response) return permitted;
  const deck = await env.DB.prepare(
    "SELECT id, course_id, title, description FROM flashcard_decks WHERE id = ? AND status = 'published'"
  ).bind(deckId).first<{
    id: string;
    course_id: string;
    title: string;
    description: string;
  }>();
  if (!deck) return problem(404, "deck_not_found", "The flashcard deck does not exist.");
  if (!await hasDeckAccess(env, permitted.studentId, deck.id)) {
    return problem(403, "enrolment_required", "An active enrolment is required.");
  }
  const cards = await env.DB.prepare(
    `SELECT f.id, f.front_text, f.back_text, f.position,
      r.confidence, r.repetition_count, r.interval_days, r.next_review_at
     FROM flashcards f LEFT JOIN flashcard_reviews r
      ON r.flashcard_id = f.id AND r.student_user_id = ?
     WHERE f.deck_id = ? ORDER BY f.position`
  ).bind(permitted.studentId, deckId).all();
  return json({ deck, cards: cards.results });
}

async function reviewFlashcard(request: Request, env: ApiEnvironment, cardId: string): Promise<Response> {
  const input = await parseJson(request);
  const studentId = typeof input?.studentId === "string" ? input.studentId : null;
  const confidence = Number(input?.confidence);
  if (!Number.isInteger(confidence) || confidence < 1 || confidence > 4) {
    return problem(400, "invalid_confidence", "Confidence must be between 1 and 4.");
  }
  const permitted = await permittedStudent(request, env, studentId);
  if (permitted instanceof Response) return permitted;
  const card = await env.DB.prepare(
    "SELECT f.deck_id FROM flashcards f WHERE f.id = ?"
  ).bind(cardId).first<{ deck_id: string }>();
  if (!card || !await hasDeckAccess(env, permitted.studentId, card.deck_id)) {
    return problem(403, "enrolment_required", "An active enrolment is required.");
  }
  const previous = await env.DB.prepare(
    "SELECT repetition_count, interval_days FROM flashcard_reviews WHERE student_user_id = ? AND flashcard_id = ?"
  ).bind(permitted.studentId, cardId).first<{ repetition_count: number; interval_days: number }>();
  const repetitions = confidence <= 2 ? 0 : Number(previous?.repetition_count ?? 0) + 1;
  const intervalDays = confidence === 1 ? 0 : confidence === 2 ? 1
    : repetitions <= 1 ? 1
    : confidence === 3 ? Math.max(2, Math.round(Number(previous?.interval_days ?? 1) * 1.8))
    : Math.max(3, Math.round(Number(previous?.interval_days ?? 1) * 2.5));
  const reviewedAt = new Date();
  const nextReview = new Date(reviewedAt.getTime() + intervalDays * 86_400_000).toISOString();
  await env.DB.prepare(
    `INSERT INTO flashcard_reviews
      (student_user_id, flashcard_id, confidence, repetition_count, interval_days, next_review_at, reviewed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(student_user_id, flashcard_id) DO UPDATE SET
      confidence = excluded.confidence, repetition_count = excluded.repetition_count,
      interval_days = excluded.interval_days, next_review_at = excluded.next_review_at,
      reviewed_at = excluded.reviewed_at`
  ).bind(
    permitted.studentId,
    cardId,
    confidence,
    repetitions,
    intervalDays,
    nextReview,
    reviewedAt.toISOString()
  ).run();
  return json({ review: {
    cardId,
    confidence,
    repetitionCount: repetitions,
    intervalDays,
    nextReviewAt: nextReview
  } });
}

async function courseMaterial(request: Request, env: ApiEnvironment, materialId: string): Promise<Response> {
  const studentId = new URL(request.url).searchParams.get("studentId");
  const permitted = await permittedStudent(request, env, studentId);
  if (permitted instanceof Response) return permitted;
  const material = await env.DB.prepare(
    `SELECT m.id, m.title, m.material_type, m.storage_key, m.external_url
     FROM course_materials m
     JOIN course_offering_materials om ON om.material_id = m.id
     JOIN enrolment_offerings eo ON eo.course_offering_id = om.course_offering_id
     JOIN course_offerings o ON o.id = eo.course_offering_id
     WHERE m.id = ? AND m.status = 'published' AND eo.student_user_id = ?
       AND eo.status = 'active' AND (o.access_ends_at IS NULL OR o.access_ends_at >= ?)
     LIMIT 1`
  ).bind(materialId, permitted.studentId, new Date().toISOString()).first<{
    id: string;
    title: string;
    material_type: string;
    storage_key: string | null;
    external_url: string | null;
  }>();
  if (!material) return problem(403, "material_forbidden", "This material is not included in the purchased term.");
  if (material.external_url) return Response.redirect(material.external_url, 302);
  if (!material.storage_key) return problem(404, "material_missing", "The material file is unavailable.");
  const object = await env.MEDIA.get(material.storage_key);
  if (!object) return problem(404, "material_missing", "The material file is unavailable.");
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);
  headers.set("content-disposition", `inline; filename="${material.title.replace(/["\\]/g, "_")}"`);
  return new Response(object.body, { headers });
}

async function tutorAuthoring(
  request: Request,
  env: ApiEnvironment,
  pathname: string
): Promise<Response | null> {
  const actor = await getCreatorActorById(userIdFrom(request), env.DB);
  if (!actor) return problem(401, "creator_required", "Sign in to create or manage a course.");
  const deleteCourseMatch = pathname.match(/^\/api\/tutor\/courses\/([^/]+)$/);
  if (request.method === "DELETE" && deleteCourseMatch) {
    const courseId = decodeURIComponent(deleteCourseMatch[1]);
    const course = await env.DB.prepare(
      "SELECT id, status FROM courses WHERE id = ? AND (tutor_id = ? OR ? = 'admin')"
    ).bind(courseId, actor.id, actor.role).first<{ id: string; status: string }>();
    if (!course) return problem(404, "course_not_found", "This course does not exist or you cannot delete it.");
    if (course.status !== "draft") {
      return problem(409, "draft_required", "Published courses cannot be deleted. Unpublish them or create a new version instead.");
    }
    const usage = await env.DB.prepare(
      `SELECT (SELECT COUNT(*) FROM enrolments WHERE course_id = ?) +
        (SELECT COUNT(*) FROM orders WHERE course_id = ?) AS total`
    ).bind(courseId, courseId).first<{ total: number }>();
    if (Number(usage?.total ?? 0) > 0) {
      return problem(409, "course_in_use", "This course has learner or payment records and cannot be deleted.");
    }
    const now = new Date().toISOString();
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO audit_logs
          (id, actor_user_id, action, entity_type, entity_id, metadata_json, created_at)
         VALUES (?, ?, 'course.deleted', 'course', ?, '{}', ?)`
      ).bind(crypto.randomUUID(), actor.id, courseId, now),
      env.DB.prepare("DELETE FROM courses WHERE id = ?").bind(courseId)
    ]);
    return json({ deleted: true, id: courseId });
  }
  const copyCourseMatch = pathname.match(/^\/api\/tutor\/courses\/([^/]+)\/copy$/);
  if (request.method === "POST" && copyCourseMatch) {
    const sourceId = decodeURIComponent(copyCourseMatch[1]);
    const source = await env.DB.prepare(
      `SELECT * FROM courses WHERE id = ? AND (tutor_id = ? OR ? = 'admin')`
    ).bind(sourceId, actor.id, actor.role).first<Record<string, unknown>>();
    if (!source) return problem(404, "course_not_found", "This course does not exist or you cannot copy it.");
    if (source.status !== "published") {
      return problem(409, "published_course_required", "Publish this course before creating a new version.");
    }
    const rootId = typeof source.source_course_id === "string" && source.source_course_id
      ? source.source_course_id : String(source.id);
    const versionRow = await env.DB.prepare(
      "SELECT MAX(content_version) AS version FROM courses WHERE id = ? OR source_course_id = ?"
    ).bind(rootId, rootId).first<{ version: number | null }>();
    const version = Number(versionRow?.version ?? source.content_version ?? 1) + 1;
    const courseId = crypto.randomUUID();
    const slugBase = String(source.title).toLowerCase().normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "").slice(0, 58) || "course";
    const slug = `${slugBase}-v${version}-${courseId.slice(0, 8)}`;
    const now = new Date().toISOString();
    const [modules, lessons, assessments, questions, options, decks, cards, materials, categories, lessonMedia] = await Promise.all([
      env.DB.prepare("SELECT * FROM course_modules WHERE course_id = ? ORDER BY position").bind(sourceId).all<Record<string, unknown>>(),
      env.DB.prepare(
        "SELECT l.* FROM lessons l JOIN course_modules m ON m.id = l.module_id WHERE m.course_id = ? ORDER BY m.position, l.position"
      ).bind(sourceId).all<Record<string, unknown>>(),
      env.DB.prepare("SELECT * FROM assessments WHERE course_id = ? ORDER BY created_at").bind(sourceId).all<Record<string, unknown>>(),
      env.DB.prepare(
        "SELECT q.* FROM assessment_questions q JOIN assessments a ON a.id = q.assessment_id WHERE a.course_id = ? ORDER BY q.assessment_id, q.position"
      ).bind(sourceId).all<Record<string, unknown>>(),
      env.DB.prepare(
        `SELECT o.* FROM assessment_options o JOIN assessment_questions q ON q.id = o.question_id
         JOIN assessments a ON a.id = q.assessment_id WHERE a.course_id = ? ORDER BY o.question_id, o.position`
      ).bind(sourceId).all<Record<string, unknown>>(),
      env.DB.prepare("SELECT * FROM flashcard_decks WHERE course_id = ? ORDER BY created_at").bind(sourceId).all<Record<string, unknown>>(),
      env.DB.prepare(
        "SELECT f.* FROM flashcards f JOIN flashcard_decks d ON d.id = f.deck_id WHERE d.course_id = ? ORDER BY f.deck_id, f.position"
      ).bind(sourceId).all<Record<string, unknown>>(),
      env.DB.prepare("SELECT * FROM course_materials WHERE course_id = ? ORDER BY created_at").bind(sourceId).all<Record<string, unknown>>(),
      env.DB.prepare("SELECT category_id FROM course_category_links WHERE course_id = ?").bind(sourceId).all<{ category_id: string }>(),
      env.DB.prepare(
        `SELECT lm.lesson_id, lm.media_asset_id, lm.position, lm.required_percent
         FROM lesson_media lm JOIN lessons l ON l.id = lm.lesson_id
         JOIN course_modules m ON m.id = l.module_id WHERE m.course_id = ?`
      ).bind(sourceId).all<{ lesson_id: string; media_asset_id: string; position: number; required_percent: number }>()
    ]);
    const moduleIds = new Map<string, string>();
    const lessonIds = new Map<string, string>();
    const assessmentIds = new Map<string, string>();
    const questionIds = new Map<string, string>();
    const deckIds = new Map<string, string>();
    modules.results.forEach((row) => moduleIds.set(String(row.id), crypto.randomUUID()));
    lessons.results.forEach((row) => lessonIds.set(String(row.id), crypto.randomUUID()));
    assessments.results.forEach((row) => assessmentIds.set(String(row.id), crypto.randomUUID()));
    questions.results.forEach((row) => questionIds.set(String(row.id), crypto.randomUUID()));
    decks.results.forEach((row) => deckIds.set(String(row.id), crypto.randomUUID()));
    const statements = [
      env.DB.prepare(
        `INSERT INTO courses
          (id, tutor_id, slug, title, description, subject, primary_level, language_code, delivery_mode,
           price_cents, creator_price_cents, currency, accent, status, pricing_status, pricing_version,
           listing_status, created_at, updated_at, source_course_id, content_version)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', 'pending', 1, 'unlisted', ?, ?, ?, ?)`
      ).bind(
        courseId, source.tutor_id, slug, source.title, source.description, source.subject,
        source.primary_level, source.language_code ?? "en", source.delivery_mode, source.price_cents,
        source.creator_price_cents ?? source.price_cents, source.currency,
        source.accent ?? null, now, now, rootId, version
      ),
      env.DB.prepare(
        `INSERT INTO course_members
          (course_id, user_id, member_role, status, created_at, updated_at)
         VALUES (?, ?, 'owner', 'active', ?, ?)`
      ).bind(courseId, source.tutor_id, now, now)
    ];
    categories.results.forEach((row) => statements.push(env.DB.prepare(
      "INSERT INTO course_category_links (course_id, category_id) VALUES (?, ?)"
    ).bind(courseId, row.category_id)));
    modules.results.forEach((row) => statements.push(env.DB.prepare(
      "INSERT INTO course_modules (id, course_id, title, position, created_at) VALUES (?, ?, ?, ?, ?)"
    ).bind(moduleIds.get(String(row.id)), courseId, row.title, row.position, now)));
    lessons.results.forEach((row) => statements.push(env.DB.prepare(
      `INSERT INTO lessons
        (id, module_id, title, lesson_type, content_json, position, estimated_minutes,
         delivery_mode, course_session_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`
    ).bind(
      lessonIds.get(String(row.id)), moduleIds.get(String(row.module_id)), row.title,
      row.lesson_type, row.content_json, row.position, row.estimated_minutes,
      row.delivery_mode, now, now
    )));
    assessments.results.forEach((row) => statements.push(env.DB.prepare(
      `INSERT INTO assessments
        (id, course_id, lesson_id, created_by, assessment_type, title, instructions,
         time_limit_seconds, attempt_limit, passing_score, feedback_mode, status, version,
         available_from, available_until, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', 1, ?, ?, ?, ?)`
    ).bind(
      assessmentIds.get(String(row.id)), courseId,
      row.lesson_id ? lessonIds.get(String(row.lesson_id)) ?? null : null,
      source.tutor_id, row.assessment_type, row.title, row.instructions,
      row.time_limit_seconds, row.attempt_limit, row.passing_score, row.feedback_mode,
      row.available_from, row.available_until, now, now
    )));
    questions.results.forEach((row) => statements.push(env.DB.prepare(
      `INSERT INTO assessment_questions
        (id, assessment_id, question_type, prompt, explanation, points, position)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      questionIds.get(String(row.id)), assessmentIds.get(String(row.assessment_id)),
      row.question_type, row.prompt, row.explanation, row.points, row.position
    )));
    options.results.forEach((row) => statements.push(env.DB.prepare(
      "INSERT INTO assessment_options (id, question_id, label, is_correct, position) VALUES (?, ?, ?, ?, ?)"
    ).bind(crypto.randomUUID(), questionIds.get(String(row.question_id)), row.label, row.is_correct, row.position)));
    decks.results.forEach((row) => statements.push(env.DB.prepare(
      `INSERT INTO flashcard_decks
        (id, course_id, lesson_id, created_by, title, description, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'draft', ?, ?)`
    ).bind(
      deckIds.get(String(row.id)), courseId,
      row.lesson_id ? lessonIds.get(String(row.lesson_id)) ?? null : null,
      source.tutor_id, row.title, row.description, now, now
    )));
    cards.results.forEach((row) => statements.push(env.DB.prepare(
      `INSERT INTO flashcards
        (id, deck_id, front_text, back_text, position, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      crypto.randomUUID(), deckIds.get(String(row.deck_id)), row.front_text,
      row.back_text, row.position, now, now
    )));
    materials.results.forEach((row) => statements.push(env.DB.prepare(
      `INSERT INTO course_materials
        (id, course_id, created_by, title, description, material_type, resource_kind,
         content_kind, storage_key, external_url, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?)`
    ).bind(
      crypto.randomUUID(), courseId, source.tutor_id, row.title, row.description,
      row.material_type, row.resource_kind, row.content_kind, row.storage_key,
      row.external_url, now, now
    )));
    lessonMedia.results.forEach((row) => statements.push(env.DB.prepare(
      "INSERT INTO lesson_media (lesson_id, media_asset_id, position, required_percent) VALUES (?, ?, ?, ?)"
    ).bind(lessonIds.get(row.lesson_id), row.media_asset_id, row.position, row.required_percent)));
    statements.push(env.DB.prepare(
      `INSERT INTO audit_logs
        (id, actor_user_id, action, entity_type, entity_id, metadata_json, created_at)
       VALUES (?, ?, 'course.version_created', 'course', ?, ?, ?)`
    ).bind(crypto.randomUUID(), actor.id, courseId, JSON.stringify({ sourceId, version }), now));
    await env.DB.batch(statements);
    return json({ course: { id: courseId, slug, status: "draft", contentVersion: version } }, { status: 201 });
  }
  const studioMatch = pathname.match(/^\/api\/tutor\/courses\/([^/]+)\/studio$/);
  if (request.method === "GET" && studioMatch) {
    const courseId = decodeURIComponent(studioMatch[1]);
    const course = await env.DB.prepare(
      `SELECT c.id, c.slug, c.title, c.description, c.subject, c.primary_level,
        c.delivery_mode, c.price_cents, c.currency, c.status, c.pricing_status,
        c.listing_status, c.delisted_at, c.delisted_reason, c.content_version, c.source_course_id,
        c.cover_asset_id,
        CASE WHEN ? = 'admin' THEN 'platform_admin'
          WHEN c.tutor_id = ? THEN 'owner' ELSE cm.member_role END AS member_role
       FROM courses c LEFT JOIN course_members cm
        ON cm.course_id = c.id AND cm.user_id = ? AND cm.status = 'active'
       WHERE c.id = ? AND (? = 'admin' OR c.tutor_id = ? OR cm.user_id IS NOT NULL)`
    ).bind(actor.role, actor.id, actor.id, courseId, actor.role, actor.id).first();
    if (!course) return problem(404, "course_not_found", "The course does not exist.");
    const [modules, lessons, assessments, assessmentQuestions, assessmentOptions, assessmentQuestionMedia, decks, offerings, materials, offeringModules, offeringAssessments, offeringDecks, offeringMaterials, learningProducts, offeringLearningProducts, categories, sessions, learners] = await Promise.all([
      env.DB.prepare("SELECT id, title, position FROM course_modules WHERE course_id = ? ORDER BY position").bind(courseId).all(),
      env.DB.prepare(
        "SELECT l.id, l.module_id, l.title, l.lesson_type, l.delivery_mode, l.course_session_id, l.position FROM lessons l JOIN course_modules m ON m.id = l.module_id WHERE m.course_id = ? ORDER BY m.position, l.position"
      ).bind(courseId).all(),
      env.DB.prepare(
        `SELECT id, title, assessment_type, instructions, time_limit_seconds, attempt_limit,
          passing_score, feedback_mode, status, version
         FROM assessments WHERE course_id = ? ORDER BY created_at`
      ).bind(courseId).all(),
      env.DB.prepare(
        `SELECT q.id, q.assessment_id, q.question_type, q.prompt, q.explanation, q.points, q.position
         FROM assessment_questions q JOIN assessments a ON a.id = q.assessment_id
         WHERE a.course_id = ? ORDER BY q.assessment_id, q.position`
      ).bind(courseId).all(),
      env.DB.prepare(
        `SELECT o.id, o.question_id, o.label, o.is_correct, o.position
         FROM assessment_options o JOIN assessment_questions q ON q.id = o.question_id
         JOIN assessments a ON a.id = q.assessment_id
         WHERE a.course_id = ? ORDER BY o.question_id, o.position`
      ).bind(courseId).all(),
      env.DB.prepare(
        `SELECT m.course_question_id AS question_id, m.library_item_id, m.media_type, m.alt_text, m.caption
         FROM assessment_question_media m
         JOIN assessment_questions q ON q.id = m.course_question_id
         JOIN assessments a ON a.id = q.assessment_id
         WHERE a.course_id = ?`
      ).bind(courseId).all(),
      env.DB.prepare(
        "SELECT id, title, status FROM flashcard_decks WHERE course_id = ? ORDER BY created_at"
      ).bind(courseId).all(),
      env.DB.prepare(
        `SELECT o.id, o.title, o.price_cents, o.creator_price_cents,
          o.platform_fixed_fee_cents, o.service_fee_bps, o.service_fee_cents,
          o.planned_meeting_minutes, o.planned_meeting_participants,
          o.planned_paid_learners, o.planned_meeting_cost_cents,
          o.currency, o.status, o.pricing_status,
          o.enrolment_opens_at, o.enrolment_closes_at, o.access_ends_at,
          o.offering_type, o.delivery_mode, o.starts_at, o.ends_at, o.timezone, o.capacity,
          t.academic_year, t.term_number
         FROM course_offerings o JOIN academic_terms t ON t.id = o.academic_term_id
         WHERE o.course_id = ? ORDER BY COALESCE(o.starts_at, t.starts_at, o.created_at), o.title`
      ).bind(courseId).all(),
      env.DB.prepare(
        "SELECT id, title, description, material_type, resource_kind, content_kind, status FROM course_materials WHERE course_id = ? ORDER BY created_at"
      ).bind(courseId).all(),
      env.DB.prepare(
        `SELECT om.course_offering_id, om.module_id FROM course_offering_modules om
         JOIN course_offerings o ON o.id = om.course_offering_id WHERE o.course_id = ?`
      ).bind(courseId).all(),
      env.DB.prepare(
        `SELECT oa.course_offering_id, oa.assessment_id FROM course_offering_assessments oa
         JOIN course_offerings o ON o.id = oa.course_offering_id WHERE o.course_id = ?`
      ).bind(courseId).all(),
      env.DB.prepare(
        `SELECT od.course_offering_id, od.deck_id FROM course_offering_flashcard_decks od
         JOIN course_offerings o ON o.id = od.course_offering_id WHERE o.course_id = ?`
      ).bind(courseId).all(),
      env.DB.prepare(
        `SELECT om.course_offering_id, om.material_id FROM course_offering_materials om
         JOIN course_offerings o ON o.id = om.course_offering_id WHERE o.course_id = ?`
      ).bind(courseId).all(),
      env.DB.prepare(
        `SELECT p.id, p.slug, p.title, p.description, p.product_type, p.estimated_minutes,
          p.price_cents, p.currency, p.status, p.listing_status
         FROM learning_products p
         WHERE p.status != 'archived' AND (p.creator_id = ? OR ? = 'admin')
         ORDER BY p.updated_at DESC, p.title`
      ).bind(actor.id, actor.role).all(),
      env.DB.prepare(
        `SELECT olp.course_offering_id, olp.learning_product_id, olp.position, olp.release_at
         FROM course_offering_learning_products olp
         JOIN course_offerings o ON o.id = olp.course_offering_id
         WHERE o.course_id = ? ORDER BY olp.position`
      ).bind(courseId).all(),
      env.DB.prepare(
        `SELECT cc.id, cc.slug, cc.title,
          EXISTS(SELECT 1 FROM course_category_links cl WHERE cl.course_id = ? AND cl.category_id = cc.id) AS selected
         FROM course_categories cc WHERE cc.active = 1 ORDER BY cc.position, cc.title`
      ).bind(courseId).all(),
      env.DB.prepare(
        `SELECT s.id, s.course_offering_id, s.instructor_user_id, s.title, s.delivery_mode,
          s.starts_at, s.ends_at, s.timezone, s.capacity, s.meeting_url, s.status,
          o.status AS offering_status, iu.display_name AS instructor_name,
          v.name AS venue_name, v.address_line_1, v.city, v.arrival_instructions
         FROM course_sessions s LEFT JOIN venues v ON v.id = s.venue_id
         LEFT JOIN users iu ON iu.id = s.instructor_user_id
         JOIN course_offerings o ON o.id = s.course_offering_id
         WHERE o.course_id = ? ORDER BY s.starts_at`
      ).bind(courseId).all(),
      env.DB.prepare(
        `SELECT u.id, u.display_name, u.email, o.title AS offering_title,
          eo.status, eo.enrolled_at,
          ROUND(COALESCE(AVG(pr.progress_percent), 0)) AS progress_percent
         FROM course_offerings o
         JOIN enrolment_offerings eo ON eo.course_offering_id = o.id
         JOIN enrolments e ON e.id = eo.enrolment_id
         JOIN users u ON u.id = eo.student_user_id
         LEFT JOIN progress_records pr ON pr.enrolment_id = e.id
         WHERE o.course_id = ?
         GROUP BY eo.id, u.id, o.id
         ORDER BY eo.enrolled_at DESC`
      ).bind(courseId).all()
    ]);
    return json({
      course,
      modules: modules.results,
      lessons: lessons.results,
      assessments: assessments.results,
      assessmentQuestions: assessmentQuestions.results,
      assessmentOptions: assessmentOptions.results,
      assessmentQuestionMedia: assessmentQuestionMedia.results,
      flashcardDecks: decks.results,
      offerings: offerings.results,
      materials: materials.results,
      offeringModules: offeringModules.results,
      offeringAssessments: offeringAssessments.results,
      offeringDecks: offeringDecks.results,
      offeringMaterials: offeringMaterials.results,
      learningProducts: learningProducts.results,
      offeringLearningProducts: offeringLearningProducts.results,
      categories: categories.results,
      sessions: sessions.results,
      learners: learners.results
    });
  }

  const updateCourseMatch = pathname.match(/^\/api\/tutor\/courses\/([^/]+)$/);
  if (request.method === "PATCH" && updateCourseMatch) {
    const courseId = decodeURIComponent(updateCourseMatch[1]);
    const owned = await env.DB.prepare(
      `SELECT status FROM courses WHERE id = ? AND (tutor_id = ? OR ? = 'admin' OR EXISTS (
        SELECT 1 FROM course_members cm WHERE cm.course_id = courses.id AND cm.user_id = ?
          AND cm.status = 'active' AND cm.member_role IN ('owner', 'administrator', 'editor')
      ))`
    ).bind(courseId, actor.id, actor.role, actor.id).first<{ status: string }>();
    if (!owned) return problem(403, "course_forbidden", "Only the course creator can edit these course details.");
    if (owned.status !== "draft") return problem(409, "draft_version_required", "Create a new draft version before editing this published course.");
    const input = await parseJson(request);
    const title = text(input?.title, 3, 160);
    const description = text(input?.description, 20, 5000);
    const subject = text(input?.subject, 1, 120);
    const primaryLevel = text(input?.primaryLevel, 1, 120);
    const languageCode = /^[a-z]{2,3}(?:-[A-Z]{2})?$/.test(String(input?.languageCode ?? ""))
      ? String(input?.languageCode) : "en";
    const deliveryMode = ["self-paced", "live", "hybrid", "ai-supported"].includes(String(input?.deliveryMode))
      ? String(input?.deliveryMode) : null;
    if (!title || !description || !subject || !primaryLevel || !deliveryMode) {
      return problem(400, "invalid_course", "Add a title, description, topic, audience, and valid delivery mode.");
    }
    const now = new Date().toISOString();
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE courses SET title = ?, description = ?, subject = ?, primary_level = ?, language_code = ?,
          delivery_mode = ?, updated_at = ? WHERE id = ?`
      ).bind(title, description, subject, primaryLevel, languageCode, deliveryMode, now, courseId),
      env.DB.prepare(
        `INSERT INTO audit_logs
          (id, actor_user_id, action, entity_type, entity_id, metadata_json, created_at)
         VALUES (?, ?, 'course.updated', 'course', ?, ?, ?)`
      ).bind(crypto.randomUUID(), actor.id, courseId, JSON.stringify({ title }), now)
    ]);
    return json({ course: { id: courseId, title } });
  }

  const copyAssessmentMatch = pathname.match(/^\/api\/tutor\/assessments\/([^/]+)\/copy$/);
  if (request.method === "POST" && copyAssessmentMatch) {
    const assessmentId = decodeURIComponent(copyAssessmentMatch[1]);
    const source = await env.DB.prepare(
      `SELECT a.* FROM assessments a JOIN courses c ON c.id = a.course_id
       WHERE a.id = ? AND a.status = 'published' AND (c.tutor_id = ? OR ? = 'admin' OR EXISTS (
         SELECT 1 FROM course_members cm WHERE cm.course_id = c.id AND cm.user_id = ?
           AND cm.status = 'active' AND cm.member_role IN ('owner', 'administrator', 'editor')
       ))`
    ).bind(assessmentId, actor.id, actor.role, actor.id).first<Record<string, unknown>>();
    if (!source) return problem(404, "assessment_not_found", "Choose a published assessment you can manage.");
    const [questions, options, questionMedia] = await Promise.all([
      env.DB.prepare("SELECT * FROM assessment_questions WHERE assessment_id = ? ORDER BY position")
        .bind(assessmentId).all<Record<string, unknown>>(),
      env.DB.prepare(
        `SELECT o.* FROM assessment_options o JOIN assessment_questions q ON q.id = o.question_id
         WHERE q.assessment_id = ? ORDER BY q.position, o.position`
      ).bind(assessmentId).all<Record<string, unknown>>(),
      env.DB.prepare(
        `SELECT m.* FROM assessment_question_media m JOIN assessment_questions q ON q.id = m.course_question_id
         WHERE q.assessment_id = ?`
      ).bind(assessmentId).all<Record<string, unknown>>()
    ]);
    const newAssessmentId = crypto.randomUUID();
    const questionIds = new Map<string, string>();
    questions.results.forEach((question) => questionIds.set(String(question.id), crypto.randomUUID()));
    const now = new Date().toISOString();
    const nextVersion = Number(source.version ?? 1) + 1;
    const statements = [
      env.DB.prepare(
        `INSERT INTO assessments
          (id, course_id, lesson_id, created_by, assessment_type, title, instructions,
           time_limit_seconds, attempt_limit, passing_score, feedback_mode, status, version,
           available_from, available_until, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?)`
      ).bind(
        newAssessmentId, source.course_id, source.lesson_id, actor.id, source.assessment_type,
        `${String(source.title)} — draft v${nextVersion}`.slice(0, 160), source.instructions,
        source.time_limit_seconds, source.attempt_limit, source.passing_score, source.feedback_mode,
        nextVersion, source.available_from, source.available_until, now, now
      )
    ];
    questions.results.forEach((question) => statements.push(env.DB.prepare(
      `INSERT INTO assessment_questions
        (id, assessment_id, question_type, prompt, explanation, points, position)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      questionIds.get(String(question.id)), newAssessmentId, question.question_type,
      question.prompt, question.explanation, question.points, question.position
    )));
    options.results.forEach((option) => statements.push(env.DB.prepare(
      "INSERT INTO assessment_options (id, question_id, label, is_correct, position) VALUES (?, ?, ?, ?, ?)"
    ).bind(
      crypto.randomUUID(), questionIds.get(String(option.question_id)), option.label,
      option.is_correct, option.position
    )));
    questionMedia.results.forEach((media) => statements.push(questionMediaInsert(
      env,
      actor.id,
      {
        libraryItemId: String(media.library_item_id),
        assetVersionId: String(media.asset_version_id),
        mediaType: String(media.media_type) as "image" | "video" | "audio",
        altText: String(media.alt_text ?? ""),
        caption: String(media.caption ?? "")
      },
      { courseQuestionId: String(questionIds.get(String(media.course_question_id))) },
      now
    )));
    statements.push(env.DB.prepare(
      `INSERT INTO audit_logs
        (id, actor_user_id, action, entity_type, entity_id, metadata_json, created_at)
       VALUES (?, ?, 'assessment.version_created', 'assessment', ?, ?, ?)`
    ).bind(
      crypto.randomUUID(), actor.id, newAssessmentId,
      JSON.stringify({ sourceAssessmentId: assessmentId, version: nextVersion }), now
    ));
    await env.DB.batch(statements);
    return json({ assessment: { id: newAssessmentId, status: "draft", version: nextVersion } }, { status: 201 });
  }

  const reorderQuestionsMatch = pathname.match(/^\/api\/tutor\/assessments\/([^/]+)\/questions\/order$/);
  if (request.method === "PATCH" && reorderQuestionsMatch) {
    const assessmentId = decodeURIComponent(reorderQuestionsMatch[1]);
    const assessment = await env.DB.prepare(
      `SELECT a.id FROM assessments a JOIN courses c ON c.id = a.course_id
       WHERE a.id = ? AND a.status = 'draft' AND (c.tutor_id = ? OR ? = 'admin' OR EXISTS (
         SELECT 1 FROM course_members cm WHERE cm.course_id = c.id AND cm.user_id = ?
           AND cm.status = 'active' AND cm.member_role IN ('owner', 'administrator', 'editor')
       ))`
    ).bind(assessmentId, actor.id, actor.role, actor.id).first();
    if (!assessment) return problem(409, "draft_version_required", "Only draft assessment questions can be reordered.");
    const input = await parseJson(request);
    const questionIds = Array.isArray(input?.questionIds)
      ? input.questionIds.filter((id): id is string => typeof id === "string" && id.length > 0) : [];
    const existing = await env.DB.prepare(
      "SELECT id FROM assessment_questions WHERE assessment_id = ? ORDER BY position"
    ).bind(assessmentId).all<{ id: string }>();
    const expected = new Set(existing.results.map((question) => question.id));
    if (questionIds.length !== expected.size || new Set(questionIds).size !== expected.size ||
        questionIds.some((id) => !expected.has(id))) {
      return problem(400, "invalid_question_order", "Provide every assessment question exactly once.");
    }
    const now = new Date().toISOString();
    const statements = [
      env.DB.prepare("UPDATE assessment_questions SET position = position + 1000000 WHERE assessment_id = ?").bind(assessmentId),
      ...questionIds.map((id, index) => env.DB.prepare(
        "UPDATE assessment_questions SET position = ? WHERE id = ? AND assessment_id = ?"
      ).bind(index + 1, id, assessmentId)),
      env.DB.prepare("UPDATE assessments SET version = version + 1, updated_at = ? WHERE id = ?").bind(now, assessmentId),
      env.DB.prepare(
        `INSERT INTO audit_logs
          (id, actor_user_id, action, entity_type, entity_id, metadata_json, created_at)
         VALUES (?, ?, 'assessment.questions_reordered', 'assessment', ?, ?, ?)`
      ).bind(crypto.randomUUID(), actor.id, assessmentId, JSON.stringify({ questionIds }), now)
    ];
    await env.DB.batch(statements);
    return json({ reordered: true, assessmentId });
  }

  const updateAssessmentMatch = pathname.match(/^\/api\/tutor\/assessments\/([^/]+)$/);
  if (request.method === "PATCH" && updateAssessmentMatch) {
    const assessmentId = decodeURIComponent(updateAssessmentMatch[1]);
    const owned = await env.DB.prepare(
      `SELECT a.status FROM assessments a JOIN courses c ON c.id = a.course_id
       WHERE a.id = ? AND (c.tutor_id = ? OR ? = 'admin' OR EXISTS (
         SELECT 1 FROM course_members cm WHERE cm.course_id = c.id AND cm.user_id = ?
           AND cm.status = 'active' AND cm.member_role IN ('owner', 'administrator', 'editor')
       ))`
    ).bind(assessmentId, actor.id, actor.role, actor.id).first<{ status: string }>();
    if (!owned) return problem(403, "assessment_forbidden", "Only the content creator can edit this assessment.");
    if (owned.status !== "draft") {
      return problem(409, "draft_version_required", "Published assessments are read-only. Create a new draft version to make changes.");
    }
    const input = await parseJson(request);
    const title = text(input?.title, 2, 160);
    const assessmentType = ["quiz", "test", "mock_exam"].includes(String(input?.assessmentType))
      ? String(input?.assessmentType) : null;
    const timeLimitSeconds = Number(input?.timeLimitSeconds ?? 0) || null;
    const attemptLimit = Number(input?.attemptLimit ?? 0) || null;
    const passingScore = Number(input?.passingScore);
    const feedbackMode = ["immediate", "after_submission", "after_close"].includes(String(input?.feedbackMode))
      ? String(input?.feedbackMode) : null;
    if (!title || !assessmentType || !feedbackMode ||
        (timeLimitSeconds !== null && (!Number.isSafeInteger(timeLimitSeconds) || timeLimitSeconds < 60)) ||
        (attemptLimit !== null && (!Number.isSafeInteger(attemptLimit) || attemptLimit < 1)) ||
        !Number.isFinite(passingScore) || passingScore < 0 || passingScore > 100) {
      return problem(400, "invalid_assessment", "Provide valid assessment settings.");
    }
    const now = new Date().toISOString();
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE assessments SET title = ?, assessment_type = ?, instructions = ?,
          time_limit_seconds = ?, attempt_limit = ?, passing_score = ?, feedback_mode = ?,
          version = version + 1, updated_at = ? WHERE id = ?`
      ).bind(
        title, assessmentType,
        typeof input?.instructions === "string" ? input.instructions.slice(0, 5000) : "",
        timeLimitSeconds, attemptLimit, passingScore, feedbackMode, now, assessmentId
      ),
      env.DB.prepare(
        `INSERT INTO audit_logs
          (id, actor_user_id, action, entity_type, entity_id, metadata_json, created_at)
         VALUES (?, ?, 'assessment.updated', 'assessment', ?, ?, ?)`
      ).bind(crypto.randomUUID(), actor.id, assessmentId, JSON.stringify({ title, assessmentType }), now)
    ]);
    return json({ assessment: { id: assessmentId, title, assessmentType } });
  }

  const updateQuestionMatch = pathname.match(/^\/api\/tutor\/assessment-questions\/([^/]+)$/);
  if (request.method === "PATCH" && updateQuestionMatch) {
    const questionId = decodeURIComponent(updateQuestionMatch[1]);
    const question = await env.DB.prepare(
      `SELECT q.id, q.assessment_id, a.status FROM assessment_questions q
       JOIN assessments a ON a.id = q.assessment_id JOIN courses c ON c.id = a.course_id
       WHERE q.id = ? AND (c.tutor_id = ? OR ? = 'admin' OR EXISTS (
         SELECT 1 FROM course_members cm WHERE cm.course_id = c.id AND cm.user_id = ?
           AND cm.status = 'active' AND cm.member_role IN ('owner', 'administrator', 'editor')
       ))`
    ).bind(questionId, actor.id, actor.role, actor.id).first<{ id: string; assessment_id: string; status: string }>();
    if (!question) return problem(403, "question_forbidden", "Only the content creator can edit this question.");
    if (question.status !== "draft") {
      return problem(409, "draft_version_required", "Published questions are read-only. Create a new draft version to make changes.");
    }
    const input = await parseJson(request);
    const prompt = text(input?.prompt, 2, 2000);
    const questionType = ["multiple_choice", "true_false", "short_text"].includes(String(input?.questionType))
      ? String(input?.questionType) : "multiple_choice";
    const options = Array.isArray(input?.options)
      ? input.options.filter((option): option is { label: string; isCorrect?: boolean } =>
          Boolean(option) && typeof option === "object" && typeof option.label === "string" && option.label.trim().length > 0)
      : [];
    if (!prompt) return problem(400, "invalid_question", "A question prompt is required.");
    if (questionType !== "short_text" &&
        (options.length < 2 || options.filter((option) => option.isCorrect === true).length !== 1)) {
      return problem(400, "invalid_question", "Choice questions need at least two choices and exactly one correct answer.");
    }
    if (questionType === "true_false" && options.length !== 2) {
      return problem(400, "invalid_question", "True or false questions must contain exactly two choices.");
    }
    const questionMedia = await resolveQuestionMedia(env, actor.id, input ?? {});
    if (questionMedia instanceof Response) return questionMedia;
    const now = new Date().toISOString();
    const statements = [
      env.DB.prepare(
        "UPDATE assessment_questions SET question_type = ?, prompt = ?, explanation = ?, points = ? WHERE id = ?"
      ).bind(
        questionType,
        prompt,
        typeof input?.explanation === "string" ? input.explanation.slice(0, 2000) : "",
        Math.max(1, Number(input?.points ?? 1) || 1),
        questionId
      ),
      env.DB.prepare("DELETE FROM assessment_options WHERE question_id = ?").bind(questionId),
      env.DB.prepare("DELETE FROM assessment_question_media WHERE course_question_id = ?").bind(questionId),
      env.DB.prepare("UPDATE assessments SET version = version + 1, updated_at = ? WHERE id = ?")
        .bind(now, question.assessment_id)
    ];
    if (questionType !== "short_text") options.forEach((option, index) => {
      statements.push(env.DB.prepare(
        "INSERT INTO assessment_options (id, question_id, label, is_correct, position) VALUES (?, ?, ?, ?, ?)"
      ).bind(crypto.randomUUID(), questionId, option.label.trim().slice(0, 500), option.isCorrect === true ? 1 : 0, index + 1));
    });
    if (questionMedia) statements.push(questionMediaInsert(
      env, actor.id, questionMedia, { courseQuestionId: questionId }, now
    ));
    statements.push(env.DB.prepare(
      `INSERT INTO audit_logs
        (id, actor_user_id, action, entity_type, entity_id, metadata_json, created_at)
       VALUES (?, ?, 'assessment.question_updated', 'assessment', ?, ?, ?)`
    ).bind(
      crypto.randomUUID(), actor.id, question.assessment_id,
      JSON.stringify({ questionId, prompt }), now
    ));
    await env.DB.batch(statements);
    return json({ question: { id: questionId, assessmentId: question.assessment_id } });
  }

  const deleteQuestionMatch = pathname.match(/^\/api\/tutor\/assessment-questions\/([^/]+)$/);
  if (request.method === "DELETE" && deleteQuestionMatch) {
    const questionId = decodeURIComponent(deleteQuestionMatch[1]);
    const question = await env.DB.prepare(
      `SELECT q.assessment_id FROM assessment_questions q
       JOIN assessments a ON a.id = q.assessment_id JOIN courses c ON c.id = a.course_id
       WHERE q.id = ? AND a.status = 'draft' AND (c.tutor_id = ? OR ? = 'admin' OR EXISTS (
         SELECT 1 FROM course_members cm WHERE cm.course_id = c.id AND cm.user_id = ?
           AND cm.status = 'active' AND cm.member_role IN ('owner', 'administrator', 'editor')
       ))`
    ).bind(questionId, actor.id, actor.role, actor.id).first<{ assessment_id: string }>();
    if (!question) return problem(409, "draft_version_required", "Only questions in a draft assessment can be deleted.");
    const now = new Date().toISOString();
    await env.DB.batch([
      env.DB.prepare("DELETE FROM assessment_questions WHERE id = ?").bind(questionId),
      env.DB.prepare("UPDATE assessments SET version = version + 1, updated_at = ? WHERE id = ?")
        .bind(now, question.assessment_id),
      env.DB.prepare(
        `INSERT INTO audit_logs
          (id, actor_user_id, action, entity_type, entity_id, metadata_json, created_at)
         VALUES (?, ?, 'assessment.question_deleted', 'assessment', ?, ?, ?)`
      ).bind(crypto.randomUUID(), actor.id, question.assessment_id, JSON.stringify({ questionId }), now)
    ]);
    return json({ deleted: true, questionId, assessmentId: question.assessment_id });
  }

  const offeringUpdateMatch = pathname.match(/^\/api\/tutor\/offerings\/([^/]+)$/);
  if (request.method === "PATCH" && offeringUpdateMatch) {
    const offeringId = decodeURIComponent(offeringUpdateMatch[1]);
    const current = await env.DB.prepare(
      `SELECT o.*, c.tutor_id FROM course_offerings o JOIN courses c ON c.id = o.course_id
       WHERE o.id = ? AND (c.tutor_id = ? OR ? = 'admin')`
    ).bind(offeringId, actor.id, actor.role).first<Record<string, unknown>>();
    if (!current) return problem(403, "offering_forbidden", "You cannot edit this course offering.");
    if (current.status !== "draft") return problem(409, "draft_offering_required", "Only draft offers can be changed. Create a new draft offer for schedule or pricing changes.");
    const input = await parseJson(request);
    const title = input?.title === undefined ? String(current.title) : text(input.title, 2, 120);
    const deliveryMode = input?.deliveryMode === undefined ? String(current.delivery_mode)
      : ["recorded", "live_online", "in_person", "hybrid"].includes(String(input.deliveryMode)) ? String(input.deliveryMode) : "";
    const creatorPriceCents = input?.priceCents === undefined ? Number(current.creator_price_cents) : Number(input.priceCents);
    const plannedMeetingMinutes = deliveryMode === "live_online" || deliveryMode === "hybrid"
      ? Number(input?.plannedMeetingMinutes ?? current.planned_meeting_minutes ?? 0) : 0;
    const plannedMeetingParticipants = deliveryMode === "live_online" || deliveryMode === "hybrid"
      ? Number(input?.plannedMeetingParticipants ?? current.planned_meeting_participants ?? 0) : 0;
    const capacity = input?.capacity === undefined ? (current.capacity === null ? null : Number(current.capacity))
      : input.capacity === null || input.capacity === "" ? null : Number(input.capacity);
    const plannedPaidLearners = Number(input?.plannedPaidLearners ?? current.planned_paid_learners ?? capacity ?? 1);
    const pickDate = (key: string, currentValue: unknown) => input?.[key] === undefined
      ? (typeof currentValue === "string" ? currentValue : null)
      : typeof input[key] === "string" && input[key] ? String(input[key]) : null;
    const startsAt = pickDate("startsAt", current.starts_at);
    const endsAt = pickDate("endsAt", current.ends_at);
    const enrolmentOpensAt = pickDate("enrolmentOpensAt", current.enrolment_opens_at);
    const enrolmentClosesAt = pickDate("enrolmentClosesAt", current.enrolment_closes_at);
    const accessEndsAt = pickDate("accessEndsAt", current.access_ends_at);
    const timezone = input?.timezone === undefined ? String(current.timezone ?? "Asia/Singapore")
      : typeof input.timezone === "string" ? input.timezone.trim().slice(0, 80) : "";
    const dates = [startsAt, endsAt, enrolmentOpensAt, enrolmentClosesAt, accessEndsAt].filter((value): value is string => Boolean(value));
    if (!title || !deliveryMode || !timezone || !Number.isSafeInteger(creatorPriceCents) ||
        (capacity !== null && (!Number.isInteger(capacity) || capacity < 1)) ||
        dates.some((value) => !Number.isFinite(Date.parse(value))) ||
        (startsAt && endsAt && Date.parse(endsAt) <= Date.parse(startsAt)) ||
        (enrolmentOpensAt && enrolmentClosesAt && Date.parse(enrolmentClosesAt) <= Date.parse(enrolmentOpensAt))) {
      return problem(400, "invalid_offering", "Provide a valid title, price, schedule, booking window, timezone and capacity.");
    }
    let pricing;
    try {
      pricing = calculateOfferingPrice(env, creatorPriceCents, plannedMeetingMinutes, plannedMeetingParticipants, plannedPaidLearners);
    } catch (error) {
      return problem(400, "invalid_offering_price", error instanceof Error ? error.message : "The offering price is invalid.");
    }
    const now = new Date().toISOString();
    await env.DB.prepare(
      `UPDATE course_offerings SET title = ?, enrolment_opens_at = ?, enrolment_closes_at = ?,
       access_ends_at = ?, price_cents = ?, creator_price_cents = ?, platform_fixed_fee_cents = ?,
       service_fee_bps = ?, service_fee_cents = ?, planned_meeting_minutes = ?,
       planned_meeting_participants = ?, planned_paid_learners = ?, planned_meeting_cost_cents = ?,
       pricing_status = 'pending', delivery_mode = ?, starts_at = ?, ends_at = ?, timezone = ?, capacity = ?, updated_at = ?
       WHERE id = ?`
    ).bind(title, enrolmentOpensAt, enrolmentClosesAt, accessEndsAt, pricing.checkoutPriceCents,
      pricing.creatorPriceCents, pricing.platformFixedFeeCents, pricing.serviceFeeBps,
      pricing.serviceFeeCents, pricing.plannedMeetingMinutes, pricing.plannedMeetingParticipants,
      pricing.plannedPaidLearners, pricing.plannedMeetingCostCents, deliveryMode,
      startsAt, endsAt, timezone, capacity, now, offeringId).run();
    return json({ offering: { id: offeringId, courseId: current.course_id, title, deliveryMode, startsAt, endsAt,
      enrolmentOpensAt, enrolmentClosesAt, accessEndsAt, timezone, capacity,
      priceCents: pricing.checkoutPriceCents, pricing, status: "draft" } });
  }
  const sessionUpdateMatch = pathname.match(/^\/api\/tutor\/sessions\/([^/]+)$/);
  if (request.method === "PATCH" && sessionUpdateMatch) {
    const sessionId = decodeURIComponent(sessionUpdateMatch[1]);
    const current = await env.DB.prepare(
      `SELECT s.*, o.status AS offering_status, o.planned_meeting_minutes, o.planned_meeting_participants,
        c.id AS course_id, c.title AS course_title, c.tutor_id, v.name AS venue_name,
        v.address_line_1 AS venue_address, v.city, v.arrival_instructions
       FROM course_sessions s JOIN course_offerings o ON o.id = s.course_offering_id
       JOIN courses c ON c.id = o.course_id LEFT JOIN venues v ON v.id = s.venue_id
       WHERE s.id = ? AND (c.tutor_id = ? OR ? = 'admin')`
    ).bind(sessionId, actor.id, actor.role).first<Record<string, unknown>>();
    if (!current) return problem(403, "session_forbidden", "You cannot edit this course session.");
    if (current.status !== "scheduled" || Date.parse(String(current.ends_at)) <= Date.now()) {
      return problem(409, "scheduled_session_required", "Only upcoming scheduled sessions can be changed.");
    }
    const input = await parseJson(request);
    const deliveryMode = String(current.delivery_mode);
    if (input?.deliveryMode !== undefined && input.deliveryMode !== deliveryMode) {
      return problem(409, "session_delivery_locked", "Create a new session to change between online and in-person delivery.");
    }
    const title = input?.title === undefined ? String(current.title) : text(input.title, 2, 160);
    const startsAt = input?.startsAt === undefined ? String(current.starts_at) : String(input.startsAt ?? "");
    const endsAt = input?.endsAt === undefined ? String(current.ends_at) : String(input.endsAt ?? "");
    const timezone = input?.timezone === undefined ? String(current.timezone ?? "Asia/Singapore")
      : typeof input.timezone === "string" ? input.timezone.trim().slice(0, 80) : "";
    const capacity = input?.capacity === undefined ? (current.capacity === null ? null : Number(current.capacity))
      : input.capacity === null || input.capacity === "" ? null : Number(input.capacity);
    const venueName = input?.venueName === undefined ? String(current.venue_name ?? "") : text(input.venueName, 2, 160);
    const venueAddress = input?.venueAddress === undefined ? String(current.venue_address ?? "") : text(input.venueAddress, 3, 300);
    const city = input?.city === undefined ? String(current.city ?? "Singapore") : text(input.city, 1, 120);
    const arrivalInstructions = input?.arrivalInstructions === undefined ? String(current.arrival_instructions ?? "")
      : typeof input.arrivalInstructions === "string" ? input.arrivalInstructions.slice(0, 1000) : "";
    if (!title || !timezone || !Number.isFinite(Date.parse(startsAt)) || !Number.isFinite(Date.parse(endsAt)) ||
        Date.parse(endsAt) <= Date.parse(startsAt) ||
        (capacity !== null && (!Number.isInteger(capacity) || capacity < 1)) ||
        (deliveryMode === "in_person" && (!venueName || !venueAddress))) {
      return problem(400, "invalid_session", "Provide a valid title, schedule, timezone, capacity and venue.");
    }
    if (deliveryMode === "live_online") {
      const durationMinutes = Math.ceil((Date.parse(endsAt) - Date.parse(startsAt)) / 60_000);
      const existing = await env.DB.prepare(
        `SELECT COALESCE(SUM((julianday(ends_at) - julianday(starts_at)) * 1440), 0) AS minutes
         FROM course_sessions WHERE course_offering_id = ? AND id != ? AND delivery_mode = 'live_online' AND status != 'cancelled'`
      ).bind(current.course_offering_id, sessionId).first<{ minutes: number }>();
      if (Number(current.planned_meeting_minutes) <= 0 || Number(existing?.minutes ?? 0) + durationMinutes > Number(current.planned_meeting_minutes) + 1) {
        return problem(409, "meeting_plan_exceeded", "This schedule exceeds the live minutes included in the draft offer price.");
      }
      if (capacity && Number(current.planned_meeting_participants) > 0 && capacity + 1 > Number(current.planned_meeting_participants)) {
        return problem(409, "meeting_participants_exceeded", "Session capacity exceeds the participant count included in the draft offer price.");
      }
      if (!current.google_calendar_event_id) return problem(409, "google_event_required", "This online session is missing its Google Calendar event.");
      try {
        await updateGoogleMeetForSession(env, {
          ownerUserId: String(current.tutor_id), eventId: String(current.google_calendar_event_id),
          title: `${current.course_title}: ${title}`, description: `PencilScope online class for ${current.course_title}.`,
          startsAt, endsAt, timezone
        });
      } catch (error) {
        return problem(502, "google_meet_update_failed", error instanceof Error ? error.message : "Google Meet could not be updated.");
      }
    }
    const now = new Date().toISOString();
    const statements = [env.DB.prepare(
      `UPDATE course_sessions SET title = ?, starts_at = ?, ends_at = ?, timezone = ?, capacity = ?, updated_at = ? WHERE id = ?`
    ).bind(title, startsAt, endsAt, timezone, capacity, now, sessionId)];
    if (deliveryMode === "in_person" && current.venue_id) {
      statements.push(env.DB.prepare(
        `UPDATE venues SET name = ?, address_line_1 = ?, city = ?, arrival_instructions = ?, updated_at = ? WHERE id = ?`
      ).bind(venueName, venueAddress, city, arrivalInstructions, now, current.venue_id));
    }
    await env.DB.batch(statements);
    return json({ session: { id: sessionId, offeringId: current.course_offering_id, title, deliveryMode,
      startsAt, endsAt, timezone, capacity, ...(deliveryMode === "in_person" ? { venueName, venueAddress, city, arrivalInstructions } : {}) } });
  }
  if (request.method === "DELETE" && sessionUpdateMatch) {
    const sessionId = decodeURIComponent(sessionUpdateMatch[1]);
    const current = await env.DB.prepare(
      `SELECT s.*, o.status AS offering_status, c.id AS course_id, c.tutor_id
       FROM course_sessions s JOIN course_offerings o ON o.id = s.course_offering_id
       JOIN courses c ON c.id = o.course_id
       WHERE s.id = ? AND (c.tutor_id = ? OR ? = 'admin')`
    ).bind(sessionId, actor.id, actor.role).first<Record<string, unknown>>();
    if (!current) return problem(403, "session_forbidden", "You cannot remove this course session.");
    if (current.status !== "scheduled" || Date.parse(String(current.ends_at)) <= Date.now()) {
      return problem(409, "scheduled_session_required", "Only upcoming scheduled sessions can be removed.");
    }
    if (current.google_calendar_event_id) {
      try {
        await deleteGoogleMeetForSession(env, {
          ownerUserId: String(current.tutor_id), eventId: String(current.google_calendar_event_id)
        });
      } catch (error) {
        return problem(502, "google_meet_delete_failed", error instanceof Error ? error.message : "Google Meet could not be removed.");
      }
    }
    const now = new Date().toISOString();
    const statements = [env.DB.prepare(
      `INSERT INTO audit_logs
        (id, actor_user_id, action, entity_type, entity_id, metadata_json, created_at)
       VALUES (?, ?, ?, 'course_session', ?, ?, ?)`
    ).bind(
      crypto.randomUUID(), actor.id,
      current.offering_status === "draft" ? "course.session_deleted" : "course.session_cancelled",
      sessionId, JSON.stringify({ courseId: current.course_id, offeringId: current.course_offering_id }), now
    )];
    if (current.offering_status === "draft") {
      statements.unshift(env.DB.prepare("UPDATE lessons SET course_session_id = NULL WHERE course_session_id = ?").bind(sessionId));
      statements.push(env.DB.prepare("DELETE FROM course_sessions WHERE id = ?").bind(sessionId));
      if (current.venue_id) statements.push(env.DB.prepare("DELETE FROM venues WHERE id = ?").bind(current.venue_id));
    } else {
      statements.unshift(env.DB.prepare(
        "UPDATE course_sessions SET status = 'cancelled', meeting_url = NULL, updated_at = ? WHERE id = ?"
      ).bind(now, sessionId));
    }
    await env.DB.batch(statements);
    return json({ deleted: current.offering_status === "draft", cancelled: current.offering_status !== "draft", sessionId });
  }
  const courseOfferingMatch = pathname.match(/^\/api\/tutor\/courses\/([^/]+)\/offerings$/);
  if (request.method === "POST" && courseOfferingMatch) {
    const courseId = decodeURIComponent(courseOfferingMatch[1]);
    const owned = await env.DB.prepare(
      "SELECT 1 FROM courses WHERE id = ? AND (tutor_id = ? OR ? = 'admin')"
    ).bind(courseId, actor.id, actor.role).first();
    if (!owned) return problem(403, "course_forbidden", "You cannot edit this course.");
    const input = await parseJson(request);
    const offeringType = ["self_paced", "cohort", "event", "academic_term"].includes(String(input?.offeringType))
      ? String(input?.offeringType) : "self_paced";
    const deliveryMode = ["recorded", "live_online", "in_person", "hybrid"].includes(String(input?.deliveryMode))
      ? String(input?.deliveryMode) : "recorded";
    const academicYear = Number(input?.academicYear);
    const termNumber = Number(input?.termNumber);
    const title = text(input?.title, 2, 120);
    const creatorPriceCents = Number(input?.priceCents);
    const plannedMeetingMinutes = deliveryMode === "live_online" || deliveryMode === "hybrid"
      ? Number(input?.plannedMeetingMinutes ?? 0) : 0;
    const plannedMeetingParticipants = deliveryMode === "live_online" || deliveryMode === "hybrid"
      ? Number(input?.plannedMeetingParticipants ?? 0) : 0;
    const startsAt = typeof input?.startsAt === "string" && input.startsAt ? input.startsAt : null;
    const endsAt = typeof input?.endsAt === "string" && input.endsAt ? input.endsAt : null;
    const capacity = input?.capacity === null || input?.capacity === "" || input?.capacity === undefined
      ? null : Number(input.capacity);
    const plannedPaidLearners = Number(input?.plannedPaidLearners ?? capacity ?? 1);
    const learningProductIds = Array.isArray(input?.learningProductIds)
      ? [...new Set(input.learningProductIds.map(String).filter(Boolean))] : [];
    if (!title || !Number.isSafeInteger(creatorPriceCents) ||
        (capacity !== null && (!Number.isInteger(capacity) || capacity < 1)) ||
        ((offeringType === "cohort" || offeringType === "event") && (!startsAt || !endsAt)) ||
        (startsAt && endsAt && new Date(endsAt).getTime() <= new Date(startsAt).getTime()) ||
        (offeringType === "academic_term" && (!Number.isInteger(academicYear) || academicYear < 2000 || academicYear > 2200 ||
          !Number.isInteger(termNumber) || termNumber < 1 || termNumber > 12))) {
      return problem(400, "invalid_offering", "Provide a valid offering type, schedule, title, capacity, and price.");
    }
    if (learningProductIds.length) {
      const placeholders = learningProductIds.map(() => "?").join(",");
      const ownedProducts = await env.DB.prepare(
        `SELECT COUNT(*) AS total FROM learning_products
         WHERE creator_id = ? AND status != 'archived' AND id IN (${placeholders})`
      ).bind(actor.id, ...learningProductIds).first<{ total: number }>();
      if (Number(ownedProducts?.total ?? 0) !== learningProductIds.length) {
        return problem(400, "invalid_bundle_products", "Choose active learning products you own.");
      }
    }
    let pricing;
    try {
      pricing = calculateOfferingPrice(
        env, creatorPriceCents, plannedMeetingMinutes,
        plannedMeetingParticipants, plannedPaidLearners
      );
    } catch (error) {
      return problem(400, "invalid_offering_price", error instanceof Error ? error.message : "The offering price is invalid.");
    }
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const isAcademic = offeringType === "academic_term";
    const internalYear = isAcademic ? academicYear : 3_000_000_000 + Number.parseInt(id.replace(/-/g, "").slice(0, 7), 16);
    const internalTerm = isAcademic ? termNumber : 0;
    const termId = isAcademic ? `academic-term-${academicYear}-${termNumber}` : `academic-term-general-${id}`;
    const accessEndsAt = typeof input?.accessEndsAt === "string" && input.accessEndsAt ? input.accessEndsAt : endsAt;
    const offeringStatements = [
      env.DB.prepare(
        `INSERT INTO academic_terms (id, academic_year, term_number, title, starts_at, ends_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(academic_year, term_number) DO NOTHING`
      ).bind(termId, internalYear, internalTerm, isAcademic ? `Term ${termNumber}` : "Not applicable", startsAt, endsAt, now),
      env.DB.prepare(
        `INSERT INTO course_offerings
          (id, course_id, academic_term_id, title, enrolment_opens_at, enrolment_closes_at,
           access_ends_at, price_cents, creator_price_cents, platform_fixed_fee_cents,
           service_fee_bps, service_fee_cents, planned_meeting_minutes,
           planned_meeting_participants, planned_paid_learners, planned_meeting_cost_cents,
           currency, pricing_version, pricing_status, status,
           offering_type, delivery_mode, starts_at, ends_at, timezone, capacity, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'SGD', 1, 'pending', 'draft', ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        id, courseId, termId, title,
        typeof input?.enrolmentOpensAt === "string" && input.enrolmentOpensAt ? input.enrolmentOpensAt : null,
        typeof input?.enrolmentClosesAt === "string" && input.enrolmentClosesAt ? input.enrolmentClosesAt : null,
        accessEndsAt, pricing.checkoutPriceCents, pricing.creatorPriceCents,
        pricing.platformFixedFeeCents, pricing.serviceFeeBps, pricing.serviceFeeCents,
        pricing.plannedMeetingMinutes, pricing.plannedMeetingParticipants,
        pricing.plannedPaidLearners, pricing.plannedMeetingCostCents,
        offeringType, deliveryMode, startsAt, endsAt,
        typeof input?.timezone === "string" && input.timezone ? input.timezone.slice(0, 80) : "Asia/Singapore",
        capacity, now, now
      )
    ];
    learningProductIds.forEach((productId, index) => offeringStatements.push(env.DB.prepare(
      `INSERT INTO course_offering_learning_products
        (course_offering_id, learning_product_id, position) VALUES (?, ?, ?)`
    ).bind(id, productId, index + 1)));
    await env.DB.batch(offeringStatements);
    return json({ offering: {
      id, courseId, title, offeringType, deliveryMode,
      academicYear: isAcademic ? academicYear : null,
      termNumber: isAcademic ? termNumber : null,
      startsAt, endsAt, capacity, priceCents: pricing.checkoutPriceCents,
      pricing, status: "draft"
    } }, { status: 201 });
  }

  const sessionMatch = pathname.match(/^\/api\/tutor\/offerings\/([^/]+)\/sessions$/);
  if (request.method === "POST" && sessionMatch) {
    const offeringId = decodeURIComponent(sessionMatch[1]);
    const owned = await env.DB.prepare(
      `SELECT o.course_id, o.planned_meeting_minutes, o.planned_meeting_participants,
        c.tutor_id, c.title AS course_title
       FROM course_offerings o JOIN courses c ON c.id = o.course_id
       LEFT JOIN course_members cm ON cm.course_id = c.id AND cm.user_id = ? AND cm.status = 'active'
       WHERE o.id = ? AND (c.tutor_id = ? OR ? = 'admin'
         OR cm.member_role IN ('owner', 'administrator', 'instructor', 'facilitator'))`
    ).bind(actor.id, offeringId, actor.id, actor.role).first<{
      course_id: string; tutor_id: string; course_title: string;
      planned_meeting_minutes: number; planned_meeting_participants: number;
    }>();
    if (!owned) return problem(403, "offering_forbidden", "You cannot edit this offering.");
    const input = await parseJson(request);
    const title = text(input?.title, 2, 160);
    const deliveryMode = input?.deliveryMode === "in_person" ? "in_person"
      : input?.deliveryMode === "live_online" ? "live_online" : null;
    const startsAt = typeof input?.startsAt === "string" ? input.startsAt : "";
    const endsAt = typeof input?.endsAt === "string" ? input.endsAt : "";
    const requestedInstructorId = typeof input?.instructorId === "string" && input.instructorId
      ? input.instructorId : actor.id;
    const venueName = text(input?.venueName, 2, 160);
    const venueAddress = text(input?.venueAddress, 3, 300);
    const capacity = input?.capacity === null || input?.capacity === "" || input?.capacity === undefined
      ? null : Number(input.capacity);
    if (!title || !deliveryMode || !startsAt || !endsAt ||
        new Date(endsAt).getTime() <= new Date(startsAt).getTime() ||
        (capacity !== null && (!Number.isInteger(capacity) || capacity < 1)) ||
        (deliveryMode === "in_person" && (!venueName || !venueAddress))) {
      return problem(400, "invalid_session", "Provide a valid live or in-person session, schedule, and location.");
    }
    const instructor = await env.DB.prepare(
      `SELECT 1 FROM courses c LEFT JOIN course_members cm
        ON cm.course_id = c.id AND cm.user_id = ? AND cm.status = 'active'
       WHERE c.id = ? AND (c.tutor_id = ? OR cm.member_role IN ('owner', 'administrator', 'instructor', 'facilitator'))`
    ).bind(requestedInstructorId, owned.course_id, requestedInstructorId).first();
    if (!instructor) return problem(400, "invalid_instructor", "Choose an active instructor from this course team.");
    const now = new Date().toISOString();
    const sessionId = crypto.randomUUID();
    const venueId = deliveryMode === "in_person" ? crypto.randomUUID() : null;
    const timezone = typeof input?.timezone === "string" && input.timezone ? input.timezone.slice(0, 80) : "Asia/Singapore";
    let googleMeeting: { eventId: string; meetingUrl: string; meetingCode: string | null } | null = null;
    if (deliveryMode === "live_online") {
      const durationMinutes = Math.ceil((new Date(endsAt).getTime() - new Date(startsAt).getTime()) / 60_000);
      const existingDuration = await env.DB.prepare(
        `SELECT COALESCE(SUM((julianday(ends_at) - julianday(starts_at)) * 1440), 0) AS minutes
         FROM course_sessions WHERE course_offering_id = ? AND delivery_mode = 'live_online' AND status != 'cancelled'`
      ).bind(offeringId).first<{ minutes: number }>();
      if (owned.planned_meeting_minutes <= 0 || Number(existingDuration?.minutes ?? 0) + durationMinutes > owned.planned_meeting_minutes + 1) {
        return problem(409, "meeting_plan_exceeded", "This session exceeds the live minutes included in the published price. Create a new offering price plan first.");
      }
      if (capacity && owned.planned_meeting_participants > 0 && capacity + 1 > owned.planned_meeting_participants) {
        return problem(409, "meeting_participants_exceeded", "Session capacity exceeds the participant count included in the published price.");
      }
      const attendeeRows = await env.DB.prepare(
        `SELECT DISTINCT u.email FROM enrolment_offerings eo
         JOIN users u ON u.id = eo.student_user_id AND u.status = 'active'
         WHERE eo.course_offering_id = ? AND eo.status = 'active'
         UNION SELECT email FROM users WHERE id = ? AND id != ?`
      ).bind(offeringId, requestedInstructorId, owned.tutor_id).all<{ email: string }>();
      try {
        googleMeeting = await createGoogleMeetForSession(env, {
          ownerUserId: owned.tutor_id,
          title: `${owned.course_title}: ${title}`,
          description: `PencilScope online class for ${owned.course_title}.`,
          startsAt, endsAt, timezone,
          attendeeEmails: attendeeRows.results.map((row) => row.email)
        });
      } catch (error) {
        return problem(502, "google_meet_creation_failed", error instanceof Error ? error.message : "Google Meet could not be created.");
      }
    }
    const statements = [];
    if (venueId) {
      statements.push(env.DB.prepare(
        `INSERT INTO venues
          (id, owner_user_id, name, address_line_1, city, country_code, arrival_instructions, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'SG', ?, ?, ?)`
      ).bind(
        venueId, actor.id, venueName, venueAddress,
        typeof input?.city === "string" && input.city.trim() ? input.city.trim().slice(0, 120) : "Singapore",
        typeof input?.arrivalInstructions === "string" ? input.arrivalInstructions.slice(0, 1000) : "", now, now
      ));
    }
    statements.push(env.DB.prepare(
      `INSERT INTO course_sessions
        (id, course_offering_id, instructor_user_id, title, delivery_mode, starts_at, ends_at,
         timezone, capacity, meeting_url, meeting_provider, venue_id,
         google_calendar_event_id, google_meet_code, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'scheduled', ?, ?)`
    ).bind(
      sessionId, offeringId, requestedInstructorId, title, deliveryMode, startsAt, endsAt,
      timezone, capacity, googleMeeting?.meetingUrl ?? null,
      deliveryMode === "live_online" ? "google_meet" : null,
      venueId, googleMeeting?.eventId ?? null, googleMeeting?.meetingCode ?? null, now, now
    ));
    await env.DB.batch(statements);
    return json({ session: { id: sessionId, offeringId, title, deliveryMode, startsAt, endsAt } }, { status: 201 });
  }
  const courseModuleMatch = pathname.match(/^\/api\/tutor\/courses\/([^/]+)\/modules$/);
  if (request.method === "POST" && courseModuleMatch) {
    const input = await parseJson(request);
    const courseId = decodeURIComponent(courseModuleMatch[1]);
    const owned = await env.DB.prepare(
      `SELECT 1 FROM courses WHERE id = ? AND (tutor_id = ? OR ? = 'admin' OR EXISTS (
        SELECT 1 FROM course_members cm WHERE cm.course_id = courses.id AND cm.user_id = ?
          AND cm.status = 'active' AND cm.member_role IN ('owner', 'administrator', 'editor')
      ))`
    ).bind(courseId, actor.id, actor.role, actor.id).first();
    if (!owned) return problem(403, "course_forbidden", "You cannot edit this course.");
    const title = text(input?.title, 2, 120);
    if (!title) return problem(400, "invalid_module", "Module title is required.");
    const id = crypto.randomUUID();
    const position = Number.isInteger(input?.position) ? Number(input?.position) : 1;
    const statements = [env.DB.prepare(
      "INSERT INTO course_modules (id, course_id, title, position, created_at) VALUES (?, ?, ?, ?, ?)"
    ).bind(id, courseId, title, position, new Date().toISOString())];
    if (typeof input?.offeringId === "string" && input.offeringId) {
      statements.push(env.DB.prepare(
        `INSERT INTO course_offering_modules (course_offering_id, module_id, position)
         SELECT id, ?, ? FROM course_offerings WHERE id = ? AND course_id = ?`
      ).bind(id, position, input.offeringId, courseId));
    }
    await env.DB.batch(statements);
    return json({ module: { id, courseId, title, position } }, { status: 201 });
  }

  const moduleUpdateMatch = pathname.match(/^\/api\/tutor\/modules\/([^/]+)$/);
  if ((request.method === "PATCH" || request.method === "DELETE") && moduleUpdateMatch) {
    const moduleId = decodeURIComponent(moduleUpdateMatch[1]);
    const current = await env.DB.prepare(
      `SELECT m.id, m.course_id, m.title, m.position,
        EXISTS(SELECT 1 FROM course_offering_modules om
          JOIN course_offerings o ON o.id = om.course_offering_id
          WHERE om.module_id = m.id AND o.status = 'published') AS published
       FROM course_modules m JOIN courses c ON c.id = m.course_id
       WHERE m.id = ? AND (c.tutor_id = ? OR ? = 'admin' OR EXISTS (
         SELECT 1 FROM course_members cm WHERE cm.course_id = c.id AND cm.user_id = ?
           AND cm.status = 'active' AND cm.member_role IN ('owner', 'administrator', 'editor')
       ))`
    ).bind(moduleId, actor.id, actor.role, actor.id).first<{
      id: string; course_id: string; title: string; position: number; published: number;
    }>();
    if (!current) return problem(403, "module_forbidden", "You cannot edit this module.");
    if (current.published) {
      return problem(409, "published_module_locked", "This module is included in a published offer. Create a new course version before changing it.");
    }
    const now = new Date().toISOString();
    if (request.method === "PATCH") {
      const input = await parseJson(request);
      const title = input?.title === undefined ? current.title : text(input.title, 2, 120);
      const position = input?.position === undefined ? current.position : Number(input.position);
      if (!title || !Number.isInteger(position) || position < 1) {
        return problem(400, "invalid_module", "Provide a module title and a valid position.");
      }
      await env.DB.batch([
        env.DB.prepare("UPDATE course_modules SET title = ?, position = ? WHERE id = ?").bind(title, position, moduleId),
        env.DB.prepare("UPDATE course_offering_modules SET position = ? WHERE module_id = ?").bind(position, moduleId),
        env.DB.prepare("UPDATE courses SET updated_at = ? WHERE id = ?").bind(now, current.course_id),
        env.DB.prepare(
          `INSERT INTO audit_logs (id, actor_user_id, action, entity_type, entity_id, metadata_json, created_at)
           VALUES (?, ?, 'course.module_updated', 'course_module', ?, ?, ?)`
        ).bind(crypto.randomUUID(), actor.id, moduleId, JSON.stringify({ courseId: current.course_id }), now)
      ]);
      return json({ module: { id: moduleId, courseId: current.course_id, title, position } });
    }
    const lessonCount = await env.DB.prepare("SELECT COUNT(*) AS count FROM lessons WHERE module_id = ?")
      .bind(moduleId).first<{ count: number }>();
    await env.DB.batch([
      env.DB.prepare("DELETE FROM course_modules WHERE id = ?").bind(moduleId),
      env.DB.prepare("UPDATE courses SET updated_at = ? WHERE id = ?").bind(now, current.course_id),
      env.DB.prepare(
        `INSERT INTO audit_logs (id, actor_user_id, action, entity_type, entity_id, metadata_json, created_at)
         VALUES (?, ?, 'course.module_deleted', 'course_module', ?, ?, ?)`
      ).bind(crypto.randomUUID(), actor.id, moduleId, JSON.stringify({ courseId: current.course_id, lessonCount: Number(lessonCount?.count ?? 0) }), now)
    ]);
    return json({ deleted: true, moduleId, lessonCount: Number(lessonCount?.count ?? 0) });
  }

  const lessonMatch = pathname.match(/^\/api\/tutor\/modules\/([^/]+)\/lessons$/);
  if (request.method === "POST" && lessonMatch) {
    const input = await parseJson(request);
    const moduleId = decodeURIComponent(lessonMatch[1]);
    const owned = await env.DB.prepare(
      `SELECT 1 FROM course_modules m JOIN courses c ON c.id = m.course_id
       WHERE m.id = ? AND (c.tutor_id = ? OR ? = 'admin' OR EXISTS (
         SELECT 1 FROM course_members cm WHERE cm.course_id = c.id AND cm.user_id = ?
           AND cm.status = 'active' AND cm.member_role IN ('owner', 'administrator', 'editor')
       ))`
    ).bind(moduleId, actor.id, actor.role, actor.id).first();
    if (!owned) return problem(403, "module_forbidden", "You cannot edit this module.");
    const title = text(input?.title, 2, 120);
    const lessonType = ["video", "text", "document", "quiz", "live", "ai"].includes(String(input?.lessonType))
      ? String(input?.lessonType) : null;
    const deliveryMode = ["recorded", "live_online", "in_person"].includes(String(input?.deliveryMode))
      ? String(input?.deliveryMode) : lessonType === "live" ? "live_online" : "recorded";
    if (!title || !lessonType) return problem(400, "invalid_lesson", "Lesson title and type are required.");
    const rawContent = input?.content && typeof input.content === "object"
      ? input.content as Record<string, unknown> : {};
    const summary = typeof rawContent.summary === "string" ? rawContent.summary.trim().slice(0, 1000) : "";
    const videoUrl = typeof rawContent.videoUrl === "string" ? rawContent.videoUrl.trim().slice(0, 2000) : "";
    if (lessonType === "video" && videoUrl) {
      try {
        const parsed = new URL(videoUrl);
        if (parsed.protocol !== "https:") throw new Error("invalid");
      } catch {
        return problem(400, "invalid_video_url", "Use a secure HTTPS video URL.");
      }
    }
    const sessionId = typeof input?.sessionId === "string" && input.sessionId ? input.sessionId : null;
    if (sessionId) {
      const validSession = await env.DB.prepare(
        `SELECT 1 FROM course_sessions s
         JOIN course_offerings o ON o.id = s.course_offering_id
         JOIN course_modules m ON m.course_id = o.course_id
         WHERE s.id = ? AND m.id = ? AND s.delivery_mode = ?`
      ).bind(sessionId, moduleId, deliveryMode).first();
      if (!validSession) return problem(400, "invalid_lesson_session", "Choose a session from this course with the same delivery mode.");
    }
    const id = crypto.randomUUID();
    const position = Number.isInteger(input?.position) ? Number(input?.position) : 1;
    const now = new Date().toISOString();
    await env.DB.prepare(
      `INSERT INTO lessons
        (id, module_id, title, lesson_type, content_json, position, estimated_minutes,
         delivery_mode, course_session_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      id,
      moduleId,
      title,
      lessonType,
      JSON.stringify({ summary, ...(videoUrl ? { videoUrl } : {}) }),
      position,
      Number(input?.estimatedMinutes ?? 0) || null,
      deliveryMode,
      sessionId,
      now,
      now
    ).run();
    return json({ lesson: { id, moduleId, title, lessonType, deliveryMode, position } }, { status: 201 });
  }

  const assessmentMatch = pathname.match(/^\/api\/tutor\/courses\/([^/]+)\/assessments$/);
  if (request.method === "POST" && assessmentMatch) {
    const input = await parseJson(request);
    const courseId = decodeURIComponent(assessmentMatch[1]);
    const owned = await env.DB.prepare(
      `SELECT 1 FROM courses WHERE id = ? AND (tutor_id = ? OR ? = 'admin' OR EXISTS (
        SELECT 1 FROM course_members cm WHERE cm.course_id = courses.id AND cm.user_id = ?
          AND cm.status = 'active' AND cm.member_role IN ('owner', 'administrator', 'editor')
      ))`
    ).bind(courseId, actor.id, actor.role, actor.id).first();
    if (!owned) return problem(403, "course_forbidden", "You cannot edit this course.");
    const title = text(input?.title, 2, 160);
    const assessmentType = ["quiz", "test", "mock_exam"].includes(String(input?.assessmentType))
      ? String(input?.assessmentType) : null;
    if (!title || !assessmentType) {
      return problem(400, "invalid_assessment", "Assessment title and type are required.");
    }
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const statements = [env.DB.prepare(
      `INSERT INTO assessments
        (id, course_id, lesson_id, created_by, assessment_type, title, instructions,
         time_limit_seconds, attempt_limit, passing_score, feedback_mode, status,
         version, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', 1, ?, ?)`
    ).bind(
      id,
      courseId,
      typeof input?.lessonId === "string" ? input.lessonId : null,
      actor.id,
      assessmentType,
      title,
      typeof input?.instructions === "string" ? input.instructions.slice(0, 5000) : "",
      Number(input?.timeLimitSeconds ?? 0) || null,
      Number(input?.attemptLimit ?? 0) || null,
      Math.max(0, Math.min(100, Number(input?.passingScore ?? 50))),
      input?.feedbackMode === "after_close" ? "after_close"
        : input?.feedbackMode === "after_submission" ? "after_submission" : "immediate",
      now,
      now
    )];
    if (typeof input?.offeringId === "string" && input.offeringId) {
      statements.push(env.DB.prepare(
        `INSERT INTO course_offering_assessments (course_offering_id, assessment_id, position)
         SELECT id, ?, 1 FROM course_offerings WHERE id = ? AND course_id = ?`
      ).bind(id, input.offeringId, courseId));
    }
    await env.DB.batch(statements);
    return json({ assessment: { id, courseId, title, assessmentType, status: "draft" } }, { status: 201 });
  }

  const deckMatch = pathname.match(/^\/api\/tutor\/courses\/([^/]+)\/flashcard-decks$/);
  if (request.method === "POST" && deckMatch) {
    const input = await parseJson(request);
    const courseId = decodeURIComponent(deckMatch[1]);
    const owned = await env.DB.prepare(
      `SELECT 1 FROM courses WHERE id = ? AND (tutor_id = ? OR ? = 'admin' OR EXISTS (
        SELECT 1 FROM course_members cm WHERE cm.course_id = courses.id AND cm.user_id = ?
          AND cm.status = 'active' AND cm.member_role IN ('owner', 'administrator', 'editor')
      ))`
    ).bind(courseId, actor.id, actor.role, actor.id).first();
    if (!owned) return problem(403, "course_forbidden", "You cannot edit this course.");
    const title = text(input?.title, 2, 160);
    if (!title) return problem(400, "invalid_deck", "Flashcard deck title is required.");
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const statements = [env.DB.prepare(
      `INSERT INTO flashcard_decks
        (id, course_id, lesson_id, created_by, title, description, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'draft', ?, ?)`
    ).bind(
      id,
      courseId,
      typeof input?.lessonId === "string" ? input.lessonId : null,
      actor.id,
      title,
      typeof input?.description === "string" ? input.description.slice(0, 2000) : "",
      now,
      now
    )];
    if (typeof input?.offeringId === "string" && input.offeringId) {
      statements.push(env.DB.prepare(
        `INSERT INTO course_offering_flashcard_decks (course_offering_id, deck_id, position)
         SELECT id, ?, 1 FROM course_offerings WHERE id = ? AND course_id = ?`
      ).bind(id, input.offeringId, courseId));
    }
    await env.DB.batch(statements);
    return json({ deck: { id, courseId, title, status: "draft" } }, { status: 201 });
  }

  const materialMatch = pathname.match(/^\/api\/tutor\/courses\/([^/]+)\/materials$/);
  if (request.method === "POST" && materialMatch) {
    const courseId = decodeURIComponent(materialMatch[1]);
    const owned = await env.DB.prepare(
      `SELECT 1 FROM courses WHERE id = ? AND (tutor_id = ? OR ? = 'admin' OR EXISTS (
        SELECT 1 FROM course_members cm WHERE cm.course_id = courses.id AND cm.user_id = ?
          AND cm.status = 'active' AND cm.member_role IN ('owner', 'administrator', 'editor')
      ))`
    ).bind(courseId, actor.id, actor.role, actor.id).first();
    if (!owned) return problem(403, "course_forbidden", "You cannot edit this course.");
    const input = await parseJson(request);
    const title = text(input?.title, 2, 160);
    const materialType = ["document", "video", "link", "download"].includes(String(input?.materialType))
      ? String(input?.materialType) : null;
    const resourceKind = ["resource", "ebook", "worksheet", "slides", "reference"].includes(String(input?.resourceKind))
      ? String(input?.resourceKind) : "resource";
    const contentKind = ["resource", "ebook", "reading", "video", "audio"].includes(String(input?.contentKind))
      ? String(input?.contentKind) : resourceKind === "ebook" ? "ebook" : materialType === "video" ? "video" : "resource";
    const storageKey = typeof input?.storageKey === "string" && input.storageKey.trim()
      ? input.storageKey.trim().slice(0, 500) : null;
    let externalUrl: string | null = null;
    if (typeof input?.externalUrl === "string" && input.externalUrl.trim()) {
      try {
        const parsed = new URL(input.externalUrl.trim());
        if (parsed.protocol === "https:" || parsed.protocol === "http:") externalUrl = parsed.toString();
      } catch {
        externalUrl = null;
      }
    }
    if (!title || !materialType || (!storageKey && !externalUrl)) {
      return problem(400, "invalid_material", "Provide a title, material type, and valid URL or R2 storage key.");
    }
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const statements = [env.DB.prepare(
      `INSERT INTO course_materials
        (id, course_id, created_by, title, description, material_type, resource_kind, content_kind, storage_key,
         external_url, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'published', ?, ?)`
    ).bind(
      id, courseId, actor.id, title,
      typeof input?.description === "string" ? input.description.slice(0, 2000) : "",
      materialType, resourceKind, contentKind, storageKey, externalUrl, now, now
    )];
    if (typeof input?.offeringId === "string" && input.offeringId) {
      statements.push(env.DB.prepare(
        `INSERT INTO course_offering_materials (course_offering_id, material_id, position)
         SELECT id, ?, 1 FROM course_offerings WHERE id = ? AND course_id = ?`
      ).bind(id, input.offeringId, courseId));
    }
    await env.DB.batch(statements);
    return json({ material: { id, courseId, title, materialType, resourceKind, status: "published" } }, { status: 201 });
  }

  const assignContentMatch = pathname.match(/^\/api\/tutor\/offerings\/([^/]+)\/content$/);
  if (request.method === "POST" && assignContentMatch) {
    const offeringId = decodeURIComponent(assignContentMatch[1]);
    const input = await parseJson(request);
    const contentId = typeof input?.contentId === "string" ? input.contentId : "";
    const kind = String(input?.kind ?? "");
    const offering = await env.DB.prepare(
      `SELECT o.course_id, o.status FROM course_offerings o JOIN courses c ON c.id = o.course_id
       WHERE o.id = ? AND (c.tutor_id = ? OR ? = 'admin')`
    ).bind(offeringId, actor.id, actor.role).first<{ course_id: string; status: string }>();
    if (!offering) return problem(403, "offering_forbidden", "You cannot edit this course offering.");
    if (offering.status !== "draft") {
      return problem(409, "draft_offering_required", "Published offer contents are locked. Create a new draft offer to change the bundle.");
    }
    if (kind === "learning_product") {
      const belongs = await env.DB.prepare(
        `SELECT 1 FROM learning_products
         WHERE id = ? AND status = 'published' AND (creator_id = ? OR ? = 'admin')`
      ).bind(contentId, actor.id, actor.role).first();
      if (!belongs) return problem(404, "content_not_found", "Choose a published learning product from your creator library.");
      await env.DB.prepare(
        `INSERT OR IGNORE INTO course_offering_learning_products
          (course_offering_id, learning_product_id, position)
         VALUES (?, ?, ?)`
      ).bind(offeringId, contentId, Number(input?.position ?? 1) || 1).run();
      return json({ assigned: true, offeringId, kind, contentId });
    }
    const config = {
      module: { table: "course_offering_modules", column: "module_id", source: "course_modules" },
      material: { table: "course_offering_materials", column: "material_id", source: "course_materials" },
      assessment: { table: "course_offering_assessments", column: "assessment_id", source: "assessments" },
      flashcard_deck: { table: "course_offering_flashcard_decks", column: "deck_id", source: "flashcard_decks" }
    }[kind];
    if (!config || !contentId) return problem(400, "invalid_content", "Choose valid course content.");
    const belongs = await env.DB.prepare(
      `SELECT 1 FROM ${config.source} WHERE id = ? AND course_id = ?`
    ).bind(contentId, offering.course_id).first();
    if (!belongs) return problem(404, "content_not_found", "The content does not belong to this course.");
    await env.DB.prepare(
      `INSERT OR IGNORE INTO ${config.table} (course_offering_id, ${config.column}, position)
       VALUES (?, ?, ?)`
    ).bind(offeringId, contentId, Number(input?.position ?? 1) || 1).run();
    return json({ assigned: true, offeringId, kind, contentId });
  }

  const removeLearningProductMatch = pathname.match(
    /^\/api\/tutor\/offerings\/([^/]+)\/learning-products\/([^/]+)$/
  );
  if (request.method === "DELETE" && removeLearningProductMatch) {
    const offeringId = decodeURIComponent(removeLearningProductMatch[1]);
    const learningProductId = decodeURIComponent(removeLearningProductMatch[2]);
    const offering = await env.DB.prepare(
      `SELECT o.status FROM course_offerings o JOIN courses c ON c.id = o.course_id
       WHERE o.id = ? AND (c.tutor_id = ? OR ? = 'admin')`
    ).bind(offeringId, actor.id, actor.role).first<{ status: string }>();
    if (!offering) return problem(403, "offering_forbidden", "You cannot edit this course offering.");
    if (offering.status !== "draft") {
      return problem(409, "draft_offering_required", "Published offer contents are locked. Create a new draft offer to change the bundle.");
    }
    await env.DB.prepare(
      "DELETE FROM course_offering_learning_products WHERE course_offering_id = ? AND learning_product_id = ?"
    ).bind(offeringId, learningProductId).run();
    return json({ removed: true, offeringId, learningProductId });
  }

  const questionMatch = pathname.match(/^\/api\/tutor\/assessments\/([^/]+)\/questions$/);
  if (request.method === "POST" && questionMatch) {
    const assessmentId = decodeURIComponent(questionMatch[1]);
    const owned = await env.DB.prepare(
      `SELECT 1 FROM assessments a JOIN courses c ON c.id = a.course_id
       WHERE a.id = ? AND (c.tutor_id = ? OR ? = 'admin' OR EXISTS (
         SELECT 1 FROM course_members cm WHERE cm.course_id = c.id AND cm.user_id = ?
           AND cm.status = 'active' AND cm.member_role IN ('owner', 'administrator', 'editor')
       )) AND a.status = 'draft'`
    ).bind(assessmentId, actor.id, actor.role, actor.id).first();
    if (!owned) return problem(403, "assessment_forbidden", "You cannot edit this assessment.");
    const input = await parseJson(request);
    const prompt = text(input?.prompt, 2, 2000);
    const questionType = ["multiple_choice", "true_false", "short_text"].includes(String(input?.questionType))
      ? String(input?.questionType) : "multiple_choice";
    const options = Array.isArray(input?.options) ? input.options : [];
    if (!prompt) return problem(400, "invalid_question", "A question prompt is required.");
    if (questionType !== "short_text") {
      const validOptions = options.filter((option): option is { label: string; isCorrect?: boolean } =>
        Boolean(option) && typeof option === "object" && typeof option.label === "string" && option.label.trim().length > 0
      );
      if (validOptions.length < 2 || validOptions.filter((option) => option.isCorrect === true).length !== 1) {
        return problem(400, "invalid_options", "Choice questions need at least two options and exactly one correct answer.");
      }
      if (questionType === "true_false" && validOptions.length !== 2) {
        return problem(400, "invalid_options", "True or false questions must contain exactly two choices.");
      }
    }
    const questionMedia = await resolveQuestionMedia(env, actor.id, input ?? {});
    if (questionMedia instanceof Response) return questionMedia;
    const id = crypto.randomUUID();
    const lastQuestion = await env.DB.prepare(
      "SELECT COALESCE(MAX(position), 0) AS position FROM assessment_questions WHERE assessment_id = ?"
    ).bind(assessmentId).first<{ position: number }>();
    const position = Number(lastQuestion?.position ?? 0) + 1;
    const statements = [env.DB.prepare(
      `INSERT INTO assessment_questions
        (id, assessment_id, question_type, prompt, explanation, points, position)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      id, assessmentId, questionType, prompt,
      typeof input?.explanation === "string" ? input.explanation.slice(0, 2000) : "",
      Math.max(1, Number(input?.points ?? 1) || 1), position
    )];
    if (questionType !== "short_text") {
      options.forEach((option, index) => {
        if (!option || typeof option !== "object" || typeof option.label !== "string" || !option.label.trim()) return;
        statements.push(env.DB.prepare(
          "INSERT INTO assessment_options (id, question_id, label, is_correct, position) VALUES (?, ?, ?, ?, ?)"
        ).bind(crypto.randomUUID(), id, option.label.trim().slice(0, 500), option.isCorrect === true ? 1 : 0, index + 1));
      });
    }
    if (questionMedia) statements.push(questionMediaInsert(
      env, actor.id, questionMedia, { courseQuestionId: id }, new Date().toISOString()
    ));
    await env.DB.batch(statements);
    return json({ question: { id, assessmentId, prompt, questionType, position } }, { status: 201 });
  }

  const assessmentPublishMatch = pathname.match(/^\/api\/tutor\/assessments\/([^/]+)\/publish$/);
  if (request.method === "POST" && assessmentPublishMatch) {
    const assessmentId = decodeURIComponent(assessmentPublishMatch[1]);
    const result = await env.DB.prepare(
      `UPDATE assessments SET status = 'published', updated_at = ?
       WHERE id = ? AND status = 'draft'
       AND EXISTS (SELECT 1 FROM assessment_questions q WHERE q.assessment_id = assessments.id)
       AND EXISTS (SELECT 1 FROM courses c WHERE c.id = assessments.course_id AND (c.tutor_id = ? OR ? = 'admin'))`
    ).bind(new Date().toISOString(), assessmentId, actor.id, actor.role).run();
    return result.meta.changes
      ? json({ assessment: { id: assessmentId, status: "published" } })
      : problem(409, "assessment_not_publishable", "Add at least one question before publishing.");
  }

  const cardMatch = pathname.match(/^\/api\/tutor\/flashcard-decks\/([^/]+)\/cards$/);
  if (request.method === "POST" && cardMatch) {
    const deckId = decodeURIComponent(cardMatch[1]);
    const owned = await env.DB.prepare(
      `SELECT 1 FROM flashcard_decks d JOIN courses c ON c.id = d.course_id
       WHERE d.id = ? AND (c.tutor_id = ? OR ? = 'admin' OR EXISTS (
         SELECT 1 FROM course_members cm WHERE cm.course_id = c.id AND cm.user_id = ?
           AND cm.status = 'active' AND cm.member_role IN ('owner', 'administrator', 'editor')
       )) AND d.status = 'draft'`
    ).bind(deckId, actor.id, actor.role, actor.id).first();
    if (!owned) return problem(403, "deck_forbidden", "You cannot edit this flashcard deck.");
    const input = await parseJson(request);
    const front = text(input?.front, 1, 1000);
    const back = text(input?.back, 1, 2000);
    if (!front || !back) return problem(400, "invalid_card", "Both sides of the flashcard are required.");
    const id = crypto.randomUUID();
    const position = Number.isInteger(input?.position) ? Number(input?.position) : 1;
    const now = new Date().toISOString();
    await env.DB.prepare(
      "INSERT INTO flashcards (id, deck_id, front_text, back_text, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).bind(id, deckId, front, back, position, now, now).run();
    return json({ card: { id, deckId, front, back, position } }, { status: 201 });
  }

  const deckPublishMatch = pathname.match(/^\/api\/tutor\/flashcard-decks\/([^/]+)\/publish$/);
  if (request.method === "POST" && deckPublishMatch) {
    const deckId = decodeURIComponent(deckPublishMatch[1]);
    const result = await env.DB.prepare(
      `UPDATE flashcard_decks SET status = 'published', updated_at = ?
       WHERE id = ? AND status = 'draft'
       AND EXISTS (SELECT 1 FROM flashcards f WHERE f.deck_id = flashcard_decks.id)
       AND EXISTS (SELECT 1 FROM courses c WHERE c.id = flashcard_decks.course_id AND (c.tutor_id = ? OR ? = 'admin'))`
    ).bind(new Date().toISOString(), deckId, actor.id, actor.role).run();
    return result.meta.changes
      ? json({ deck: { id: deckId, status: "published" } })
      : problem(409, "deck_not_publishable", "Add at least one card before publishing.");
  }
  return null;
}

function matchId(pathname: string, pattern: RegExp): string | null {
  const match = pathname.match(pattern);
  return match ? decodeURIComponent(match[1]) : null;
}

export async function handleJourneyRequest(
  request: Request,
  env: ApiEnvironment,
  pathname: string
): Promise<Response | null> {
  const contactResponse = await profileContacts(request, env, pathname);
  if (contactResponse) return contactResponse;
  const connectionResponse = await connections(request, env, pathname);
  if (connectionResponse) return connectionResponse;
  if (request.method === "POST" && pathname === "/api/auth/register") return register(request, env);
  if (request.method === "POST" && pathname === "/api/auth/login") return login(request, env);
  if (request.method === "GET" && pathname === "/api/me") return me(request, env);
  if ((request.method === "GET" || request.method === "POST") && pathname === "/api/onboarding") {
    return onboarding(request, env);
  }
  if (request.method === "POST" && pathname === "/api/profile/language") {
    return profileLanguage(request, env);
  }
  if ((request.method === "GET" || request.method === "POST") && pathname === "/api/parents/students") {
    return parentStudents(request, env);
  }
  if (request.method === "GET" && pathname === "/api/dashboard") return dashboard(request, env);

  const learningCourseId = matchId(pathname, /^\/api\/learning\/courses\/([^/]+)$/);
  if (request.method === "GET" && learningCourseId) return courseLearning(request, env, learningCourseId);
  const lessonId = matchId(pathname, /^\/api\/learning\/lessons\/([^/]+)\/progress$/);
  if (request.method === "POST" && lessonId) return updateProgress(request, env, lessonId);
  const assessmentId = matchId(pathname, /^\/api\/assessments\/([^/]+)$/);
  if (request.method === "GET" && assessmentId) return assessmentDetails(request, env, assessmentId);
  const assessmentMedia = pathname.match(/^\/api\/assessments\/([^/]+)\/questions\/([^/]+)\/media$/);
  if (request.method === "GET" && assessmentMedia) {
    return assessmentQuestionMedia(
      request, env, decodeURIComponent(assessmentMedia[1]), decodeURIComponent(assessmentMedia[2])
    );
  }
  const startAssessmentId = matchId(pathname, /^\/api\/assessments\/([^/]+)\/attempts$/);
  if (request.method === "POST" && startAssessmentId) return startAttempt(request, env, startAssessmentId);
  const responseMatch = pathname.match(/^\/api\/assessment-attempts\/([^/]+)\/responses\/([^/]+)$/);
  if (request.method === "PUT" && responseMatch) {
    return saveResponse(
      request,
      env,
      decodeURIComponent(responseMatch[1]),
      decodeURIComponent(responseMatch[2])
    );
  }
  const submitAttemptId = matchId(pathname, /^\/api\/assessment-attempts\/([^/]+)\/submit$/);
  if (request.method === "POST" && submitAttemptId) return submitAttempt(request, env, submitAttemptId);
  const deckId = matchId(pathname, /^\/api\/flashcard-decks\/([^/]+)$/);
  if (request.method === "GET" && deckId) return flashcardDeck(request, env, deckId);
  const cardId = matchId(pathname, /^\/api\/flashcards\/([^/]+)\/review$/);
  if (request.method === "POST" && cardId) return reviewFlashcard(request, env, cardId);
  const materialId = matchId(pathname, /^\/api\/materials\/([^/]+)$/);
  if (request.method === "GET" && materialId) return courseMaterial(request, env, materialId);
  if (pathname.startsWith("/api/tutor/") && (request.method === "GET" || request.method === "POST" || request.method === "PATCH" || request.method === "DELETE")) {
    return tutorAuthoring(request, env, pathname);
  }
  return null;
}
