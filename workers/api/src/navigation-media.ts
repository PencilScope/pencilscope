import { json, problem } from "../../../src/lib/http";
import type { ApiEnvironment } from "./index";

type ActiveUser = {
  id: string;
  email: string;
  display_name: string;
  avatar_asset_id: string | null;
};

function actorId(request: Request): string | null {
  return request.headers.get("x-pencilscope-user-id")?.trim() || null;
}

async function activeUser(request: Request, env: ApiEnvironment): Promise<ActiveUser | null> {
  const id = actorId(request);
  if (!id) return null;
  return env.DB.prepare(
    "SELECT id, email, display_name, avatar_asset_id FROM users WHERE id = ? AND status = 'active'"
  ).bind(id).first<ActiveUser>();
}

async function parseBody(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const value = await request.json();
    return value && typeof value === "object" ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function bodyText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const body = value.trim();
  return body.length >= 1 && body.length <= 2000 ? body : null;
}

async function navigationState(request: Request, env: ApiEnvironment): Promise<Response> {
  const actor = await activeUser(request, env);
  if (!actor) return problem(401, "authentication_required", "Sign in to continue.");
  const now = new Date().toISOString();
  const [notifications, unreadNotifications, unreadMessages, pendingConnections, billingRole] = await Promise.all([
    env.DB.prepare(
      `SELECT n.id, n.delivered_at, n.read_at, c.title, c.body, c.category, c.priority, c.action_url
       FROM in_app_notifications n JOIN notification_campaigns c ON c.id = n.campaign_id
       WHERE n.user_id = ? AND n.dismissed_at IS NULL AND c.status = 'published'
         AND (c.expires_at IS NULL OR c.expires_at > ?)
       ORDER BY n.delivered_at DESC LIMIT 5`
    ).bind(actor.id, now).all(),
    env.DB.prepare(
      `SELECT COUNT(*) AS total
       FROM in_app_notifications n JOIN notification_campaigns c ON c.id = n.campaign_id
       WHERE n.user_id = ? AND n.read_at IS NULL AND n.dismissed_at IS NULL
         AND c.status = 'published' AND (c.expires_at IS NULL OR c.expires_at > ?)`
    ).bind(actor.id, now).first<{ total: number }>(),
    env.DB.prepare(
      `SELECT COUNT(*) AS total
       FROM connection_messages m JOIN user_connections uc ON uc.id = m.connection_id
       WHERE uc.status = 'accepted' AND (uc.user_low_id = ? OR uc.user_high_id = ?)
         AND m.sender_user_id != ? AND m.read_at IS NULL`
    ).bind(actor.id, actor.id, actor.id).first<{ total: number }>(),
    env.DB.prepare(
      `SELECT COUNT(*) AS total FROM user_connections
       WHERE status = 'pending' AND requester_user_id != ?
         AND (user_low_id = ? OR user_high_id = ?)`
    ).bind(actor.id, actor.id, actor.id).first<{ total: number }>(),
    env.DB.prepare(
      `SELECT CASE WHEN u.role = 'admin' THEN 'system_admin' ELSE pr.role END AS role
       FROM users u LEFT JOIN platform_roles pr ON pr.user_id = u.id
         AND pr.revoked_at IS NULL AND pr.role IN ('system_admin', 'finance', 'support', 'auditor')
       WHERE u.id = ? AND (u.role = 'admin' OR pr.role IS NOT NULL) LIMIT 1`
    ).bind(actor.id).first<{ role: string }>()
  ]);
  return json({
    user: {
      id: actor.id,
      email: actor.email,
      displayName: actor.display_name,
      avatarAssetId: actor.avatar_asset_id,
      billingAccess: Boolean(billingRole)
    },
    notifications: notifications.results,
    unreadNotificationCount: Number(unreadNotifications?.total ?? 0),
    unreadMessageCount: Number(unreadMessages?.total ?? 0),
    pendingConnectionCount: Number(pendingConnections?.total ?? 0)
  });
}

type ConnectionAccess = {
  id: string;
  user_low_id: string;
  user_high_id: string;
  other_user_id: string;
  other_display_name: string;
  other_email: string;
  other_avatar_asset_id: string | null;
};

async function connectionAccess(
  env: ApiEnvironment,
  connectionId: string,
  userId: string
): Promise<ConnectionAccess | null> {
  return env.DB.prepare(
    `SELECT uc.id, uc.user_low_id, uc.user_high_id,
      u.id AS other_user_id, u.display_name AS other_display_name,
      u.email AS other_email, u.avatar_asset_id AS other_avatar_asset_id
     FROM user_connections uc
     JOIN users u ON u.id = CASE WHEN uc.user_low_id = ? THEN uc.user_high_id ELSE uc.user_low_id END
     WHERE uc.id = ? AND uc.status = 'accepted'
       AND (uc.user_low_id = ? OR uc.user_high_id = ?)`
  ).bind(userId, connectionId, userId, userId).first<ConnectionAccess>();
}

function publicPerson(row: ConnectionAccess) {
  return {
    id: row.other_user_id,
    displayName: row.other_display_name,
    email: row.other_email,
    avatarAssetId: row.other_avatar_asset_id
  };
}

async function messages(request: Request, env: ApiEnvironment, pathname: string): Promise<Response> {
  const actor = await activeUser(request, env);
  if (!actor) return problem(401, "authentication_required", "Sign in to view messages.");

  if (request.method === "GET" && pathname === "/api/messages") {
    const connections = await env.DB.prepare(
      `SELECT uc.id, uc.user_low_id, uc.user_high_id,
        u.id AS other_user_id, u.display_name AS other_display_name,
        u.email AS other_email, u.avatar_asset_id AS other_avatar_asset_id
       FROM user_connections uc
       JOIN users u ON u.id = CASE WHEN uc.user_low_id = ? THEN uc.user_high_id ELSE uc.user_low_id END
       WHERE uc.status = 'accepted' AND (uc.user_low_id = ? OR uc.user_high_id = ?)
       ORDER BY uc.updated_at DESC`
    ).bind(actor.id, actor.id, actor.id).all<ConnectionAccess>();
    const threads = await Promise.all(connections.results.map(async (connection) => {
      const [lastMessage, unread] = await Promise.all([
        env.DB.prepare(
          `SELECT id, sender_user_id, body, created_at, read_at
           FROM connection_messages WHERE connection_id = ? ORDER BY created_at DESC LIMIT 1`
        ).bind(connection.id).first(),
        env.DB.prepare(
          `SELECT COUNT(*) AS total FROM connection_messages
           WHERE connection_id = ? AND sender_user_id != ? AND read_at IS NULL`
        ).bind(connection.id, actor.id).first<{ total: number }>()
      ]);
      return {
        id: connection.id,
        other: publicPerson(connection),
        lastMessage,
        unreadCount: Number(unread?.total ?? 0)
      };
    }));
    threads.sort((a, b) => {
      const aTime = (a.lastMessage as { created_at?: string } | null)?.created_at ?? "";
      const bTime = (b.lastMessage as { created_at?: string } | null)?.created_at ?? "";
      return bTime.localeCompare(aTime);
    });
    return json({ threads });
  }

  const match = pathname.match(/^\/api\/messages\/([^/]+)(?:\/(read))?$/);
  if (!match) return problem(404, "not_found", "Message thread not found.");
  const connectionId = decodeURIComponent(match[1]);
  const access = await connectionAccess(env, connectionId, actor.id);
  if (!access) return problem(404, "connection_not_found", "This message thread is not available.");

  if (request.method === "GET" && !match[2]) {
    const rows = await env.DB.prepare(
      `SELECT m.id, m.sender_user_id, m.body, m.created_at, m.read_at,
        u.display_name AS sender_name
       FROM connection_messages m JOIN users u ON u.id = m.sender_user_id
       WHERE m.connection_id = ? ORDER BY m.created_at DESC LIMIT 100`
    ).bind(connectionId).all();
    return json({
      thread: { id: connectionId, other: publicPerson(access) },
      messages: rows.results.reverse()
    });
  }

  if (request.method === "POST" && match[2] === "read") {
    const now = new Date().toISOString();
    const result = await env.DB.prepare(
      `UPDATE connection_messages SET read_at = ?
       WHERE connection_id = ? AND sender_user_id != ? AND read_at IS NULL`
    ).bind(now, connectionId, actor.id).run();
    return json({ updated: Number(result.meta.changes ?? 0) });
  }

  if (request.method === "POST" && !match[2]) {
    const input = await parseBody(request);
    const body = bodyText(input?.body);
    if (!body) return problem(400, "message_required", "Write a message of up to 2,000 characters.");
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    await env.DB.prepare(
      "INSERT INTO connection_messages (id, connection_id, sender_user_id, body, created_at) VALUES (?, ?, ?, ?, ?)"
    ).bind(id, connectionId, actor.id, body, now).run();
    await env.DB.prepare("UPDATE user_connections SET updated_at = ? WHERE id = ?")
      .bind(now, connectionId).run();
    return json({ message: { id, sender_user_id: actor.id, body, created_at: now, read_at: null } }, { status: 201 });
  }
  return problem(405, "method_not_allowed", "Method not allowed.");
}

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

function detectedImage(bytes: Uint8Array): { extension: string; contentType: string } | null {
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { extension: "jpg", contentType: "image/jpeg" };
  }
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return { extension: "png", contentType: "image/png" };
  }
  if (
    String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" &&
    String.fromCharCode(...bytes.slice(8, 12)) === "WEBP"
  ) {
    return { extension: "webp", contentType: "image/webp" };
  }
  return null;
}

async function uploadedImage(request: Request): Promise<
  { file: File; bytes: ArrayBuffer; extension: string; contentType: string } | Response
> {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return problem(400, "invalid_upload", "Choose an image to upload.");
  }
  const value = form.get("image");
  if (!(value instanceof File) || value.size === 0) {
    return problem(400, "image_required", "Choose an image to upload.");
  }
  if (value.size > MAX_IMAGE_BYTES) {
    return problem(413, "image_too_large", "Images must be 5 MB or smaller.");
  }
  const bytes = await value.arrayBuffer();
  const kind = detectedImage(new Uint8Array(bytes.slice(0, 12)));
  if (!kind) return problem(415, "unsupported_image", "Use a JPG, PNG or WebP image.");
  return { file: value, bytes, ...kind };
}

async function persistImage(
  env: ApiEnvironment,
  actor: ActiveUser,
  image: { file: File; bytes: ArrayBuffer; extension: string; contentType: string },
  usageKind: "user_avatar" | "course_cover",
  storagePrefix: string,
  title: string
): Promise<{ id: string; storageKey: string }> {
  const id = crypto.randomUUID();
  const storageKey = `${storagePrefix}/${id}.${image.extension}`;
  const now = new Date().toISOString();
  await env.MEDIA.put(storageKey, image.bytes, {
    httpMetadata: { contentType: image.contentType },
    customMetadata: { ownerUserId: actor.id, usageKind }
  });
  try {
    await env.DB.prepare(
      `INSERT INTO media_assets
        (id, owner_user_id, media_type, provider, storage_key, title, status,
         size_bytes, mime_type, captions_json, usage_kind, created_at, updated_at)
       VALUES (?, ?, 'image', 'r2', ?, ?, 'ready', ?, ?, '[]', ?, ?, ?)`
    ).bind(
      id, actor.id, storageKey, title, image.file.size, image.contentType,
      usageKind, now, now
    ).run();
  } catch (error) {
    await env.MEDIA.delete(storageKey);
    throw error;
  }
  return { id, storageKey };
}

async function archiveOldImage(env: ApiEnvironment, assetId: string | null, storageKey: string | null): Promise<void> {
  if (!assetId) return;
  try {
    await env.DB.prepare("UPDATE media_assets SET status = 'archived', updated_at = ? WHERE id = ?")
      .bind(new Date().toISOString(), assetId).run();
    if (storageKey) await env.MEDIA.delete(storageKey);
  } catch {
    // The newly selected image is already live; stale-media cleanup can be retried later.
  }
}

async function uploadAvatar(request: Request, env: ApiEnvironment): Promise<Response> {
  const actor = await activeUser(request, env);
  if (!actor) return problem(401, "authentication_required", "Sign in to update your profile picture.");
  const image = await uploadedImage(request);
  if (image instanceof Response) return image;
  const old = actor.avatar_asset_id ? await env.DB.prepare(
    "SELECT storage_key FROM media_assets WHERE id = ?"
  ).bind(actor.avatar_asset_id).first<{ storage_key: string | null }>() : null;
  const asset = await persistImage(env, actor, image, "user_avatar", `profiles/${actor.id}`, `${actor.display_name} profile picture`);
  await env.DB.prepare("UPDATE users SET avatar_asset_id = ?, updated_at = ? WHERE id = ?")
    .bind(asset.id, new Date().toISOString(), actor.id).run();
  await archiveOldImage(env, actor.avatar_asset_id, old?.storage_key ?? null);
  return json({ asset: { id: asset.id, url: `/api/media/${asset.id}` } }, { status: 201 });
}

async function uploadCourseCover(
  request: Request,
  env: ApiEnvironment,
  courseId: string
): Promise<Response> {
  const actor = await activeUser(request, env);
  if (!actor) return problem(401, "authentication_required", "Sign in to update a course cover.");
  const course = await env.DB.prepare(
    `SELECT c.id, c.title, c.tutor_id, c.cover_asset_id, ma.storage_key AS old_storage_key,
      EXISTS(SELECT 1 FROM course_members cm WHERE cm.course_id = c.id AND cm.user_id = ?
        AND cm.status = 'active' AND cm.member_role IN ('administrator', 'instructor', 'editor')) AS can_edit
     FROM courses c LEFT JOIN media_assets ma ON ma.id = c.cover_asset_id
     WHERE c.id = ?`
  ).bind(actor.id, courseId).first<{
    id: string; title: string; tutor_id: string | null; cover_asset_id: string | null;
    old_storage_key: string | null; can_edit: number;
  }>();
  if (!course) return problem(404, "course_not_found", "The course does not exist.");
  if (course.tutor_id !== actor.id && !course.can_edit) {
    return problem(403, "course_access_denied", "You do not have permission to update this course.");
  }
  const image = await uploadedImage(request);
  if (image instanceof Response) return image;
  const asset = await persistImage(env, actor, image, "course_cover", `courses/${course.id}/covers`, `${course.title} cover`);
  await env.DB.prepare("UPDATE courses SET cover_asset_id = ?, updated_at = ? WHERE id = ?")
    .bind(asset.id, new Date().toISOString(), course.id).run();
  await archiveOldImage(env, course.cover_asset_id, course.old_storage_key);
  return json({ asset: { id: asset.id, url: `/api/media/${asset.id}` } }, { status: 201 });
}

async function serveMedia(env: ApiEnvironment, assetId: string): Promise<Response> {
  const asset = await env.DB.prepare(
    `SELECT ma.storage_key, ma.mime_type
     FROM media_assets ma
     WHERE ma.id = ? AND ma.provider = 'r2' AND ma.status = 'ready'
       AND (EXISTS(SELECT 1 FROM users u WHERE u.avatar_asset_id = ma.id)
         OR EXISTS(SELECT 1 FROM courses c WHERE c.cover_asset_id = ma.id))`
  ).bind(assetId).first<{ storage_key: string | null; mime_type: string | null }>();
  if (!asset?.storage_key) return problem(404, "media_not_found", "This image is not available.");
  const object = await env.MEDIA.get(asset.storage_key);
  if (!object) return problem(404, "media_not_found", "This image is not available.");
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("content-type", asset.mime_type ?? headers.get("content-type") ?? "application/octet-stream");
  headers.set("cache-control", "public, max-age=31536000, immutable");
  headers.set("etag", object.httpEtag);
  headers.set("x-content-type-options", "nosniff");
  return new Response(object.body, { headers });
}

export async function handleNavigationMediaRequest(
  request: Request,
  env: ApiEnvironment,
  pathname: string
): Promise<Response | null> {
  if (request.method === "GET" && pathname === "/api/navigation-state") {
    return navigationState(request, env);
  }
  if (pathname === "/api/messages" || pathname.startsWith("/api/messages/")) {
    return messages(request, env, pathname);
  }
  if (request.method === "POST" && pathname === "/api/profile/avatar") {
    return uploadAvatar(request, env);
  }
  const courseCover = pathname.match(/^\/api\/tutor\/courses\/([^/]+)\/cover$/);
  if (request.method === "POST" && courseCover) {
    return uploadCourseCover(request, env, decodeURIComponent(courseCover[1]));
  }
  const media = pathname.match(/^\/api\/media\/([^/]+)$/);
  if (request.method === "GET" && media) {
    return serveMedia(env, decodeURIComponent(media[1]));
  }
  return null;
}
