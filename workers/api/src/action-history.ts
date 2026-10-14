import { getCreatorActorById } from "../../../src/lib/auth";
import { json, problem } from "../../../src/lib/http";
import type { ApiEnvironment } from "./index";

type HistoryState = "active" | "archived" | "deleted";
type AuditRow = {
  id: string;
  action: string;
  entity_type: string;
  entity_id: string | null;
  metadata_json: string;
  created_at: string;
  state?: HistoryState;
  archive_id?: string | null;
};

const MAX_SELECTION = 100;
const SECRET_KEY = /(password|secret|token|authorization|cookie|card|meeting_?url|join_?url)/i;

function userId(request: Request): string | null {
  return request.headers.get("x-pencilscope-user-id")?.trim() || null;
}

function categoryFor(action: string): string {
  if (/^(auth|session|oauth|mcp_oauth|security)\./.test(action)) return "security";
  if (/^(payment|order|checkout|refund|dispute|payout|settlement|storage\.subscription)/.test(action)) return "billing";
  if (/^(learning|progress|assessment|attempt|enrol|enroll)/.test(action)) return "learning";
  if (/^(connection|network|message|notification|invitation)/.test(action) || action.includes("member_")) return "network";
  if (/^(course|offering|ebook|learning_product|creator_library|module|lesson|material)/.test(action)) return "creation";
  return "account";
}

function labelFor(action: string): string {
  return action.split(".")
    .map((part) => part.replaceAll("_", " "))
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" · ");
}

function deletable(action: string): boolean {
  return [
    "profile.updated",
    "profile.avatar_updated",
    "preferences.updated",
    "content.opened",
    "learning.product_opened",
    "search.performed"
  ].includes(action);
}

function redact(value: unknown, depth = 0): unknown {
  if (depth > 4) return "[truncated]";
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => redact(item, depth + 1));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .slice(0, 30)
      .map(([key, entry]) => [key, SECRET_KEY.test(key) ? "[redacted]" : redact(entry, depth + 1)]));
  }
  return typeof value === "string" && value.length > 500 ? `${value.slice(0, 500)}…` : value;
}

function metadata(raw: string): Record<string, unknown> {
  try {
    const clean = redact(JSON.parse(raw) as unknown);
    return clean && typeof clean === "object" && !Array.isArray(clean)
      ? clean as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function publicEvent(row: AuditRow) {
  return {
    id: row.id,
    action: row.action,
    label: labelFor(row.action),
    category: categoryFor(row.action),
    entityType: row.entity_type,
    entityId: row.entity_id,
    metadata: metadata(row.metadata_json),
    occurredAt: row.created_at,
    state: row.state ?? "active",
    archiveId: row.archive_id ?? null,
    canDelete: deletable(row.action)
  };
}

async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function gzip(text: string): Promise<ArrayBuffer> {
  const input = new Blob([text]).stream();
  return new Response(input.pipeThrough(new CompressionStream("gzip"))).arrayBuffer();
}

function selectedIds(input: unknown): string[] {
  if (!input || typeof input !== "object" || !Array.isArray((input as { ids?: unknown }).ids)) return [];
  return [...new Set((input as { ids: unknown[] }).ids
    .filter((id): id is string => typeof id === "string")
    .map((id) => id.trim())
    .filter((id) => id.length > 0))].slice(0, MAX_SELECTION);
}

async function ownedRows(env: ApiEnvironment, actorId: string, ids: string[]): Promise<AuditRow[]> {
  if (!ids.length) return [];
  const placeholders = ids.map(() => "?").join(",");
  const result = await env.DB.prepare(
    `SELECT a.id, a.action, a.entity_type, a.entity_id, a.metadata_json, a.created_at,
      COALESCE(s.state, 'active') AS state, s.archive_id
     FROM audit_logs a LEFT JOIN action_history_states s ON s.audit_log_id = a.id AND s.user_id = a.actor_user_id
     WHERE a.actor_user_id = ? AND a.id IN (${placeholders})`
  ).bind(actorId, ...ids).all<AuditRow>();
  return result.results;
}

async function list(request: Request, env: ApiEnvironment, actorId: string): Promise<Response> {
  const url = new URL(request.url);
  const requestedState = url.searchParams.get("status");
  const state: HistoryState = requestedState === "archived" || requestedState === "deleted" ? requestedState : "active";
  const category = url.searchParams.get("category")?.trim().toLowerCase() ?? "all";
  const query = url.searchParams.get("q")?.trim().slice(0, 100).toLowerCase() ?? "";
  const limit = Math.min(100, Math.max(10, Number(url.searchParams.get("limit")) || 50));
  const result = await env.DB.prepare(
    `SELECT a.id, a.action, a.entity_type, a.entity_id, a.metadata_json, a.created_at,
      COALESCE(s.state, 'active') AS state, s.archive_id
     FROM audit_logs a LEFT JOIN action_history_states s ON s.audit_log_id = a.id AND s.user_id = a.actor_user_id
     WHERE a.actor_user_id = ? AND COALESCE(s.state, 'active') = ?
       AND (? = '' OR LOWER(a.action) LIKE ? OR LOWER(a.entity_type) LIKE ? OR LOWER(COALESCE(a.entity_id, '')) LIKE ?)
     ORDER BY a.created_at DESC LIMIT ?`
  ).bind(actorId, state, query, `%${query}%`, `%${query}%`, `%${query}%`, limit).all<AuditRow>();
  const allEvents = result.results.map(publicEvent);
  const events = category === "all" ? allEvents : allEvents.filter((event) => event.category === category);
  const archives = state === "archived" ? (await env.DB.prepare(
    `SELECT id, event_count, first_event_at, last_event_at, size_bytes, created_at
     FROM action_history_archives WHERE user_id = ? AND status = 'active' ORDER BY created_at DESC LIMIT 100`
  ).bind(actorId).all()).results : [];
  return json({ events, archives, state, retentionNotice: "Security, payment, assessment, publishing and permission records can be archived but cannot be deleted." });
}

async function archive(request: Request, env: ApiEnvironment, actorId: string): Promise<Response> {
  let input: unknown;
  try { input = await request.json(); } catch { return problem(400, "invalid_json", "A JSON body is required."); }
  const ids = selectedIds(input);
  if (!ids.length) return problem(400, "history_selection_required", "Choose at least one history item to archive.");
  const rows = (await ownedRows(env, actorId, ids)).filter((row) => (row.state ?? "active") === "active");
  if (rows.length !== ids.length) return problem(409, "history_selection_changed", "Some selected history items are no longer available. Refresh and try again.");

  const archiveId = crypto.randomUUID();
  const sorted = [...rows].sort((a, b) => a.created_at.localeCompare(b.created_at));
  const payload = `${sorted.map((row) => JSON.stringify({ version: 1, ...publicEvent(row) })).join("\n")}\n`;
  const compressed = await gzip(payload);
  const checksum = await sha256Hex(compressed);
  const month = sorted[0].created_at.slice(0, 7).replace("-", "/");
  const userShard = actorId.replaceAll("-", "").slice(0, 4) || "user";
  const storageKey = `action-history/v1/${env.ENVIRONMENT}/${month}/${userShard}/${actorId}/${archiveId}.ndjson.gz`;
  await env.ACTION_ARCHIVE.put(storageKey, compressed, {
    httpMetadata: { contentType: "application/x-ndjson", contentEncoding: "gzip" },
    customMetadata: { archiveId, userId: actorId, checksumSha256: checksum, version: "1" }
  });

  const now = new Date().toISOString();
  const statements = [
    env.DB.prepare(
      `INSERT INTO action_history_archives
        (id, user_id, storage_key, event_count, first_event_at, last_event_at,
         checksum_sha256, size_bytes, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)`
    ).bind(archiveId, actorId, storageKey, sorted.length, sorted[0].created_at,
      sorted[sorted.length - 1].created_at, checksum, compressed.byteLength, now),
    ...sorted.map((row) => env.DB.prepare(
      `INSERT INTO action_history_states
        (audit_log_id, user_id, state, archive_id, archived_at, restored_at, deleted_at, updated_at)
       VALUES (?, ?, 'archived', ?, ?, NULL, NULL, ?)
       ON CONFLICT(audit_log_id) DO UPDATE SET state = 'archived', archive_id = excluded.archive_id,
         archived_at = excluded.archived_at, restored_at = NULL, deleted_at = NULL, updated_at = excluded.updated_at`
    ).bind(row.id, actorId, archiveId, now, now)),
    env.DB.prepare(
      `INSERT INTO audit_logs (id, actor_user_id, action, entity_type, entity_id, metadata_json, created_at)
       VALUES (?, ?, 'history.archived', 'action_history_archive', ?, ?, ?)`
    ).bind(crypto.randomUUID(), actorId, archiveId, JSON.stringify({ eventCount: sorted.length }), now)
  ];
  try {
    await env.DB.batch(statements);
  } catch (error) {
    await env.ACTION_ARCHIVE.delete(storageKey);
    throw error;
  }
  return json({ archive: { id: archiveId, eventCount: sorted.length, createdAt: now } }, { status: 201 });
}

async function restore(request: Request, env: ApiEnvironment, actorId: string): Promise<Response> {
  let input: unknown;
  try { input = await request.json(); } catch { return problem(400, "invalid_json", "A JSON body is required."); }
  const ids = selectedIds(input);
  if (!ids.length) return problem(400, "history_selection_required", "Choose at least one archived history item to restore.");
  const rows = (await ownedRows(env, actorId, ids)).filter((row) => row.state === "archived" || row.state === "deleted");
  if (rows.length !== ids.length) return problem(409, "history_selection_changed", "Some selected history items cannot be restored. Refresh and try again.");
  const now = new Date().toISOString();
  await env.DB.batch([
    ...rows.map((row) => env.DB.prepare(
      `UPDATE action_history_states SET state = 'active', archive_id = NULL, restored_at = ?, deleted_at = NULL, updated_at = ?
       WHERE audit_log_id = ? AND user_id = ?`
    ).bind(now, now, row.id, actorId)),
    env.DB.prepare(
      `INSERT INTO audit_logs (id, actor_user_id, action, entity_type, entity_id, metadata_json, created_at)
       VALUES (?, ?, 'history.restored', 'action_history', NULL, ?, ?)`
    ).bind(crypto.randomUUID(), actorId, JSON.stringify({ eventCount: rows.length }), now)
  ]);
  return json({ restored: rows.length });
}

async function remove(request: Request, env: ApiEnvironment, actorId: string): Promise<Response> {
  let input: unknown;
  try { input = await request.json(); } catch { return problem(400, "invalid_json", "A JSON body is required."); }
  const ids = selectedIds(input);
  if (!ids.length) return problem(400, "history_selection_required", "Choose at least one history item to delete.");
  const rows = await ownedRows(env, actorId, ids);
  const blocked = rows.filter((row) => !deletable(row.action)).map((row) => row.id);
  if (rows.length !== ids.length || blocked.length) {
    return json({ error: { code: "history_retention_required", message: "Some selected records must be retained for security, payment or accountability purposes." }, blockedIds: blocked }, { status: 409 });
  }
  const now = new Date().toISOString();
  await env.DB.batch([
    ...rows.map((row) => env.DB.prepare(
      `INSERT INTO action_history_states
        (audit_log_id, user_id, state, archive_id, archived_at, restored_at, deleted_at, updated_at)
       VALUES (?, ?, 'deleted', NULL, NULL, NULL, ?, ?)
       ON CONFLICT(audit_log_id) DO UPDATE SET state = 'deleted', archive_id = NULL,
         deleted_at = excluded.deleted_at, updated_at = excluded.updated_at`
    ).bind(row.id, actorId, now, now)),
    env.DB.prepare(
      `INSERT INTO audit_logs (id, actor_user_id, action, entity_type, entity_id, metadata_json, created_at)
       VALUES (?, ?, 'history.deleted', 'action_history', NULL, ?, ?)`
    ).bind(crypto.randomUUID(), actorId, JSON.stringify({ eventCount: rows.length }), now)
  ]);
  return json({ deleted: rows.length, recoverable: true });
}

export async function handleActionHistoryRequest(request: Request, env: ApiEnvironment, pathname: string): Promise<Response | null> {
  if (!pathname.startsWith("/api/action-history")) return null;
  const actor = await getCreatorActorById(userId(request), env.DB);
  if (!actor) return problem(401, "authentication_required", "Sign in to view your action history.");
  if (pathname === "/api/action-history" && request.method === "GET") return list(request, env, actor.id);
  if (pathname === "/api/action-history/archive" && request.method === "POST") return archive(request, env, actor.id);
  if (pathname === "/api/action-history/restore" && request.method === "POST") return restore(request, env, actor.id);
  if (pathname === "/api/action-history/delete" && request.method === "POST") return remove(request, env, actor.id);
  return problem(404, "action_history_route_not_found", "Action History route not found.");
}
