import { getCreatorActorById, type CreatorActor } from "../../../src/lib/auth";
import { json, problem } from "../../../src/lib/http";
import type { ApiEnvironment } from "./index";
import { reconcileCreatorSettlements } from "./settlements";
import { payoutAccountSummary } from "./payouts";

function actorId(request: Request): string | null {
  return request.headers.get("x-pencilscope-user-id")?.trim() || null;
}

async function courseRole(
  env: ApiEnvironment,
  courseId: string,
  actor: CreatorActor
): Promise<string | null> {
  if (actor.role === "admin") return "platform_admin";
  const row = await env.DB.prepare(
    `SELECT c.tutor_id, cm.member_role
     FROM courses c LEFT JOIN course_members cm
       ON cm.course_id = c.id AND cm.user_id = ? AND cm.status = 'active'
     WHERE c.id = ?`
  ).bind(actor.id, courseId).first<{ tutor_id: string | null; member_role: string | null }>();
  if (!row) return null;
  return row.tutor_id === actor.id ? "owner" : row.member_role;
}

async function sessions(request: Request, env: ApiEnvironment, pathname: string): Promise<Response | null> {
  if (pathname !== "/api/sessions" && !pathname.startsWith("/api/sessions/")) return null;
  const actor = await getCreatorActorById(actorId(request), env.DB);
  if (!actor) return problem(401, "authentication_required", "Sign in to manage this session.");
  if (request.method === "POST" && pathname === "/api/sessions") {
    let input: { sessionId?: unknown; userAgent?: unknown };
    try { input = await request.json(); } catch { return problem(400, "invalid_json", "A JSON body is required."); }
    const sessionId = typeof input.sessionId === "string" ? input.sessionId.trim() : "";
    if (!/^[a-f0-9-]{20,80}$/i.test(sessionId)) return problem(400, "invalid_session", "A valid session identifier is required.");
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 7 * 86_400_000).toISOString();
    const userAgent = typeof input.userAgent === "string" ? input.userAgent.slice(0, 300) : "";
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO user_sessions (id, user_id, created_at, last_seen_at, expires_at, user_agent)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET last_seen_at = excluded.last_seen_at,
           expires_at = excluded.expires_at, revoked_at = NULL`
      ).bind(sessionId, actor.id, now.toISOString(), now.toISOString(), expiresAt, userAgent),
      env.DB.prepare(
        `INSERT INTO audit_logs (id, actor_user_id, action, entity_type, entity_id, metadata_json, created_at)
         VALUES (?, ?, 'session.signed_in', 'user_session', ?, ?, ?)`
      ).bind(crypto.randomUUID(), actor.id, sessionId, JSON.stringify({ userAgent }), now.toISOString())
    ]);
    return json({ session: { id: sessionId, expiresAt } }, { status: 201 });
  }
  const match = pathname.match(/^\/api\/sessions\/([^/]+)$/);
  if (request.method === "DELETE" && match) {
    const sessionId = decodeURIComponent(match[1]);
    const now = new Date().toISOString();
    await env.DB.batch([
      env.DB.prepare("UPDATE user_sessions SET revoked_at = ? WHERE id = ? AND user_id = ?").bind(now, sessionId, actor.id),
      env.DB.prepare(
        `INSERT INTO audit_logs (id, actor_user_id, action, entity_type, entity_id, metadata_json, created_at)
         VALUES (?, ?, 'session.signed_out', 'user_session', ?, '{}', ?)`
      ).bind(crypto.randomUUID(), actor.id, sessionId, now)
    ]);
    return json({ revoked: true });
  }
  return problem(405, "method_not_allowed", "Method not allowed.");
}

async function payments(request: Request, env: ApiEnvironment): Promise<Response> {
  const actor = await getCreatorActorById(actorId(request), env.DB);
  if (!actor) return problem(401, "authentication_required", "Sign in to view payment history.");
  await reconcileCreatorSettlements(env, actor.id);
  const purchases = await env.DB.prepare(
    `SELECT o.id, o.amount_cents, o.currency, o.status, o.created_at, o.updated_at,
      c.title AS course_title, co.title AS offering_title,
      o.stripe_checkout_session_id, o.stripe_payment_intent_id,
      (SELECT pc.status FROM learner_payment_cases pc
       WHERE pc.order_id = o.id AND pc.status IN ('open', 'reviewing')
       ORDER BY pc.opened_at DESC LIMIT 1) AS issue_status
     FROM orders o JOIN courses c ON c.id = o.course_id
     LEFT JOIN course_offerings co ON co.id = o.course_offering_id
     WHERE o.student_user_id = ? OR o.parent_user_id = ?
     ORDER BY o.created_at DESC LIMIT 200`
  ).bind(actor.id, actor.id).all();
  const creatorSales = await env.DB.prepare(
    `SELECT o.id, o.amount_cents, o.currency, o.status, o.created_at, o.updated_at,
      c.id AS course_id, c.title AS course_title, co.title AS offering_title,
      u.display_name AS learner_name, u.email AS learner_email,
      o.stripe_checkout_session_id, o.stripe_payment_intent_id,
      ce.gross_cents, ce.processing_fee_cents, ce.platform_fee_cents,
      ce.meeting_usage_fee_cents, ce.refund_cents, ce.reserve_cents,
      ce.payable_cents, ce.status AS settlement_status,
      ce.completion_at, ce.review_ends_at, ce.transferred_at
     FROM orders o JOIN courses c ON c.id = o.course_id
     LEFT JOIN course_offerings co ON co.id = o.course_offering_id
     LEFT JOIN creator_earnings ce ON ce.order_id = o.id
     JOIN users u ON u.id = o.student_user_id
     WHERE c.tutor_id = ? OR EXISTS (
       SELECT 1 FROM course_members cm WHERE cm.course_id = c.id AND cm.user_id = ?
         AND cm.status = 'active' AND cm.member_role IN ('owner', 'administrator')
     )
     ORDER BY o.created_at DESC LIMIT 500`
  ).bind(actor.id, actor.id).all();
  const creatorSummary = await env.DB.prepare(
    `SELECT currency,
      COALESCE(SUM(gross_cents), 0) AS gross_cents,
      COALESCE(SUM(processing_fee_cents + platform_fee_cents + meeting_usage_fee_cents
        + refund_cents + reserve_cents), 0) AS deduction_cents,
      COALESCE(SUM(CASE WHEN status IN ('eligible', 'payout_setup_required') THEN payable_cents ELSE 0 END), 0) AS available_cents,
      COALESCE(SUM(CASE WHEN status IN ('transferred', 'paid') THEN payable_cents ELSE 0 END), 0) AS transferred_cents,
      COALESCE(SUM(CASE WHEN status NOT IN ('transferred', 'paid', 'zero_balance', 'reversed') THEN payable_cents ELSE 0 END), 0) AS pending_cents
     FROM creator_earnings WHERE creator_user_id = ? GROUP BY currency ORDER BY currency`
  ).bind(actor.id).all();
  const paymentEvents = await env.DB.prepare(
    `SELECT pe.id, pe.order_id, pe.event_type, pe.status, pe.title, pe.detail,
      pe.metadata_json, pe.occurred_at
     FROM payment_lifecycle_events pe
     JOIN orders o ON o.id = pe.order_id
     JOIN courses c ON c.id = o.course_id
     WHERE o.student_user_id = ? OR o.parent_user_id = ? OR c.tutor_id = ?
       OR EXISTS (
         SELECT 1 FROM course_members cm WHERE cm.course_id = c.id AND cm.user_id = ?
           AND cm.status = 'active' AND cm.member_role IN ('owner', 'administrator')
       )
     ORDER BY pe.occurred_at, pe.id`
  ).bind(actor.id, actor.id, actor.id, actor.id).all();
  const payoutBatches = await env.DB.prepare(
    `SELECT id, currency, gross_cents, deduction_cents, amount_cents,
      earning_count, status, period_starts_at, period_ends_at, scheduled_for,
      provider_transfer_id, failure_message, created_at, updated_at, paid_at
     FROM creator_payout_batches WHERE creator_user_id = ?
     ORDER BY scheduled_for DESC, created_at DESC LIMIT 100`
  ).bind(actor.id).all();
  const payoutAccount = await payoutAccountSummary(env, actor.id);
  return json({
    purchases: purchases.results,
    creatorSales: creatorSales.results,
    creatorSummary: creatorSummary.results,
    paymentEvents: paymentEvents.results,
    payoutBatches: payoutBatches.results,
    payoutAccount
  });
}

async function billingOperations(request: Request, env: ApiEnvironment): Promise<Response> {
  const actor = await getCreatorActorById(actorId(request), env.DB);
  if (!actor) return problem(401, "authentication_required", "Sign in to view billing operations.");
  const access = actor.role === "admin" ? { role: "system_admin" } : await env.DB.prepare(
    `SELECT role FROM platform_roles
     WHERE user_id = ? AND revoked_at IS NULL AND role IN ('system_admin', 'finance', 'support', 'auditor')
     ORDER BY CASE role WHEN 'system_admin' THEN 0 WHEN 'finance' THEN 1 WHEN 'support' THEN 2 ELSE 3 END LIMIT 1`
  ).bind(actor.id).first<{ role: string }>();
  if (!access) return problem(403, "billing_forbidden", "Billing operations access is required.");

  const url = new URL(request.url);
  const query = (url.searchParams.get("q") ?? "").trim().slice(0, 120);
  const status = (url.searchParams.get("status") ?? "").trim().slice(0, 40);
  const like = `%${query.toLowerCase()}%`;
  const [summary, payments, batches, alerts] = await Promise.all([
    env.DB.prepare(
      `SELECT currency,
        COALESCE(SUM(CASE WHEN transaction_type = 'payment' AND status = 'paid' THEN amount_cents ELSE 0 END), 0) AS paid_cents,
        COALESCE(SUM(CASE WHEN transaction_type = 'refund' THEN amount_cents ELSE 0 END), 0) AS refunded_cents,
        COALESCE(SUM(CASE WHEN transaction_type = 'payout' AND status IN ('transferred', 'paid') THEN amount_cents ELSE 0 END), 0) AS payout_cents,
        COUNT(DISTINCT order_id) AS order_count
       FROM payment_transactions GROUP BY currency ORDER BY currency`
    ).all(),
    env.DB.prepare(
      `SELECT o.id, o.status, o.amount_cents, o.currency, o.created_at, o.updated_at,
        o.stripe_checkout_session_id, o.stripe_payment_intent_id,
        c.title AS course_title, learner.display_name AS learner_name,
        learner.email AS learner_email, creator.display_name AS creator_name,
        ce.status AS settlement_status, ce.payable_cents,
        (SELECT COUNT(*) FROM payment_transactions pt WHERE pt.order_id = o.id) AS transaction_count,
        (SELECT COUNT(*) FROM learner_payment_cases pc WHERE pc.order_id = o.id AND pc.status IN ('open','reviewing')) AS open_case_count,
        (SELECT pe.title FROM payment_lifecycle_events pe WHERE pe.order_id = o.id ORDER BY pe.occurred_at DESC, pe.id DESC LIMIT 1) AS latest_event
       FROM orders o JOIN courses c ON c.id = o.course_id
       JOIN users learner ON learner.id = o.student_user_id
       LEFT JOIN users creator ON creator.id = c.tutor_id
       LEFT JOIN creator_earnings ce ON ce.order_id = o.id
       WHERE (? = '' OR LOWER(o.id || ' ' || learner.email || ' ' || COALESCE(creator.email,'') || ' ' ||
         c.title || ' ' || COALESCE(o.stripe_payment_intent_id,'') || ' ' || o.stripe_checkout_session_id) LIKE ?)
         AND (? = '' OR o.status = ? OR ce.status = ?)
       ORDER BY o.created_at DESC LIMIT 300`
    ).bind(query, like, status, status, status).all(),
    env.DB.prepare(
      `SELECT pb.*, u.display_name AS creator_name, u.email AS creator_email
       FROM creator_payout_batches pb JOIN users u ON u.id = pb.creator_user_id
       ORDER BY pb.scheduled_for DESC, pb.created_at DESC LIMIT 200`
    ).all(),
    env.DB.prepare(
      `SELECT
        (SELECT COUNT(*) FROM orders o WHERE o.status = 'paid' AND NOT EXISTS (
          SELECT 1 FROM payment_transactions pt WHERE pt.order_id = o.id AND pt.transaction_type = 'payment'
        )) AS paid_without_transaction,
        (SELECT COUNT(*) FROM enrolments e JOIN orders o ON o.id = e.order_id WHERE o.status <> 'paid' AND e.status = 'active') AS access_without_payment,
        (SELECT COUNT(*) FROM creator_earnings ce WHERE ce.status = 'eligible' AND NOT EXISTS (
          SELECT 1 FROM creator_payout_batch_items pbi WHERE pbi.creator_earning_id = ce.id
        )) AS eligible_unbatched,
        (SELECT COUNT(*) FROM webhook_events WHERE status = 'failed') AS failed_webhooks,
        (SELECT COUNT(*) FROM settlement_transfers WHERE status = 'failed') AS failed_transfers`
    ).first()
  ]);
  return json({
    accessRole: access.role,
    summary: summary.results,
    payments: payments.results,
    payoutBatches: batches.results,
    alerts
  });
}

async function courseLifecycle(
  request: Request,
  env: ApiEnvironment,
  courseId: string,
  action: "delist" | "relist"
): Promise<Response> {
  const actor = await getCreatorActorById(actorId(request), env.DB);
  if (!actor) return problem(401, "authentication_required", "Sign in to manage this course.");
  const role = await courseRole(env, courseId, actor);
  if (!role || !["platform_admin", "owner", "administrator"].includes(role)) {
    return problem(403, "course_forbidden", "Only a course owner or administrator can change its listing.");
  }
  let reason = "";
  try {
    const input = await request.json<{ reason?: unknown }>();
    reason = typeof input.reason === "string" ? input.reason.trim().slice(0, 500) : "";
  } catch {
    // A reason is optional when relisting.
  }
  if (action === "delist" && reason.length < 3) {
    return problem(400, "reason_required", "Give a short reason for delisting this course.");
  }
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE courses SET listing_status = ?, delisted_at = ?, delisted_by = ?,
        delisted_reason = ?, updated_at = ? WHERE id = ? AND status = 'published'`
    ).bind(
      action === "delist" ? "delisted" : "listed",
      action === "delist" ? now : null,
      action === "delist" ? actor.id : null,
      action === "delist" ? reason : null,
      now,
      courseId
    ),
    env.DB.prepare(
      `INSERT INTO audit_logs
        (id, actor_user_id, action, entity_type, entity_id, metadata_json, created_at)
       VALUES (?, ?, ?, 'course', ?, ?, ?)`
    ).bind(crypto.randomUUID(), actor.id, `course.${action}`, courseId, JSON.stringify({ reason }), now)
  ]);
  return json({ course: { id: courseId, listingStatus: action === "delist" ? "delisted" : "listed" } });
}

async function courseTeam(request: Request, env: ApiEnvironment, courseId: string, memberId?: string): Promise<Response> {
  const actor = await getCreatorActorById(actorId(request), env.DB);
  if (!actor) return problem(401, "authentication_required", "Sign in to manage the course team.");
  const role = await courseRole(env, courseId, actor);
  if (!role) return problem(403, "course_forbidden", "You cannot access this course.");
  if (request.method === "GET") {
    const members = await env.DB.prepare(
      `SELECT cm.user_id, u.display_name, u.email, cm.member_role, cm.status,
        cm.created_at, cm.updated_at
       FROM course_members cm JOIN users u ON u.id = cm.user_id
       WHERE cm.course_id = ? ORDER BY CASE cm.member_role WHEN 'owner' THEN 0 ELSE 1 END, u.display_name`
    ).bind(courseId).all();
    const invitations = ["platform_admin", "owner", "administrator"].includes(role)
      ? (await env.DB.prepare(
        `SELECT id, email, member_role, status, delivery_status, expires_at, created_at
         FROM course_member_invitations WHERE course_id = ?
         ORDER BY created_at DESC LIMIT 100`
      ).bind(courseId).all()).results
      : [];
    return json({ role, members: members.results, invitations });
  }
  if (!["platform_admin", "owner", "administrator"].includes(role)) {
    return problem(403, "team_forbidden", "Only a course owner or administrator can manage the team.");
  }
  if (request.method === "DELETE" && memberId) {
    const target = await env.DB.prepare(
      "SELECT member_role FROM course_members WHERE course_id = ? AND user_id = ?"
    ).bind(courseId, memberId).first<{ member_role: string }>();
    if (!target) return problem(404, "member_not_found", "This course member does not exist.");
    if (target.member_role === "owner") return problem(409, "owner_required", "The course owner cannot be removed.");
    const now = new Date().toISOString();
    await env.DB.batch([
      env.DB.prepare(
        "UPDATE course_members SET status = 'removed', updated_at = ? WHERE course_id = ? AND user_id = ?"
      ).bind(now, courseId, memberId),
      env.DB.prepare(
        `INSERT INTO audit_logs
          (id, actor_user_id, action, entity_type, entity_id, metadata_json, created_at)
         VALUES (?, ?, 'course.member_removed', 'course', ?, ?, ?)`
      ).bind(crypto.randomUUID(), actor.id, courseId, JSON.stringify({ userId: memberId }), now)
    ]);
    return json({ removed: true });
  }
  let input: { email?: unknown; memberRole?: unknown };
  try { input = await request.json(); } catch { return problem(400, "invalid_json", "A JSON body is required."); }
  const email = typeof input.email === "string" ? input.email.trim().toLowerCase() : "";
  const memberRole = typeof input.memberRole === "string" ? input.memberRole : "";
  const allowedRoles = ["administrator", "instructor", "facilitator", "editor"];
  if (!email || !allowedRoles.includes(memberRole)) {
    return problem(400, "invalid_member", "Choose an existing user and a valid course role.");
  }
  const target = await env.DB.prepare(
    "SELECT id, status FROM users WHERE LOWER(email) = ?"
  ).bind(email).first<{ id: string; status: string }>();
  if (!target || target.status !== "active") {
    return problem(404, "user_not_found", "No active PencilScope user was found with that email.");
  }
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO course_members
        (course_id, user_id, member_role, status, permissions_json, invited_by, created_at, updated_at)
       VALUES (?, ?, ?, 'active', '{}', ?, ?, ?)
       ON CONFLICT(course_id, user_id) DO UPDATE SET
        member_role = excluded.member_role, status = 'active',
        invited_by = excluded.invited_by, updated_at = excluded.updated_at`
    ).bind(courseId, target.id, memberRole, actor.id, now, now),
    env.DB.prepare(
      `INSERT INTO audit_logs
        (id, actor_user_id, action, entity_type, entity_id, metadata_json, created_at)
       VALUES (?, ?, 'course.member_added', 'course', ?, ?, ?)`
    ).bind(
      crypto.randomUUID(), actor.id, courseId,
      JSON.stringify({ userId: target.id, memberRole }), now
    )
  ]);
  return json({ member: { userId: target.id, email, memberRole, status: "active" } }, { status: 201 });
}

async function courseResults(request: Request, env: ApiEnvironment, courseId: string): Promise<Response> {
  const actor = await getCreatorActorById(actorId(request), env.DB);
  if (!actor) return problem(401, "authentication_required", "Sign in to view assessment results.");
  const role = await courseRole(env, courseId, actor);
  if (!role || !["platform_admin", "owner", "administrator", "instructor", "facilitator"].includes(role)) {
    return problem(403, "results_forbidden", "You do not have permission to view course results.");
  }
  const attempts = await env.DB.prepare(
    `SELECT aa.id, aa.assessment_id, a.title AS assessment_title,
      a.assessment_type, aa.student_user_id, u.display_name AS learner_name,
      u.email AS learner_email, aa.status, aa.started_at, aa.submitted_at,
      aa.graded_at, aa.score, aa.max_score, aa.passed
     FROM assessment_attempts aa
     JOIN assessments a ON a.id = aa.assessment_id
     JOIN users u ON u.id = aa.student_user_id
     WHERE a.course_id = ?
     ORDER BY aa.started_at DESC LIMIT 1000`
  ).bind(courseId).all();
  const summary = await env.DB.prepare(
    `SELECT a.id, a.title, a.assessment_type,
      COUNT(aa.id) AS attempt_count,
      COUNT(DISTINCT aa.student_user_id) AS learner_count,
      ROUND(AVG(aa.score)) AS average_score,
      SUM(CASE WHEN aa.passed = 1 THEN 1 ELSE 0 END) AS passed_count,
      SUM(CASE WHEN aa.status = 'grading' THEN 1 ELSE 0 END) AS grading_count
     FROM assessments a LEFT JOIN assessment_attempts aa ON aa.assessment_id = a.id
     WHERE a.course_id = ? GROUP BY a.id ORDER BY a.created_at`
  ).bind(courseId).all();
  return json({ role, summary: summary.results, attempts: attempts.results });
}

async function myResults(request: Request, env: ApiEnvironment): Promise<Response> {
  const actor = await getCreatorActorById(actorId(request), env.DB);
  if (!actor) return problem(401, "authentication_required", "Sign in to view results.");
  const courseAttempts = await env.DB.prepare(
    `SELECT aa.id, a.title, a.assessment_type, c.title AS course_title,
      aa.status, aa.started_at, aa.submitted_at, aa.score, aa.passed
     FROM assessment_attempts aa JOIN assessments a ON a.id = aa.assessment_id
     JOIN courses c ON c.id = a.course_id
     WHERE aa.student_user_id = ? ORDER BY aa.started_at DESC LIMIT 500`
  ).bind(actor.id).all();
  const standaloneAttempts = await env.DB.prepare(
    `SELECT lpa.id, p.title, p.product_type, lpa.score_percent AS score,
      lpa.passed, lpa.submitted_at
     FROM learning_product_attempts lpa JOIN learning_products p ON p.id = lpa.learning_product_id
     WHERE lpa.user_id = ? ORDER BY lpa.submitted_at DESC LIMIT 500`
  ).bind(actor.id).all();
  return json({ courseAttempts: courseAttempts.results, standaloneAttempts: standaloneAttempts.results });
}

async function creatorOverview(request: Request, env: ApiEnvironment): Promise<Response> {
  const actor = await getCreatorActorById(actorId(request), env.DB);
  if (!actor) return problem(401, "authentication_required", "Sign in to open your Creation Workspace.");
  const requestedPeriod = new URL(request.url).searchParams.get("period") ?? "all";
  const periodDays = requestedPeriod === "30" ? 30 : requestedPeriod === "90" ? 90
    : requestedPeriod === "365" ? 365 : null;
  const period = periodDays ? String(periodDays) : "all";
  const cutoff = periodDays
    ? new Date(Date.now() - periodDays * 86_400_000).toISOString()
    : null;
  const [courseMetrics, productMetrics, courseContent, productContent, auditLogs, creatorCommerce] = await Promise.all([
    env.DB.prepare(
      `SELECT
        COUNT(DISTINCT c.id) AS course_count,
        COUNT(DISTINCT m.id) AS module_count,
        COUNT(DISTINCT l.id) AS lesson_count,
        COUNT(DISTINCT CASE WHEN (? IS NULL OR eo.enrolled_at >= ?) THEN eo.id END) AS subscription_count,
        COUNT(DISTINCT CASE WHEN (? IS NULL OR eo.enrolled_at >= ?)
          AND (e.status = 'completed' OR e.completed_at IS NOT NULL) THEN eo.id END) AS completed_count,
        COUNT(DISTINCT CASE WHEN (? IS NULL OR eo.enrolled_at >= ?) AND e.status = 'active' AND EXISTS (
          SELECT 1 FROM progress_records pr2 WHERE pr2.enrolment_id = e.id
            AND pr2.progress_percent > 0 AND pr2.progress_percent < 100
        ) THEN eo.id END) AS in_progress_count
       FROM courses c
       LEFT JOIN course_modules m ON m.course_id = c.id
       LEFT JOIN lessons l ON l.module_id = m.id
       LEFT JOIN course_offerings o ON o.course_id = c.id
       LEFT JOIN enrolment_offerings eo ON eo.course_offering_id = o.id
       LEFT JOIN enrolments e ON e.id = eo.enrolment_id
       WHERE c.tutor_id = ?`
    ).bind(cutoff, cutoff, cutoff, cutoff, cutoff, cutoff, actor.id).first<Record<string, number>>(),
    env.DB.prepare(
      `SELECT
        COUNT(DISTINCT p.id) AS product_count,
        COUNT(DISTINCT CASE WHEN (? IS NULL OR e.granted_at >= ?) THEN e.id END) AS subscription_count,
        COUNT(DISTINCT CASE WHEN (? IS NULL OR e.granted_at >= ?) AND e.status = 'completed' THEN e.id END) AS completed_count,
        COUNT(DISTINCT CASE WHEN (? IS NULL OR e.granted_at >= ?) AND e.status = 'active' THEN e.id END) AS in_progress_count
       FROM learning_products p
       LEFT JOIN learning_product_entitlements e ON e.learning_product_id = p.id
       WHERE p.creator_id = ?`
    ).bind(cutoff, cutoff, cutoff, cutoff, cutoff, cutoff, actor.id).first<Record<string, number>>(),
    env.DB.prepare(
      `SELECT c.id, c.title, c.description, c.subject, c.primary_level AS audience,
        c.delivery_mode, NULL AS content_url, NULL AS estimated_minutes,
        'course' AS content_type, c.content_version,
        CASE WHEN c.status = 'published' AND c.listing_status = 'listed' THEN 'published'
          WHEN c.status = 'published' THEN 'unpublished' ELSE c.status END AS display_status,
        CASE WHEN EXISTS (SELECT 1 FROM course_offerings live_o WHERE live_o.course_id = c.id
          AND live_o.status = 'published' AND live_o.pricing_status = 'ready'
          AND live_o.stripe_price_id IS NOT NULL AND live_o.price_cents >= 50) THEN 1 ELSE 0 END AS has_live_offer,
        c.updated_at, CASE WHEN c.tutor_id = ? THEN 'owned' ELSE 'collaborating' END AS ownership_scope,
        CASE WHEN c.tutor_id = ? THEN 'owner' ELSE cm.member_role END AS member_role,
        CASE WHEN c.tutor_id = ? OR ? = 'admin' OR cm.member_role IN ('owner', 'administrator', 'editor') THEN 1 ELSE 0 END AS can_edit,
        COUNT(DISTINCT CASE WHEN (? IS NULL OR eo.enrolled_at >= ?) THEN eo.id END) AS subscribed_count,
        COUNT(DISTINCT CASE WHEN (? IS NULL OR eo.enrolled_at >= ?)
          AND (e.status = 'completed' OR e.completed_at IS NOT NULL) THEN eo.id END) AS completed_count,
        COUNT(DISTINCT CASE WHEN (? IS NULL OR eo.enrolled_at >= ?) AND e.status = 'active' AND EXISTS (
          SELECT 1 FROM progress_records pr WHERE pr.enrolment_id = e.id
            AND pr.progress_percent > 0 AND pr.progress_percent < 100
        ) THEN eo.id END) AS in_progress_count,
        (SELECT COUNT(*) FROM assessment_attempts aa JOIN assessments a ON a.id = aa.assessment_id
          WHERE a.course_id = c.id AND (? IS NULL OR aa.started_at >= ?)) AS attempt_count,
        (SELECT ROUND(AVG(aa.score), 1) FROM assessment_attempts aa JOIN assessments a ON a.id = aa.assessment_id
          WHERE a.course_id = c.id AND aa.score IS NOT NULL AND (? IS NULL OR aa.started_at >= ?)) AS average_score,
        (SELECT COUNT(*) FROM assessment_attempts aa JOIN assessments a ON a.id = aa.assessment_id
          WHERE a.course_id = c.id AND aa.passed = 1 AND (? IS NULL OR aa.started_at >= ?)) AS passed_count
       FROM courses c
       LEFT JOIN course_members cm ON cm.course_id = c.id AND cm.user_id = ? AND cm.status = 'active'
       LEFT JOIN course_offerings o ON o.course_id = c.id
       LEFT JOIN enrolment_offerings eo ON eo.course_offering_id = o.id
       LEFT JOIN enrolments e ON e.id = eo.enrolment_id
       WHERE c.tutor_id = ? OR ? = 'admin' OR cm.user_id IS NOT NULL
       GROUP BY c.id, cm.member_role ORDER BY c.updated_at DESC`
    ).bind(
      actor.id, actor.id, actor.id, actor.role, cutoff, cutoff, cutoff, cutoff, cutoff, cutoff,
      cutoff, cutoff, cutoff, cutoff, cutoff, cutoff,
      actor.id, actor.id, actor.role
    ).all(),
    env.DB.prepare(
      `SELECT p.id, p.title, p.description, p.subject, p.audience, NULL AS delivery_mode,
        p.content_url, p.estimated_minutes, p.product_type AS content_type, p.content_version,
        CASE WHEN p.status = 'published' AND p.listing_status = 'listed' THEN 'published'
          WHEN p.status = 'published' THEN 'unpublished' ELSE p.status END AS display_status,
        CASE WHEN EXISTS (SELECT 1 FROM product_offer_items live_i JOIN product_offers live_o
          ON live_o.id = live_i.product_offer_id WHERE live_i.learning_product_id = p.id
          AND live_o.status = 'published' AND live_o.pricing_status = 'ready'
          AND live_o.stripe_price_id IS NOT NULL AND live_o.price_cents >= 50)
          OR EXISTS (SELECT 1 FROM course_offering_learning_products live_ci
          JOIN course_offerings live_co ON live_co.id = live_ci.course_offering_id
          JOIN courses live_c ON live_c.id = live_co.course_id
          WHERE live_ci.learning_product_id = p.id AND live_co.status = 'published'
            AND live_co.pricing_status = 'ready' AND live_co.stripe_price_id IS NOT NULL
            AND live_co.price_cents >= 50 AND live_c.status = 'published' AND live_c.listing_status = 'listed')
          THEN 1 ELSE 0 END AS has_live_offer,
        p.updated_at, 'owned' AS ownership_scope, 'owner' AS member_role, 1 AS can_edit,
        COUNT(DISTINCT CASE WHEN (? IS NULL OR e.granted_at >= ?) THEN e.id END) AS subscribed_count,
        COUNT(DISTINCT CASE WHEN (? IS NULL OR e.granted_at >= ?)
          AND e.status = 'completed' THEN e.id END) AS completed_count,
        COUNT(DISTINCT CASE WHEN (? IS NULL OR e.granted_at >= ?)
          AND e.status = 'active' THEN e.id END) AS in_progress_count,
        (SELECT COUNT(*) FROM learning_product_attempts a WHERE a.learning_product_id = p.id
          AND (? IS NULL OR a.submitted_at >= ?)) AS attempt_count,
        (SELECT ROUND(AVG(a.score_percent), 1) FROM learning_product_attempts a
          WHERE a.learning_product_id = p.id AND (? IS NULL OR a.submitted_at >= ?)) AS average_score,
        (SELECT COUNT(*) FROM learning_product_attempts a WHERE a.learning_product_id = p.id
          AND a.passed = 1 AND (? IS NULL OR a.submitted_at >= ?)) AS passed_count
       FROM learning_products p
       LEFT JOIN learning_product_entitlements e ON e.learning_product_id = p.id
       WHERE p.creator_id = ? GROUP BY p.id ORDER BY p.updated_at DESC`
    ).bind(
      cutoff, cutoff, cutoff, cutoff, cutoff, cutoff,
      cutoff, cutoff, cutoff, cutoff, cutoff, cutoff, actor.id
    ).all(),
    env.DB.prepare(
      `SELECT a.id, a.action, a.entity_type, a.entity_id, a.metadata_json, a.created_at,
        COALESCE(NULLIF(u.display_name, ''), u.email, 'System') AS actor_name
       FROM audit_logs a LEFT JOIN users u ON u.id = a.actor_user_id
       WHERE a.actor_user_id = ?
         OR (a.entity_type = 'course' AND a.entity_id IN (
           SELECT c.id FROM courses c LEFT JOIN course_members cm
             ON cm.course_id = c.id AND cm.user_id = ? AND cm.status = 'active'
           WHERE c.tutor_id = ? OR cm.user_id IS NOT NULL
         ))
         OR (a.entity_type = 'learning_product' AND a.entity_id IN (SELECT id FROM learning_products WHERE creator_id = ?))
         OR (a.entity_type = 'ebook' AND a.entity_id IN (SELECT id FROM ebooks WHERE creator_id = ?))
         OR (a.entity_type = 'assessment' AND a.entity_id IN (
           SELECT a2.id FROM assessments a2 JOIN courses c2 ON c2.id = a2.course_id WHERE c2.tutor_id = ?
         ))
       ORDER BY a.created_at DESC LIMIT 200`
    ).bind(actor.id, actor.id, actor.id, actor.id, actor.id, actor.id).all(),
    env.DB.prepare(
      `SELECT ce.currency,
        COUNT(DISTINCT ce.order_id) AS payment_count,
        COALESCE(SUM(ce.gross_cents), 0) AS gross_cents,
        COALESCE(SUM(ce.refund_cents), 0) AS refund_cents,
        COALESCE(SUM(ce.payable_cents), 0) AS payable_cents
       FROM creator_earnings ce
       JOIN orders o ON o.id = ce.order_id
       WHERE ce.creator_user_id = ? AND o.status = 'paid'
         AND (? IS NULL OR o.created_at >= ?)
       GROUP BY ce.currency ORDER BY ce.currency`
    ).bind(actor.id, cutoff, cutoff).all()
  ]);
  return json({
    metrics: {
      contentCount: Number(courseMetrics?.course_count ?? 0) + Number(productMetrics?.product_count ?? 0),
      moduleCount: Number(courseMetrics?.module_count ?? 0),
      lessonCount: Number(courseMetrics?.lesson_count ?? 0),
      subscribedCount: Number(courseMetrics?.subscription_count ?? 0) + Number(productMetrics?.subscription_count ?? 0),
      completedCount: Number(courseMetrics?.completed_count ?? 0) + Number(productMetrics?.completed_count ?? 0),
      inProgressCount: Number(courseMetrics?.in_progress_count ?? 0) + Number(productMetrics?.in_progress_count ?? 0)
    },
    commerce: creatorCommerce.results.map((row) => ({
      currency: String((row as Record<string, unknown>).currency ?? "SGD"),
      paymentCount: Number((row as Record<string, unknown>).payment_count ?? 0),
      grossCents: Number((row as Record<string, unknown>).gross_cents ?? 0),
      refundCents: Number((row as Record<string, unknown>).refund_cents ?? 0),
      payableCents: Number((row as Record<string, unknown>).payable_cents ?? 0)
    })),
    period,
    content: [...courseContent.results, ...productContent.results].sort((left, right) =>
      String((right as { updated_at?: unknown }).updated_at ?? "").localeCompare(
        String((left as { updated_at?: unknown }).updated_at ?? "")
      )
    ),
    auditLogs: auditLogs.results
  });
}

async function notifications(request: Request, env: ApiEnvironment, pathname: string): Promise<Response> {
  const actor = await getCreatorActorById(actorId(request), env.DB);
  if (!actor) return problem(401, "authentication_required", "Sign in to view notifications.");
  const now = new Date().toISOString();

  if (request.method === "GET" && pathname === "/api/notifications/unread-count") {
    const row = await env.DB.prepare(
      `SELECT COUNT(*) AS total
       FROM in_app_notifications n JOIN notification_campaigns c ON c.id = n.campaign_id
       WHERE n.user_id = ? AND n.read_at IS NULL AND n.dismissed_at IS NULL
         AND c.status = 'published' AND (c.expires_at IS NULL OR c.expires_at > ?)`
    ).bind(actor.id, now).first<{ total: number }>();
    return json({ unreadCount: Number(row?.total ?? 0) });
  }

  if (request.method === "GET" && pathname === "/api/notifications") {
    const url = new URL(request.url);
    const requestedLimit = Number(url.searchParams.get("limit") ?? 50);
    const limit = Number.isInteger(requestedLimit) ? Math.min(100, Math.max(1, requestedLimit)) : 50;
    const [items, unread] = await Promise.all([
      env.DB.prepare(
        `SELECT n.id, n.delivered_at, n.read_at, n.dismissed_at, n.clicked_at,
          c.title, c.body, c.category, c.priority, c.action_url, c.action_label, c.expires_at
         FROM in_app_notifications n JOIN notification_campaigns c ON c.id = n.campaign_id
         WHERE n.user_id = ? AND n.dismissed_at IS NULL AND c.status = 'published'
           AND (c.expires_at IS NULL OR c.expires_at > ?)
         ORDER BY n.delivered_at DESC LIMIT ?`
      ).bind(actor.id, now, limit).all(),
      env.DB.prepare(
        `SELECT COUNT(*) AS total
         FROM in_app_notifications n JOIN notification_campaigns c ON c.id = n.campaign_id
         WHERE n.user_id = ? AND n.read_at IS NULL AND n.dismissed_at IS NULL
           AND c.status = 'published' AND (c.expires_at IS NULL OR c.expires_at > ?)`
      ).bind(actor.id, now).first<{ total: number }>()
    ]);
    return json({ notifications: items.results, unreadCount: Number(unread?.total ?? 0) });
  }

  if (request.method === "POST" && pathname === "/api/notifications/read-all") {
    await env.DB.prepare(
      `UPDATE in_app_notifications SET read_at = COALESCE(read_at, ?)
       WHERE user_id = ? AND dismissed_at IS NULL`
    ).bind(now, actor.id).run();
    return json({ updated: true, unreadCount: 0 });
  }

  const action = pathname.match(/^\/api\/notifications\/([^/]+)\/(read|dismiss|click)$/);
  if (request.method === "POST" && action) {
    const id = decodeURIComponent(action[1]);
    const operation = action[2];
    const statement = operation === "dismiss"
      ? "UPDATE in_app_notifications SET dismissed_at = ?, read_at = COALESCE(read_at, ?) WHERE id = ? AND user_id = ?"
      : operation === "click"
        ? "UPDATE in_app_notifications SET clicked_at = ?, read_at = COALESCE(read_at, ?) WHERE id = ? AND user_id = ?"
        : "UPDATE in_app_notifications SET read_at = COALESCE(read_at, ?) WHERE id = ? AND user_id = ?";
    const result = operation === "read"
      ? await env.DB.prepare(statement).bind(now, id, actor.id).run()
      : await env.DB.prepare(statement).bind(now, now, id, actor.id).run();
    if (!result.meta.changes) return problem(404, "notification_not_found", "The notification does not exist.");
    return json({ notification: { id, read: true, dismissed: operation === "dismiss", clicked: operation === "click" } });
  }

  return problem(405, "method_not_allowed", "Method not allowed.");
}

export async function handleOperationsRequest(
  request: Request,
  env: ApiEnvironment,
  pathname: string
): Promise<Response | null> {
  const sessionResponse = await sessions(request, env, pathname);
  if (sessionResponse) return sessionResponse;
  if (pathname === "/api/notifications" || pathname.startsWith("/api/notifications/")) {
    return notifications(request, env, pathname);
  }
  if (request.method === "GET" && pathname === "/api/payments") return payments(request, env);
  if (request.method === "GET" && pathname === "/api/admin/billing") return billingOperations(request, env);
  if (request.method === "GET" && pathname === "/api/my-results") return myResults(request, env);
  if (request.method === "GET" && pathname === "/api/creator/overview") return creatorOverview(request, env);

  const lifecycle = pathname.match(/^\/api\/tutor\/courses\/([^/]+)\/(delist|relist)$/);
  if (request.method === "POST" && lifecycle) {
    return courseLifecycle(request, env, decodeURIComponent(lifecycle[1]), lifecycle[2] as "delist" | "relist");
  }
  const team = pathname.match(/^\/api\/tutor\/courses\/([^/]+)\/team$/);
  if (team && (request.method === "GET" || request.method === "POST")) {
    return courseTeam(request, env, decodeURIComponent(team[1]));
  }
  const teamMember = pathname.match(/^\/api\/tutor\/courses\/([^/]+)\/team\/([^/]+)$/);
  if (teamMember && request.method === "DELETE") {
    return courseTeam(request, env, decodeURIComponent(teamMember[1]), decodeURIComponent(teamMember[2]));
  }
  const results = pathname.match(/^\/api\/tutor\/courses\/([^/]+)\/results$/);
  if (results && request.method === "GET") {
    return courseResults(request, env, decodeURIComponent(results[1]));
  }
  return null;
}

export async function touchActiveSession(request: Request, env: ApiEnvironment): Promise<void> {
  const sessionId = request.headers.get("x-pencilscope-session-id")?.trim();
  const userId = actorId(request);
  if (!sessionId || !userId) return;
  await env.DB.prepare(
    `UPDATE user_sessions SET last_seen_at = ?
     WHERE id = ? AND user_id = ? AND revoked_at IS NULL AND expires_at > ?`
  ).bind(new Date().toISOString(), sessionId, userId, new Date().toISOString()).run();
}
