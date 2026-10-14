import { sendEmail } from "../../../src/lib/email";
import { getCreatorActorById, type CreatorActor } from "../../../src/lib/auth";
import { json, problem } from "../../../src/lib/http";
import type { ApiEnvironment } from "./index";

const allowedRoles = new Set(["administrator", "instructor", "facilitator", "editor"]);
const roleLabels: Record<string, string> = {
  administrator: "Course manager",
  instructor: "Co-host",
  facilitator: "Facilitator",
  editor: "Content editor"
};

const actorId = (request: Request) => request.headers.get("x-pencilscope-user-id")?.trim() || null;

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[character] ?? character);
}

function createToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function tokenHash(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function parseBody(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const value = await request.json();
    return value && typeof value === "object" ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

async function courseRole(env: ApiEnvironment, courseId: string, actor: CreatorActor): Promise<string | null> {
  if (actor.role === "admin") return "platform_admin";
  const row = await env.DB.prepare(
    `SELECT c.tutor_id, cm.member_role FROM courses c
     LEFT JOIN course_members cm ON cm.course_id = c.id AND cm.user_id = ? AND cm.status = 'active'
     WHERE c.id = ?`
  ).bind(actor.id, courseId).first<{ tutor_id: string; member_role: string | null }>();
  if (!row) return null;
  return row.tutor_id === actor.id ? "owner" : row.member_role;
}

async function connectionEmail(
  env: ApiEnvironment,
  connectionId: string,
  userId: string
): Promise<string | null> {
  const connection = await env.DB.prepare(
    `SELECT u.email FROM user_connections uc
     JOIN users u ON u.id = CASE WHEN uc.user_low_id = ? THEN uc.user_high_id ELSE uc.user_low_id END
     WHERE uc.id = ? AND uc.status = 'accepted' AND (uc.user_low_id = ? OR uc.user_high_id = ?)
       AND u.status = 'active'`
  ).bind(userId, connectionId, userId, userId).first<{ email: string }>();
  return connection?.email?.toLowerCase() ?? null;
}

async function notifyUser(
  env: ApiEnvironment,
  createdBy: string,
  userId: string,
  title: string,
  body: string,
  actionUrl: string
): Promise<void> {
  const campaignId = crypto.randomUUID();
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO notification_campaigns
        (id, title, body, category, priority, action_url, action_label, audience_type,
         audience_json, status, recipient_count, created_by, created_at, published_at)
       VALUES (?, ?, ?, 'creator', 'important', ?, 'View invitation', 'specific_users', ?,
         'published', 1, ?, ?, ?)`
    ).bind(campaignId, title, body, actionUrl, JSON.stringify({ userIds: [userId] }), createdBy, now, now),
    env.DB.prepare(
      `INSERT INTO in_app_notifications (id, campaign_id, user_id, delivered_at)
       VALUES (?, ?, ?, ?)`
    ).bind(crypto.randomUUID(), campaignId, userId, now)
  ]);
}

async function collaborationOptions(request: Request, env: ApiEnvironment): Promise<Response> {
  const actor = await getCreatorActorById(actorId(request), env.DB);
  if (!actor) return problem(401, "authentication_required", "Sign in to invite learners or collaborators.");
  const courses = await env.DB.prepare(
    `SELECT c.id, c.title,
      CASE WHEN c.tutor_id = ? THEN 'owner' ELSE cm.member_role END AS member_role
     FROM courses c LEFT JOIN course_members cm
       ON cm.course_id = c.id AND cm.user_id = ? AND cm.status = 'active'
     WHERE ? = 'admin' OR c.tutor_id = ? OR cm.member_role IN ('owner', 'administrator')
     ORDER BY c.updated_at DESC`
  ).bind(actor.id, actor.id, actor.role, actor.id).all();
  const offerings = await env.DB.prepare(
    `SELECT o.id, o.course_id, o.title FROM course_offerings o JOIN courses c ON c.id = o.course_id
     LEFT JOIN course_members cm ON cm.course_id = c.id AND cm.user_id = ? AND cm.status = 'active'
     WHERE o.status = 'published' AND o.pricing_status = 'ready'
       AND (? = 'admin' OR c.tutor_id = ? OR cm.member_role IN ('owner', 'administrator'))
     ORDER BY c.updated_at DESC, o.title`
  ).bind(actor.id, actor.role, actor.id).all();
  return json({ courses: courses.results, offerings: offerings.results });
}

async function createTeamInvitation(
  request: Request,
  env: ApiEnvironment,
  courseId: string
): Promise<Response> {
  const actor = await getCreatorActorById(actorId(request), env.DB);
  if (!actor) return problem(401, "authentication_required", "Sign in to invite a course collaborator.");
  const role = await courseRole(env, courseId, actor);
  if (!role || !["platform_admin", "owner", "administrator"].includes(role)) {
    return problem(403, "team_forbidden", "Only a course owner or manager can invite collaborators.");
  }
  const input = await parseBody(request);
  const memberRole = typeof input?.memberRole === "string" ? input.memberRole : "";
  const connectionId = typeof input?.connectionId === "string" ? input.connectionId.trim() : "";
  let email = typeof input?.email === "string" ? input.email.trim().toLowerCase() : "";
  if (connectionId) email = await connectionEmail(env, connectionId, actor.id) ?? "";
  const personalMessage = typeof input?.personalMessage === "string" ? input.personalMessage.trim() : "";
  if (!allowedRoles.has(memberRole) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return problem(400, "invalid_invitation", "Choose a valid collaborator and course role.");
  }
  if (personalMessage.length > 500) {
    return problem(400, "message_too_long", "The invitation message must be 500 characters or fewer.");
  }
  const course = await env.DB.prepare(
    `SELECT c.title, u.email AS owner_email,
      COALESCE(ap.organization_name, cp.public_name, u.display_name) AS inviter_name
     FROM courses c JOIN users u ON u.id = ?
     LEFT JOIN account_profiles ap ON ap.user_id = u.id
     LEFT JOIN creator_profiles cp ON cp.user_id = u.id
     WHERE c.id = ?`
  ).bind(actor.id, courseId).first<{ title: string; owner_email: string; inviter_name: string }>();
  if (!course) return problem(404, "course_not_found", "This course does not exist.");
  if (course.owner_email.toLowerCase() === email) {
    return problem(409, "member_exists", "You already have access to this course.");
  }
  const existingUser = await env.DB.prepare(
    "SELECT id, status FROM users WHERE LOWER(email) = ?"
  ).bind(email).first<{ id: string; status: string }>();
  if (existingUser?.status === "active") {
    const existingMember = await env.DB.prepare(
      "SELECT status FROM course_members WHERE course_id = ? AND user_id = ? AND status = 'active'"
    ).bind(courseId, existingUser.id).first();
    if (existingMember) return problem(409, "member_exists", "This person already has access to the course.");
  }

  const invitationId = crypto.randomUUID();
  const token = createToken();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 14 * 86_400_000).toISOString();
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE course_member_invitations SET status = 'revoked', updated_at = ?
       WHERE course_id = ? AND email = ? AND status = 'pending'`
    ).bind(now.toISOString(), courseId, email),
    env.DB.prepare(
      `INSERT INTO course_member_invitations
        (id, course_id, email, member_role, invited_by, status, token_hash, expires_at,
         personal_message, delivery_status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, 'queued', ?, ?)`
    ).bind(invitationId, courseId, email, memberRole, actor.id, await tokenHash(token), expiresAt,
      personalMessage, now.toISOString(), now.toISOString()),
    env.DB.prepare(
      `INSERT INTO audit_logs (id, actor_user_id, action, entity_type, entity_id, metadata_json, created_at)
       VALUES (?, ?, 'course.member_invited', 'course', ?, ?, ?)`
    ).bind(crypto.randomUUID(), actor.id, courseId, JSON.stringify({ invitationId, email, memberRole }), now.toISOString())
  ]);

  const invitationUrl = `${env.APP_URL}/team-invite/${encodeURIComponent(token)}`;
  if (existingUser?.status === "active") {
    await notifyUser(env, actor.id, existingUser.id, `${course.inviter_name} invited you to collaborate`,
      `${roleLabels[memberRole]} access was offered for ${course.title}.`, `/team-invite/${encodeURIComponent(token)}`);
  }
  try {
    const messageHtml = personalMessage
      ? `<p style="padding:14px;background:#eff6ff;border-radius:8px">${escapeHtml(personalMessage).replace(/\n/g, "<br>")}</p>`
      : "";
    const providerMessageId = await sendEmail(env, {
      to: email,
      subject: `${course.inviter_name} invited you to collaborate on ${course.title}`,
      html: `<div style="font-family:Arial,sans-serif;max-width:620px;margin:auto;color:#102a56"><h1>Join a PencilScope course team</h1><p><strong>${escapeHtml(course.inviter_name)}</strong> invited you to collaborate on <strong>${escapeHtml(course.title)}</strong> as <strong>${escapeHtml(roleLabels[memberRole])}</strong>.</p>${messageHtml}<p><a href="${invitationUrl}" style="display:inline-block;padding:14px 20px;border-radius:8px;background:#1d4ed8;color:#fff;text-decoration:none;font-weight:bold">Review invitation</a></p><p style="color:#53677f;font-size:13px">Access is granted only after you sign in with this email and accept. This invitation expires in 14 days.</p></div>`
    });
    await env.DB.prepare(
      "UPDATE course_member_invitations SET delivery_status = 'sent', provider_message_id = ?, updated_at = ? WHERE id = ?"
    ).bind(providerMessageId, new Date().toISOString(), invitationId).run();
  } catch (error) {
    console.error("course.member_invitation.email_failed", { invitationId, error });
    await env.DB.prepare(
      "UPDATE course_member_invitations SET delivery_status = 'failed', updated_at = ? WHERE id = ?"
    ).bind(new Date().toISOString(), invitationId).run();
  }
  return json({ invitation: { id: invitationId, email, memberRole, status: "pending", expiresAt } }, { status: 201 });
}

async function invitationDetails(request: Request, env: ApiEnvironment, token: string): Promise<Response> {
  if (!/^[A-Za-z0-9_-]{40,100}$/.test(token)) return problem(404, "invitation_not_found", "This invitation does not exist.");
  const invitation = await env.DB.prepare(
    `SELECT i.id, i.course_id, i.email, i.member_role, i.status, i.expires_at, i.personal_message,
      c.title AS course_title, c.slug AS course_slug,
      COALESCE(ap.organization_name, cp.public_name, u.display_name) AS inviter_name
     FROM course_member_invitations i JOIN courses c ON c.id = i.course_id
     JOIN users u ON u.id = i.invited_by
     LEFT JOIN account_profiles ap ON ap.user_id = u.id
     LEFT JOIN creator_profiles cp ON cp.user_id = u.id
     WHERE i.token_hash = ?`
  ).bind(await tokenHash(token)).first<{
    id: string; course_id: string; email: string; member_role: string; status: string;
    expires_at: string; personal_message: string; course_title: string; course_slug: string; inviter_name: string;
  }>();
  if (!invitation) return problem(404, "invitation_not_found", "This invitation does not exist.");
  const now = new Date().toISOString();
  if (invitation.status === "pending" && invitation.expires_at <= now) {
    await env.DB.prepare("UPDATE course_member_invitations SET status = 'expired', updated_at = ? WHERE id = ?")
      .bind(now, invitation.id).run();
    invitation.status = "expired";
  }
  const viewerId = actorId(request);
  const viewer = viewerId ? await env.DB.prepare(
    "SELECT id, email FROM users WHERE id = ? AND status = 'active'"
  ).bind(viewerId).first<{ id: string; email: string }>() : null;
  return json({ invitation: {
    id: invitation.id,
    courseId: invitation.course_id,
    courseTitle: invitation.course_title,
    courseSlug: invitation.course_slug,
    email: invitation.email,
    memberRole: invitation.member_role,
    roleLabel: roleLabels[invitation.member_role],
    inviterName: invitation.inviter_name,
    personalMessage: invitation.personal_message,
    status: invitation.status,
    expiresAt: invitation.expires_at,
    signedIn: Boolean(viewer),
    emailMatches: Boolean(viewer && viewer.email.toLowerCase() === invitation.email.toLowerCase())
  } });
}

async function acceptInvitation(request: Request, env: ApiEnvironment, token: string): Promise<Response> {
  const actor = await getCreatorActorById(actorId(request), env.DB);
  if (!actor) return problem(401, "authentication_required", "Sign in with the invited email before accepting.");
  const now = new Date().toISOString();
  const invitation = await env.DB.prepare(
    `SELECT i.id, i.course_id, i.email, i.member_role, i.invited_by, i.status, i.expires_at,
      c.title AS course_title, u.email AS actor_email
     FROM course_member_invitations i JOIN courses c ON c.id = i.course_id
     JOIN users u ON u.id = ? WHERE i.token_hash = ?`
  ).bind(actor.id, await tokenHash(token)).first<{
    id: string; course_id: string; email: string; member_role: string; invited_by: string;
    status: string; expires_at: string; course_title: string; actor_email: string;
  }>();
  if (!invitation) return problem(404, "invitation_not_found", "This invitation does not exist.");
  if (invitation.status !== "pending" || invitation.expires_at <= now) {
    return problem(410, "invitation_unavailable", "This invitation has expired or is no longer available.");
  }
  if (invitation.actor_email.toLowerCase() !== invitation.email.toLowerCase()) {
    return problem(403, "email_mismatch", "Sign in with the email address that received this invitation.");
  }
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO course_members
        (course_id, user_id, member_role, status, permissions_json, invited_by, created_at, updated_at)
       VALUES (?, ?, ?, 'active', '{}', ?, ?, ?)
       ON CONFLICT(course_id, user_id) DO UPDATE SET member_role = excluded.member_role,
         status = 'active', invited_by = excluded.invited_by, updated_at = excluded.updated_at`
    ).bind(invitation.course_id, actor.id, invitation.member_role, invitation.invited_by, now, now),
    env.DB.prepare(
      `UPDATE course_member_invitations SET status = 'accepted', accepted_by = ?, accepted_at = ?, updated_at = ?
       WHERE id = ? AND status = 'pending'`
    ).bind(actor.id, now, now, invitation.id),
    env.DB.prepare(
      `INSERT INTO audit_logs (id, actor_user_id, action, entity_type, entity_id, metadata_json, created_at)
       VALUES (?, ?, 'course.member_invitation.accepted', 'course', ?, ?, ?)`
    ).bind(crypto.randomUUID(), actor.id, invitation.course_id,
      JSON.stringify({ invitationId: invitation.id, memberRole: invitation.member_role }), now)
  ]);
  await notifyUser(env, actor.id, invitation.invited_by, `${invitation.actor_email} joined your course team`,
    `${roleLabels[invitation.member_role]} access is now active for ${invitation.course_title}.`,
    `/tutor?courseId=${encodeURIComponent(invitation.course_id)}&section=team`);
  return json({ accepted: true, courseId: invitation.course_id, memberRole: invitation.member_role });
}

export async function handleCollaborationRequest(
  request: Request,
  env: ApiEnvironment,
  pathname: string
): Promise<Response | null> {
  if (request.method === "GET" && pathname === "/api/collaboration/options") {
    return collaborationOptions(request, env);
  }
  const createMatch = pathname.match(/^\/api\/tutor\/courses\/([^/]+)\/team-invitations$/);
  if (request.method === "POST" && createMatch) {
    return createTeamInvitation(request, env, decodeURIComponent(createMatch[1]));
  }
  const inviteMatch = pathname.match(/^\/api\/team-invitations\/([^/]+)(?:\/(accept))?$/);
  if (inviteMatch && request.method === "GET" && !inviteMatch[2]) {
    return invitationDetails(request, env, decodeURIComponent(inviteMatch[1]));
  }
  if (inviteMatch && request.method === "POST" && inviteMatch[2] === "accept") {
    return acceptInvitation(request, env, decodeURIComponent(inviteMatch[1]));
  }
  return null;
}
