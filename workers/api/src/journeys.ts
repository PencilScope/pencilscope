import { getCreatorActorById } from "../../../src/lib/auth";
import { json, problem } from "../../../src/lib/http";
import type { ApiEnvironment } from "./index";

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
const passwordIterations = 210_000;

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
  const accountType = input?.accountType === "organization" || input?.role === "tutor"
    ? "organization" : input?.accountType === "individual" || input?.role === "parent" ? "individual" : null;
  const organizationName = accountType === "organization" ? text(input?.organizationName, 2, 160) : null;
  if (!displayName || !email || !email.includes("@") || !password || !accountType ||
      (accountType === "organization" && !organizationName)) {
    return problem(400, "invalid_registration", "Provide a name, valid email, password of at least 10 characters, and an Individual or Organisation account type.");
  }
  const role = accountType === "organization" ? "tutor" : "parent";

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
    ).bind(id, organizationName ?? displayName, now, now)
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
  await env.DB.prepare(
    "UPDATE user_credentials SET last_login_at = ? WHERE user_id = ?"
  ).bind(new Date().toISOString(), account.id).run();
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
  if (actor.account_type !== "individual") {
    return problem(403, "individual_required", "Organisation accounts cannot access learner content.");
  }
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
      `SELECT c.id, c.slug, c.title, c.status, c.pricing_status,
        COUNT(eo.id) AS enrolment_count
       FROM courses c LEFT JOIN course_offerings o ON o.course_id = c.id
       LEFT JOIN enrolment_offerings eo ON eo.course_offering_id = o.id
       WHERE c.tutor_id = ? OR ? = 'admin'
         OR EXISTS (SELECT 1 FROM course_members cm WHERE cm.course_id = c.id AND cm.user_id = ? AND cm.status = 'active')
       GROUP BY c.id ORDER BY c.updated_at DESC`
    ).bind(actor.id, actor.role, actor.id).all();

  const students = actor.account_type === "individual"
    ? (await env.DB.prepare(
        `SELECT u.id, u.display_name, sp.primary_level
         FROM parent_student_relationships ps JOIN users u ON u.id = ps.student_user_id
         LEFT JOIN student_profiles sp ON sp.user_id = u.id
         WHERE ps.parent_user_id = ? ORDER BY u.display_name`
      ).bind(actor.id).all()).results
    : [];
  const studentIds = actor.account_type === "individual"
    ? [actor.id, ...students.map((student) => String(student.id))]
    : [];
  let enrolments: unknown[] = [];
  if (studentIds.length) {
    const placeholders = studentIds.map(() => "?").join(",");
    enrolments = (await env.DB.prepare(
      `SELECT e.id, e.student_user_id, e.course_id, eo.status, eo.enrolled_at,
        eo.course_offering_id, o.title AS offering_title,
        t.academic_year, t.term_number, c.title, c.slug, c.subject,
        COALESCE(AVG(pr.progress_percent), 0) AS progress_percent
       FROM enrolments e JOIN courses c ON c.id = e.course_id
       JOIN enrolment_offerings eo ON eo.enrolment_id = e.id
       JOIN course_offerings o ON o.id = eo.course_offering_id
       JOIN academic_terms t ON t.id = o.academic_term_id
       LEFT JOIN progress_records pr ON pr.enrolment_id = e.id
       WHERE e.student_user_id IN (${placeholders})
       GROUP BY eo.id ORDER BY eo.enrolled_at DESC`
    ).bind(...studentIds).all()).results;
  }
  return json({
    user: actor,
    selfLearner: actor.account_type === "individual"
      ? { id: actor.id, display_name: actor.display_name, primary_level: null }
      : null,
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
      l.estimated_minutes, COALESCE(pr.status, 'not-started') AS progress_status,
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
    `SELECT m.id, m.title, m.description, m.material_type FROM course_materials m
     JOIN course_offering_materials om ON om.material_id = m.id
     JOIN enrolment_offerings eo ON eo.course_offering_id = om.course_offering_id
     JOIN course_offerings o ON o.id = eo.course_offering_id
     WHERE m.course_id = ? AND m.status = 'published' AND eo.enrolment_id = ?
       AND eo.status = 'active' AND (o.access_ends_at IS NULL OR o.access_ends_at >= ?)
     GROUP BY m.id ORDER BY om.position`
  ).bind(courseId, enrolment.id, new Date().toISOString()).all();
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
  const questions = await env.DB.prepare(
    "SELECT id, question_type, prompt, points, position FROM assessment_questions WHERE assessment_id = ? ORDER BY position"
  ).bind(assessmentId).all();
  const options = await env.DB.prepare(
    `SELECT o.id, o.question_id, o.label, o.position FROM assessment_options o
     JOIN assessment_questions q ON q.id = o.question_id
     WHERE q.assessment_id = ? ORDER BY q.position, o.position`
  ).bind(assessmentId).all();
  return json({ assessment, questions: questions.results, options: options.results });
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
  const studioMatch = pathname.match(/^\/api\/tutor\/courses\/([^/]+)\/studio$/);
  if (request.method === "GET" && studioMatch) {
    const courseId = decodeURIComponent(studioMatch[1]);
    const course = await env.DB.prepare(
      "SELECT id, slug, title, description, subject, primary_level, delivery_mode, price_cents, currency, status, pricing_status FROM courses WHERE id = ? AND (tutor_id = ? OR ? = 'admin')"
    ).bind(courseId, actor.id, actor.role).first();
    if (!course) return problem(404, "course_not_found", "The course does not exist.");
    const [modules, lessons, assessments, decks, offerings, materials, offeringModules, offeringAssessments, offeringDecks, offeringMaterials, categories, sessions] = await Promise.all([
      env.DB.prepare("SELECT id, title, position FROM course_modules WHERE course_id = ? ORDER BY position").bind(courseId).all(),
      env.DB.prepare(
        "SELECT l.id, l.module_id, l.title, l.lesson_type, l.delivery_mode, l.course_session_id, l.position FROM lessons l JOIN course_modules m ON m.id = l.module_id WHERE m.course_id = ? ORDER BY m.position, l.position"
      ).bind(courseId).all(),
      env.DB.prepare(
        "SELECT id, title, assessment_type, status FROM assessments WHERE course_id = ? ORDER BY created_at"
      ).bind(courseId).all(),
      env.DB.prepare(
        "SELECT id, title, status FROM flashcard_decks WHERE course_id = ? ORDER BY created_at"
      ).bind(courseId).all(),
      env.DB.prepare(
        `SELECT o.id, o.title, o.price_cents, o.currency, o.status, o.pricing_status,
          o.enrolment_opens_at, o.enrolment_closes_at, o.access_ends_at,
          o.offering_type, o.delivery_mode, o.starts_at, o.ends_at, o.timezone, o.capacity,
          t.academic_year, t.term_number
         FROM course_offerings o JOIN academic_terms t ON t.id = o.academic_term_id
         WHERE o.course_id = ? ORDER BY COALESCE(o.starts_at, t.starts_at, o.created_at), o.title`
      ).bind(courseId).all(),
      env.DB.prepare(
        "SELECT id, title, description, material_type, status FROM course_materials WHERE course_id = ? ORDER BY created_at"
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
        `SELECT cc.id, cc.slug, cc.title,
          EXISTS(SELECT 1 FROM course_category_links cl WHERE cl.course_id = ? AND cl.category_id = cc.id) AS selected
         FROM course_categories cc WHERE cc.active = 1 ORDER BY cc.position, cc.title`
      ).bind(courseId).all(),
      env.DB.prepare(
        `SELECT s.id, s.course_offering_id, s.title, s.delivery_mode, s.starts_at, s.ends_at,
          s.timezone, s.capacity, s.meeting_url, v.name AS venue_name, v.address_line_1
         FROM course_sessions s LEFT JOIN venues v ON v.id = s.venue_id
         JOIN course_offerings o ON o.id = s.course_offering_id
         WHERE o.course_id = ? ORDER BY s.starts_at`
      ).bind(courseId).all()
    ]);
    return json({
      course,
      modules: modules.results,
      lessons: lessons.results,
      assessments: assessments.results,
      flashcardDecks: decks.results,
      offerings: offerings.results,
      materials: materials.results,
      offeringModules: offeringModules.results,
      offeringAssessments: offeringAssessments.results,
      offeringDecks: offeringDecks.results,
      offeringMaterials: offeringMaterials.results,
      categories: categories.results,
      sessions: sessions.results
    });
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
    const priceCents = Number(input?.priceCents);
    const startsAt = typeof input?.startsAt === "string" && input.startsAt ? input.startsAt : null;
    const endsAt = typeof input?.endsAt === "string" && input.endsAt ? input.endsAt : null;
    const capacity = input?.capacity === null || input?.capacity === "" || input?.capacity === undefined
      ? null : Number(input.capacity);
    if (!title || !Number.isSafeInteger(priceCents) || priceCents < 50 ||
        (capacity !== null && (!Number.isInteger(capacity) || capacity < 1)) ||
        ((offeringType === "cohort" || offeringType === "event") && (!startsAt || !endsAt)) ||
        (startsAt && endsAt && new Date(endsAt).getTime() <= new Date(startsAt).getTime()) ||
        (offeringType === "academic_term" && (!Number.isInteger(academicYear) || academicYear < 2000 || academicYear > 2200 ||
          !Number.isInteger(termNumber) || termNumber < 1 || termNumber > 12))) {
      return problem(400, "invalid_offering", "Provide a valid offering type, schedule, title, capacity, and price.");
    }
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const isAcademic = offeringType === "academic_term";
    const internalYear = isAcademic ? academicYear : 3_000_000_000 + Number.parseInt(id.replace(/-/g, "").slice(0, 7), 16);
    const internalTerm = isAcademic ? termNumber : 0;
    const termId = isAcademic ? `academic-term-${academicYear}-${termNumber}` : `academic-term-general-${id}`;
    const accessEndsAt = typeof input?.accessEndsAt === "string" && input.accessEndsAt ? input.accessEndsAt : endsAt;
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO academic_terms (id, academic_year, term_number, title, starts_at, ends_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(academic_year, term_number) DO NOTHING`
      ).bind(termId, internalYear, internalTerm, isAcademic ? `Term ${termNumber}` : "Not applicable", startsAt, endsAt, now),
      env.DB.prepare(
        `INSERT INTO course_offerings
          (id, course_id, academic_term_id, title, enrolment_opens_at, enrolment_closes_at,
           access_ends_at, price_cents, currency, pricing_version, pricing_status, status,
           offering_type, delivery_mode, starts_at, ends_at, timezone, capacity, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'SGD', 1, 'pending', 'draft', ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        id, courseId, termId, title,
        typeof input?.enrolmentOpensAt === "string" && input.enrolmentOpensAt ? input.enrolmentOpensAt : null,
        typeof input?.enrolmentClosesAt === "string" && input.enrolmentClosesAt ? input.enrolmentClosesAt : null,
        accessEndsAt, priceCents, offeringType, deliveryMode, startsAt, endsAt,
        typeof input?.timezone === "string" && input.timezone ? input.timezone.slice(0, 80) : "Asia/Singapore",
        capacity, now, now
      )
    ]);
    return json({ offering: {
      id, courseId, title, offeringType, deliveryMode,
      academicYear: isAcademic ? academicYear : null,
      termNumber: isAcademic ? termNumber : null,
      startsAt, endsAt, capacity, priceCents, status: "draft"
    } }, { status: 201 });
  }

  const sessionMatch = pathname.match(/^\/api\/tutor\/offerings\/([^/]+)\/sessions$/);
  if (request.method === "POST" && sessionMatch) {
    const offeringId = decodeURIComponent(sessionMatch[1]);
    const owned = await env.DB.prepare(
      `SELECT o.course_id FROM course_offerings o JOIN courses c ON c.id = o.course_id
       WHERE o.id = ? AND (c.tutor_id = ? OR ? = 'admin')`
    ).bind(offeringId, actor.id, actor.role).first<{ course_id: string }>();
    if (!owned) return problem(403, "offering_forbidden", "You cannot edit this offering.");
    const input = await parseJson(request);
    const title = text(input?.title, 2, 160);
    const deliveryMode = input?.deliveryMode === "in_person" ? "in_person"
      : input?.deliveryMode === "live_online" ? "live_online" : null;
    const startsAt = typeof input?.startsAt === "string" ? input.startsAt : "";
    const endsAt = typeof input?.endsAt === "string" ? input.endsAt : "";
    const meetingUrl = typeof input?.meetingUrl === "string" && input.meetingUrl.trim() ? input.meetingUrl.trim() : null;
    const venueName = text(input?.venueName, 2, 160);
    const venueAddress = text(input?.venueAddress, 3, 300);
    const capacity = input?.capacity === null || input?.capacity === "" || input?.capacity === undefined
      ? null : Number(input.capacity);
    if (!title || !deliveryMode || !startsAt || !endsAt ||
        new Date(endsAt).getTime() <= new Date(startsAt).getTime() ||
        (capacity !== null && (!Number.isInteger(capacity) || capacity < 1)) ||
        (deliveryMode === "live_online" && !meetingUrl) ||
        (deliveryMode === "in_person" && (!venueName || !venueAddress))) {
      return problem(400, "invalid_session", "Provide a valid live or in-person session, schedule, and location.");
    }
    if (meetingUrl) {
      try {
        const parsed = new URL(meetingUrl);
        if (parsed.protocol !== "https:") throw new Error("invalid");
      } catch {
        return problem(400, "invalid_meeting_url", "Use a secure HTTPS meeting URL.");
      }
    }
    const now = new Date().toISOString();
    const sessionId = crypto.randomUUID();
    const venueId = deliveryMode === "in_person" ? crypto.randomUUID() : null;
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
         timezone, capacity, meeting_url, meeting_provider, venue_id, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'scheduled', ?, ?)`
    ).bind(
      sessionId, offeringId, actor.id, title, deliveryMode, startsAt, endsAt,
      typeof input?.timezone === "string" && input.timezone ? input.timezone.slice(0, 80) : "Asia/Singapore",
      capacity, meetingUrl,
      deliveryMode === "live_online" && typeof input?.meetingProvider === "string" ? input.meetingProvider.slice(0, 80) : null,
      venueId, now, now
    ));
    await env.DB.batch(statements);
    return json({ session: { id: sessionId, offeringId, title, deliveryMode, startsAt, endsAt } }, { status: 201 });
  }
  const courseModuleMatch = pathname.match(/^\/api\/tutor\/courses\/([^/]+)\/modules$/);
  if (request.method === "POST" && courseModuleMatch) {
    const input = await parseJson(request);
    const courseId = decodeURIComponent(courseModuleMatch[1]);
    const owned = await env.DB.prepare(
      "SELECT 1 FROM courses WHERE id = ? AND (tutor_id = ? OR ? = 'admin')"
    ).bind(courseId, actor.id, actor.role).first();
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

  const lessonMatch = pathname.match(/^\/api\/tutor\/modules\/([^/]+)\/lessons$/);
  if (request.method === "POST" && lessonMatch) {
    const input = await parseJson(request);
    const moduleId = decodeURIComponent(lessonMatch[1]);
    const owned = await env.DB.prepare(
      `SELECT 1 FROM course_modules m JOIN courses c ON c.id = m.course_id
       WHERE m.id = ? AND (c.tutor_id = ? OR ? = 'admin')`
    ).bind(moduleId, actor.id, actor.role).first();
    if (!owned) return problem(403, "module_forbidden", "You cannot edit this module.");
    const title = text(input?.title, 2, 120);
    const lessonType = ["video", "text", "document", "quiz", "live", "ai"].includes(String(input?.lessonType))
      ? String(input?.lessonType) : null;
    const deliveryMode = ["recorded", "live_online", "in_person"].includes(String(input?.deliveryMode))
      ? String(input?.deliveryMode) : lessonType === "live" ? "live_online" : "recorded";
    if (!title || !lessonType) return problem(400, "invalid_lesson", "Lesson title and type are required.");
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
      JSON.stringify(input?.content ?? {}),
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
      "SELECT 1 FROM courses WHERE id = ? AND (tutor_id = ? OR ? = 'admin')"
    ).bind(courseId, actor.id, actor.role).first();
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
      "SELECT 1 FROM courses WHERE id = ? AND (tutor_id = ? OR ? = 'admin')"
    ).bind(courseId, actor.id, actor.role).first();
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
      "SELECT 1 FROM courses WHERE id = ? AND (tutor_id = ? OR ? = 'admin')"
    ).bind(courseId, actor.id, actor.role).first();
    if (!owned) return problem(403, "course_forbidden", "You cannot edit this course.");
    const input = await parseJson(request);
    const title = text(input?.title, 2, 160);
    const materialType = ["document", "video", "link", "download"].includes(String(input?.materialType))
      ? String(input?.materialType) : null;
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
        (id, course_id, created_by, title, description, material_type, storage_key,
         external_url, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'published', ?, ?)`
    ).bind(
      id, courseId, actor.id, title,
      typeof input?.description === "string" ? input.description.slice(0, 2000) : "",
      materialType, storageKey, externalUrl, now, now
    )];
    if (typeof input?.offeringId === "string" && input.offeringId) {
      statements.push(env.DB.prepare(
        `INSERT INTO course_offering_materials (course_offering_id, material_id, position)
         SELECT id, ?, 1 FROM course_offerings WHERE id = ? AND course_id = ?`
      ).bind(id, input.offeringId, courseId));
    }
    await env.DB.batch(statements);
    return json({ material: { id, courseId, title, materialType, status: "published" } }, { status: 201 });
  }

  const assignContentMatch = pathname.match(/^\/api\/tutor\/offerings\/([^/]+)\/content$/);
  if (request.method === "POST" && assignContentMatch) {
    const offeringId = decodeURIComponent(assignContentMatch[1]);
    const input = await parseJson(request);
    const contentId = typeof input?.contentId === "string" ? input.contentId : "";
    const kind = String(input?.kind ?? "");
    const offering = await env.DB.prepare(
      `SELECT o.course_id FROM course_offerings o JOIN courses c ON c.id = o.course_id
       WHERE o.id = ? AND (c.tutor_id = ? OR ? = 'admin')`
    ).bind(offeringId, actor.id, actor.role).first<{ course_id: string }>();
    if (!offering) return problem(403, "offering_forbidden", "You cannot edit this course offering.");
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

  const questionMatch = pathname.match(/^\/api\/tutor\/assessments\/([^/]+)\/questions$/);
  if (request.method === "POST" && questionMatch) {
    const assessmentId = decodeURIComponent(questionMatch[1]);
    const owned = await env.DB.prepare(
      `SELECT 1 FROM assessments a JOIN courses c ON c.id = a.course_id
       WHERE a.id = ? AND (c.tutor_id = ? OR ? = 'admin') AND a.status = 'draft'`
    ).bind(assessmentId, actor.id, actor.role).first();
    if (!owned) return problem(403, "assessment_forbidden", "You cannot edit this assessment.");
    const input = await parseJson(request);
    const prompt = text(input?.prompt, 2, 2000);
    const questionType = input?.questionType === "short_text" ? "short_text" : "multiple_choice";
    const options = Array.isArray(input?.options) ? input.options : [];
    if (!prompt) return problem(400, "invalid_question", "A question prompt is required.");
    if (questionType === "multiple_choice") {
      const validOptions = options.filter((option): option is { label: string; isCorrect?: boolean } =>
        Boolean(option) && typeof option === "object" && typeof option.label === "string" && option.label.trim().length > 0
      );
      if (validOptions.length < 2 || validOptions.filter((option) => option.isCorrect === true).length !== 1) {
        return problem(400, "invalid_options", "Choice questions need at least two options and exactly one correct answer.");
      }
    }
    const id = crypto.randomUUID();
    const position = Number.isInteger(input?.position) ? Number(input?.position) : 1;
    const statements = [env.DB.prepare(
      `INSERT INTO assessment_questions
        (id, assessment_id, question_type, prompt, explanation, points, position)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      id, assessmentId, questionType, prompt,
      typeof input?.explanation === "string" ? input.explanation.slice(0, 2000) : "",
      Math.max(1, Number(input?.points ?? 1) || 1), position
    )];
    if (questionType === "multiple_choice") {
      options.forEach((option, index) => {
        if (!option || typeof option !== "object" || typeof option.label !== "string" || !option.label.trim()) return;
        statements.push(env.DB.prepare(
          "INSERT INTO assessment_options (id, question_id, label, is_correct, position) VALUES (?, ?, ?, ?, ?)"
        ).bind(crypto.randomUUID(), id, option.label.trim().slice(0, 500), option.isCorrect === true ? 1 : 0, index + 1));
      });
    }
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
       WHERE d.id = ? AND (c.tutor_id = ? OR ? = 'admin') AND d.status = 'draft'`
    ).bind(deckId, actor.id, actor.role).first();
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
  if (request.method === "POST" && pathname === "/api/auth/register") return register(request, env);
  if (request.method === "POST" && pathname === "/api/auth/login") return login(request, env);
  if (request.method === "GET" && pathname === "/api/me") return me(request, env);
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
  if (pathname.startsWith("/api/tutor/") && (request.method === "GET" || request.method === "POST")) {
    return tutorAuthoring(request, env, pathname);
  }
  return null;
}
