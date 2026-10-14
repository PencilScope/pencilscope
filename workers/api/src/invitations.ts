import { sendEmail } from "../../../src/lib/email";
import { json, problem } from "../../../src/lib/http";
import type { ApiEnvironment } from "./index";

type InvitationRecord = {
  id: string; course_id: string; course_offering_id: string; recipient_email: string;
  personal_message: string; status: "pending" | "opened" | "registered" | "converted" | "expired" | "revoked";
  expires_at: string; course_title: string; course_slug: string; offering_title: string;
  price_cents: number; currency: string; starts_at: string | null; inviter_name: string;
};

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const userIdFrom = (request: Request) => request.headers.get("x-pencilscope-user-id")?.trim() || null;

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[character] ?? character);
}

function encodeHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function createToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function hashInvitationToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return encodeHex(new Uint8Array(digest));
}

async function parseJson(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const value = await request.json();
    return value && typeof value === "object" ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

async function creatorPermission(
  db: D1Database,
  actorId: string | null,
  courseId: string,
  offeringId?: string
): Promise<{ actor_id: string; course_title: string; course_slug: string; offering_title?: string; inviter_name: string } | null> {
  if (!actorId) return null;
  return db.prepare(
    `SELECT u.id AS actor_id, c.title AS course_title, c.slug AS course_slug,
      o.title AS offering_title,
      COALESCE(ap.organization_name, cp.public_name, u.display_name) AS inviter_name
     FROM users u
     JOIN courses c ON c.id = ?
     LEFT JOIN course_offerings o ON o.course_id = c.id AND o.id = ?
     LEFT JOIN account_profiles ap ON ap.user_id = u.id
     LEFT JOIN creator_profiles cp ON cp.user_id = u.id
     WHERE u.id = ? AND u.status = 'active'
       AND (? IS NULL OR o.id IS NOT NULL)
       AND (u.role = 'admin' OR c.tutor_id = u.id OR EXISTS (
         SELECT 1 FROM course_members cm
         WHERE cm.course_id = c.id AND cm.user_id = u.id AND cm.status = 'active'
           AND cm.member_role IN ('owner', 'administrator')
       ))`
  ).bind(courseId, offeringId ?? null, actorId, offeringId ?? null).first();
}

async function invitationByToken(db: D1Database, token: string): Promise<InvitationRecord | null> {
  if (!/^[A-Za-z0-9_-]{40,100}$/.test(token)) return null;
  return db.prepare(
    `SELECT i.id, i.course_id, i.course_offering_id, i.recipient_email,
      i.personal_message, i.status, i.expires_at,
      c.title AS course_title, c.slug AS course_slug,
      o.title AS offering_title, o.price_cents, o.currency, o.starts_at,
      COALESCE(ap.organization_name, cp.public_name, u.display_name) AS inviter_name
     FROM course_invitations i
     JOIN courses c ON c.id = i.course_id
     JOIN course_offerings o ON o.id = i.course_offering_id
     JOIN users u ON u.id = i.inviter_user_id
     LEFT JOIN account_profiles ap ON ap.user_id = u.id
     LEFT JOIN creator_profiles cp ON cp.user_id = u.id
     WHERE i.token_hash = ? AND c.status = 'published' AND o.status = 'published'`
  ).bind(await hashInvitationToken(token)).first<InvitationRecord>();
}

export async function validInvitationForCheckout(
  db: D1Database,
  token: string,
  actorId: string,
  courseId: string,
  offeringId: string
): Promise<{ id: string } | null> {
  if (!/^[A-Za-z0-9_-]{40,100}$/.test(token)) return null;
  return db.prepare(
    `SELECT i.id FROM course_invitations i
     JOIN users u ON u.id = ? AND LOWER(u.email) = i.recipient_email AND u.status = 'active'
     WHERE i.token_hash = ? AND i.course_id = ? AND i.course_offering_id = ?
       AND i.status IN ('pending', 'opened', 'registered') AND i.expires_at > ?`
  ).bind(actorId, await hashInvitationToken(token), courseId, offeringId, new Date().toISOString())
    .first<{ id: string }>();
}

async function listInvitations(request: Request, env: ApiEnvironment, courseId: string): Promise<Response> {
  if (!await creatorPermission(env.DB, userIdFrom(request), courseId)) {
    return problem(403, "course_forbidden", "Only the course owner or an administrator can view invitations.");
  }
  const now = new Date().toISOString();
  await env.DB.prepare(
    `UPDATE course_invitations SET status = 'expired', updated_at = ?
     WHERE course_id = ? AND status IN ('pending', 'opened', 'registered') AND expires_at <= ?`
  ).bind(now, courseId, now).run();
  const invitations = await env.DB.prepare(
    `SELECT i.id, i.course_offering_id, o.title AS offering_title, i.recipient_email,
      i.status, i.delivery_status, i.expires_at, i.opened_at, i.converted_at, i.created_at
     FROM course_invitations i JOIN course_offerings o ON o.id = i.course_offering_id
     WHERE i.course_id = ? ORDER BY i.created_at DESC LIMIT 100`
  ).bind(courseId).all();
  return json({ invitations: invitations.results });
}

async function createInvitations(request: Request, env: ApiEnvironment, courseId: string): Promise<Response> {
  const input = await parseJson(request);
  const offeringId = typeof input?.offeringId === "string" ? input.offeringId.trim() : "";
  const permission = await creatorPermission(env.DB, userIdFrom(request), courseId, offeringId);
  if (!permission || !offeringId) {
    return problem(403, "course_forbidden", "Only the course owner or an administrator can invite learners.");
  }
  const offering = await env.DB.prepare(
    `SELECT id, title FROM course_offerings
     WHERE id = ? AND course_id = ? AND status = 'published' AND pricing_status = 'ready'`
  ).bind(offeringId, courseId).first<{ id: string; title: string }>();
  if (!offering) {
    return problem(409, "offering_not_invitable", "Publish this offering and its price before inviting learners.");
  }

  const connectionId = typeof input?.connectionId === "string" ? input.connectionId.trim() : "";
  const connectedRecipient = connectionId ? await env.DB.prepare(
    `SELECT u.email FROM user_connections uc
     JOIN users u ON u.id = CASE WHEN uc.user_low_id = ? THEN uc.user_high_id ELSE uc.user_low_id END
     WHERE uc.id = ? AND uc.status = 'accepted' AND (uc.user_low_id = ? OR uc.user_high_id = ?)
       AND u.status = 'active'`
  ).bind(permission.actor_id, connectionId, permission.actor_id, permission.actor_id)
    .first<{ email: string }>() : null;
  if (connectionId && !connectedRecipient) {
    return problem(404, "connection_not_found", "Choose an accepted connection to invite.");
  }
  const rawRecipients = connectedRecipient ? [connectedRecipient.email] : Array.isArray(input?.recipients)
    ? input.recipients
    : typeof input?.recipients === "string" ? input.recipients.split(/[\s,;]+/) : [];
  const recipients = [...new Set(rawRecipients
    .map((value) => typeof value === "string" ? value.trim().toLowerCase() : "")
    .filter(Boolean))];
  if (!recipients.length || recipients.length > 20 ||
      recipients.some((email) => email.length > 254 || !emailPattern.test(email))) {
    return problem(400, "invalid_recipients", "Provide between 1 and 20 valid email addresses.");
  }
  const personalMessage = typeof input?.personalMessage === "string" ? input.personalMessage.trim() : "";
  if (personalMessage.length > 500) {
    return problem(400, "message_too_long", "The invitation message must be 500 characters or fewer.");
  }
  const expiresInDays = Number(input?.expiresInDays ?? 14);
  if (!Number.isInteger(expiresInDays) || expiresInDays < 1 || expiresInDays > 30) {
    return problem(400, "invalid_expiry", "Invitation expiry must be between 1 and 30 days.");
  }

  const now = new Date();
  const expiresAt = new Date(now.getTime() + expiresInDays * 86_400_000).toISOString();
  const created: Array<{ email: string; deliveryStatus: "sent" | "failed" }> = [];
  for (const email of recipients) {
    const id = crypto.randomUUID();
    const token = createToken();
    const timestamp = now.toISOString();
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE course_invitations SET status = 'revoked', updated_at = ?
         WHERE course_id = ? AND course_offering_id = ? AND recipient_email = ?
           AND status IN ('pending', 'opened', 'registered')`
      ).bind(timestamp, courseId, offeringId, email),
      env.DB.prepare(
        `INSERT INTO course_invitations
          (id, course_id, course_offering_id, inviter_user_id, recipient_email, token_hash,
           personal_message, status, delivery_status, expires_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 'queued', ?, ?, ?)`
      ).bind(id, courseId, offeringId, permission.actor_id, email, await hashInvitationToken(token),
        personalMessage, expiresAt, timestamp, timestamp),
      env.DB.prepare(
        `INSERT INTO audit_logs (id, actor_user_id, action, entity_type, entity_id, metadata_json, created_at)
         VALUES (?, ?, 'course.invitation.created', 'course_invitation', ?, ?, ?)`
      ).bind(crypto.randomUUID(), permission.actor_id, id, JSON.stringify({ courseId, offeringId }), timestamp)
    ]);

    const invitationUrl = `${env.APP_URL}/invite/${encodeURIComponent(token)}`;
    const messageHtml = personalMessage
      ? `<p style="padding:14px;background:#f3f6e9;border-radius:8px">${escapeHtml(personalMessage).replace(/\n/g, "<br>")}</p>`
      : "";
    try {
      const providerMessageId = await sendEmail(env, {
        to: email,
        subject: `${permission.inviter_name} invited you to ${permission.course_title}`,
        html: `<div style="font-family:Arial,sans-serif;max-width:620px;margin:auto;color:#17372b"><h1>You're invited to learn</h1><p><strong>${escapeHtml(permission.inviter_name)}</strong> invited you to register for <strong>${escapeHtml(permission.course_title)}</strong> — ${escapeHtml(offering.title)}.</p>${messageHtml}<p><a href="${invitationUrl}" style="display:inline-block;padding:14px 20px;border-radius:8px;background:#17372b;color:#fff;text-decoration:none;font-weight:bold">View invitation</a></p><p style="color:#586b63;font-size:13px">This private invitation expires on ${new Date(expiresAt).toLocaleDateString("en-SG")}.</p></div>`
      });
      await env.DB.batch([
        env.DB.prepare(
          "UPDATE course_invitations SET delivery_status = 'sent', provider_message_id = ?, updated_at = ? WHERE id = ?"
        ).bind(providerMessageId, new Date().toISOString(), id),
        env.DB.prepare(
          `INSERT INTO notifications
            (id, user_id, channel, template_key, provider_message_id, status, created_at, sent_at)
           VALUES (?, NULL, 'email', 'course_invitation', ?, 'sent', ?, ?)`
        ).bind(crypto.randomUUID(), providerMessageId, timestamp, new Date().toISOString())
      ]);
      created.push({ email, deliveryStatus: "sent" });
    } catch (error) {
      console.error("course.invitation.email_failed", { invitationId: id, error });
      await env.DB.batch([
        env.DB.prepare("UPDATE course_invitations SET delivery_status = 'failed', updated_at = ? WHERE id = ?")
          .bind(new Date().toISOString(), id),
        env.DB.prepare(
          `INSERT INTO notifications (id, user_id, channel, template_key, status, created_at)
           VALUES (?, NULL, 'email', 'course_invitation', 'failed', ?)`
        ).bind(crypto.randomUUID(), timestamp)
      ]);
      created.push({ email, deliveryStatus: "failed" });
    }
  }
  return json({
    invitations: created,
    sent: created.filter((item) => item.deliveryStatus === "sent").length
  }, { status: 201 });
}

async function viewInvitation(request: Request, env: ApiEnvironment, token: string): Promise<Response> {
  const invitation = await invitationByToken(env.DB, token);
  if (!invitation) return problem(404, "invitation_not_found", "This invitation does not exist.");
  const now = new Date().toISOString();
  if (invitation.status === "revoked") {
    return problem(410, "invitation_revoked", "This invitation has been replaced or revoked.");
  }
  if (invitation.status === "expired" || invitation.expires_at <= now) {
    await env.DB.prepare("UPDATE course_invitations SET status = 'expired', updated_at = ? WHERE id = ?")
      .bind(now, invitation.id).run();
    return problem(410, "invitation_expired", "This invitation has expired. Ask the course creator for a new one.");
  }

  const actorId = userIdFrom(request);
  const viewer = actorId ? await env.DB.prepare(
    `SELECT u.id, u.email, u.display_name, COALESCE(ap.account_type, 'individual') AS account_type
     FROM users u LEFT JOIN account_profiles ap ON ap.user_id = u.id
     WHERE u.id = ? AND u.status = 'active'`
  ).bind(actorId).first<{ id: string; email: string; display_name: string; account_type: string }>() : null;
  const emailMatches = Boolean(viewer && viewer.email.toLowerCase() === invitation.recipient_email);
  if (invitation.status === "pending") {
    await env.DB.prepare(
      "UPDATE course_invitations SET status = 'opened', opened_at = ?, updated_at = ? WHERE id = ?"
    ).bind(now, now, invitation.id).run();
    invitation.status = "opened";
  }
  if (emailMatches && invitation.status !== "converted") {
    await env.DB.prepare(
      `UPDATE course_invitations SET status = 'registered', registered_user_id = ?,
       registered_at = COALESCE(registered_at, ?), updated_at = ? WHERE id = ?`
    ).bind(viewer!.id, now, now, invitation.id).run();
    invitation.status = "registered";
  }
  return json({ invitation: {
    id: invitation.id,
    courseId: invitation.course_id,
    offeringId: invitation.course_offering_id,
    recipientEmail: invitation.recipient_email,
    personalMessage: invitation.personal_message,
    status: invitation.status,
    expiresAt: invitation.expires_at,
    courseTitle: invitation.course_title,
    courseSlug: invitation.course_slug,
    offeringTitle: invitation.offering_title,
    priceCents: invitation.price_cents,
    currency: invitation.currency,
    startsAt: invitation.starts_at,
    inviterName: invitation.inviter_name,
    emailMatches,
    viewer: viewer ? {
      id: viewer.id, email: viewer.email, displayName: viewer.display_name, accountType: viewer.account_type
    } : null
  } });
}

export async function handleInvitationRequest(
  request: Request,
  env: ApiEnvironment,
  pathname: string
): Promise<Response | null> {
  const creatorMatch = pathname.match(/^\/api\/tutor\/courses\/([^/]+)\/invitations$/);
  if (creatorMatch) {
    const courseId = decodeURIComponent(creatorMatch[1]);
    if (request.method === "GET") return listInvitations(request, env, courseId);
    if (request.method === "POST") return createInvitations(request, env, courseId);
  }
  const invitationMatch = pathname.match(/^\/api\/invitations\/([^/]+)$/);
  if (request.method === "GET" && invitationMatch) {
    return viewInvitation(request, env, decodeURIComponent(invitationMatch[1]));
  }
  return null;
}
