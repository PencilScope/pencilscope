import { json, problem } from "../../../src/lib/http";
import type { ApiEnvironment } from "./index";
import { releaseStorageReservation, reserveStorage, storageUsage } from "./storage-subscriptions";
import { acceptedLibraryFile, libraryUploadPolicy, safeLibraryFilename, validWmvHeader } from "./creator-library-upload-policy";
import {
  catalogueVersionStatements,
  nextAssetVersion,
  recoveryDeadline
} from "./r2-asset-catalogue";

type Actor = { id: string; role: string };
type LibraryItem = {
  id: string; owner_user_id: string; folder_id: string | null; media_asset_id: string | null;
  item_kind: "file" | "link" | "note"; media_type: string; title: string; description: string;
  original_filename: string | null; source_url: string | null; note_text: string | null;
  tags_json: string; status: string; created_at: string; updated_at: string;
  storage_key?: string | null; mime_type?: string | null; size_bytes?: number | null;
  deleted_at?: string | null; recoverable_until?: string | null; purged_at?: string | null;
  current_version_number?: number | null; version_count?: number | null;
};

const actorId = (request: Request) => request.headers.get("x-pencilscope-user-id")?.trim() || null;
async function actor(request: Request, env: ApiEnvironment): Promise<Actor | null> {
  const id = actorId(request);
  if (!id) return null;
  return env.DB.prepare("SELECT id, role FROM users WHERE id = ? AND status = 'active'")
    .bind(id).first<Actor>();
}
function clean(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}
function tags(value: unknown): string[] {
  const input = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
  return [...new Set(input.map((entry) => clean(entry, 40).toLowerCase()).filter(Boolean))].slice(0, 20);
}
function publicItem(item: LibraryItem & { folder_name?: string | null; usage_count?: number | null }) {
  let parsedTags: string[] = [];
  try { parsedTags = JSON.parse(item.tags_json); } catch { parsedTags = []; }
  return {
    id: item.id, folderId: item.folder_id, folderName: item.folder_name ?? null,
    itemKind: item.item_kind, mediaType: item.media_type, title: item.title,
    description: item.description, originalFilename: item.original_filename,
    sourceUrl: item.source_url, noteText: item.note_text, tags: parsedTags,
    status: item.status, sizeBytes: Number(item.size_bytes ?? 0),
    mimeType: item.mime_type ?? null, usageCount: Number(item.usage_count ?? 0),
    currentVersion: Number(item.current_version_number ?? 0) || null,
    versionCount: Number(item.version_count ?? 0),
    deletedAt: item.deleted_at ?? null, recoverableUntil: item.recoverable_until ?? null,
    contentUrl: item.status === "deleted" ? null
      : item.item_kind === "file" ? `/api/creator/content-library/items/${item.id}/content` : item.source_url,
    createdAt: item.created_at, updatedAt: item.updated_at
  };
}
async function ownedItem(env: ApiEnvironment, id: string, userId: string, includeDeleted = false) {
  return env.DB.prepare(
    `SELECT i.*, COALESCE(o.object_key, ma.storage_key) AS storage_key,
       COALESCE(o.mime_type, ma.mime_type) AS mime_type,
       COALESCE(o.size_bytes, ma.size_bytes) AS size_bytes,
       v.version_number AS current_version_number,
       (SELECT COUNT(*) FROM media_asset_versions av WHERE av.media_asset_id = ma.id) AS version_count
     FROM creator_library_items i
     LEFT JOIN media_assets ma ON ma.id = i.media_asset_id
     LEFT JOIN media_asset_versions v ON v.id = ma.current_version_id
     LEFT JOIN r2_asset_objects o ON o.id = v.object_id
     WHERE i.id = ? AND i.owner_user_id = ? AND (? = 1 OR i.status != 'deleted')`
  ).bind(id, userId, includeDeleted ? 1 : 0).first<LibraryItem>();
}
async function audit(env: ApiEnvironment, userId: string, action: string, id: string, metadata: object = {}) {
  await env.DB.prepare(
    `INSERT INTO audit_logs (id, actor_user_id, action, entity_type, entity_id, metadata_json, created_at)
     VALUES (?, ?, ?, 'creator_library_item', ?, ?, ?)`
  ).bind(crypto.randomUUID(), userId, action, id, JSON.stringify(metadata), new Date().toISOString()).run();
}

async function listLibrary(request: Request, env: ApiEnvironment, user: Actor): Promise<Response> {
  const url = new URL(request.url);
  const query = clean(url.searchParams.get("q"), 120).toLowerCase();
  const mediaType = clean(url.searchParams.get("type"), 20);
  const folderId = clean(url.searchParams.get("folder"), 80);
  const status = ["active", "archived", "deleted"].includes(url.searchParams.get("status") ?? "")
    ? String(url.searchParams.get("status")) : "active";
  const conditions = ["i.owner_user_id = ?", "i.status = ?"];
  const values: unknown[] = [user.id, status];
  if (query) {
    conditions.push("(LOWER(i.title) LIKE ? OR LOWER(i.description) LIKE ? OR LOWER(i.tags_json) LIKE ? OR LOWER(COALESCE(i.original_filename, '')) LIKE ?)");
    const pattern = `%${query}%`;
    values.push(pattern, pattern, pattern, pattern);
  }
  if (mediaType && ["video", "audio", "image", "document", "link", "note"].includes(mediaType)) {
    conditions.push("i.media_type = ?");
    values.push(mediaType);
  }
  if (folderId) {
    conditions.push("i.folder_id = ?");
    values.push(folderId);
  }
  const [items, folders, totals, storage] = await Promise.all([
    env.DB.prepare(
      `SELECT i.*, f.name AS folder_name,
        COALESCE(o.mime_type, ma.mime_type) AS mime_type,
        COALESCE(o.size_bytes, ma.size_bytes) AS size_bytes,
        v.version_number AS current_version_number,
        (SELECT COUNT(*) FROM media_asset_versions av WHERE av.media_asset_id = ma.id) AS version_count,
        ((SELECT COUNT(*) FROM creator_library_usages u WHERE u.item_id = i.id) +
         (SELECT COUNT(*) FROM creator_library_resource_links r WHERE r.item_id = i.id) +
         (SELECT COUNT(*) FROM assessment_question_media q WHERE q.library_item_id = i.id)) AS usage_count
       FROM creator_library_items i
       LEFT JOIN creator_library_folders f ON f.id = i.folder_id
       LEFT JOIN media_assets ma ON ma.id = i.media_asset_id
       LEFT JOIN media_asset_versions v ON v.id = ma.current_version_id
       LEFT JOIN r2_asset_objects o ON o.id = v.object_id
       WHERE ${conditions.join(" AND ")}
       ORDER BY i.updated_at DESC LIMIT 200`
    ).bind(...values).all<LibraryItem & { folder_name: string | null; usage_count: number }>(),
    env.DB.prepare(
      `SELECT f.id, f.name, f.created_at,
        (SELECT COUNT(*) FROM creator_library_items i WHERE i.folder_id = f.id AND i.status = 'active') AS item_count
       FROM creator_library_folders f WHERE f.owner_user_id = ? ORDER BY f.name`
    ).bind(user.id).all(),
    env.DB.prepare(
      `SELECT COUNT(*) AS item_count, COALESCE(SUM(ma.size_bytes), 0) AS storage_bytes
       FROM creator_library_items i LEFT JOIN media_assets ma ON ma.id = i.media_asset_id
       WHERE i.owner_user_id = ? AND i.status = 'active'`
    ).bind(user.id).first<{ item_count: number; storage_bytes: number }>(),
    storageUsage(env, user.id)
  ]);
  return json({
    items: items.results.map(publicItem), folders: folders.results,
    totals: { itemCount: Number(totals?.item_count ?? 0), storageBytes: storage.usedBytes },
    storage,
    uploadPolicy: libraryUploadPolicy(env)
  });
}

async function uploadFile(request: Request, env: ApiEnvironment, user: Actor): Promise<Response> {
  let form: FormData;
  try { form = await request.formData(); }
  catch { return problem(400, "invalid_upload", "Choose a file to upload."); }
  const file = form.get("file");
  if (!(file instanceof File) || !file.size) return problem(400, "file_required", "Choose a file to upload.");
  const accepted = acceptedLibraryFile(file.name, file.type);
  if (!accepted) return problem(415, "unsupported_file", "Use an image, PDF, text, audio, MP4, WebM or WMV file.");
  const policy = libraryUploadPolicy(env);
  const directLimit = Math.min(policy.directUploadThresholdBytes, policy.maxBytesByType[accepted.mediaType]);
  if (file.size > directLimit) {
    return problem(413, "resumable_upload_required", "Files larger than " + Math.round(directLimit / 1_000_000) + " MB must use resumable upload.");
  }
  if (accepted.extension === "wmv" && !validWmvHeader(new Uint8Array(await file.slice(0, 16).arrayBuffer()))) {
    return problem(415, "invalid_wmv", "This file does not contain a valid WMV header.");
  }
  const reservation = await reserveStorage(env, user.id, file.size);
  if (!reservation) {
    const usage = await storageUsage(env, user.id);
    return problem(413, "storage_quota_exceeded", `This upload exceeds your ${Math.round(usage.quotaBytes / 1_000_000_000)} GB storage allowance. Upgrade storage or permanently delete unused files.`);
  }
  const folderId = clean(form.get("folderId"), 80) || null;
  if (folderId) {
    const folder = await env.DB.prepare("SELECT 1 FROM creator_library_folders WHERE id = ? AND owner_user_id = ?")
      .bind(folderId, user.id).first();
    if (!folder) {
      await releaseStorageReservation(env, reservation.id);
      return problem(400, "invalid_folder", "Choose one of your content folders.");
    }
  }
  const id = crypto.randomUUID();
  const assetId = crypto.randomUUID();
  const now = new Date().toISOString();
  const originalFilename = file.name.slice(0, 255);
  const storageKey = `creators/${user.id}/assets/${assetId}/versions/${crypto.randomUUID()}/${safeLibraryFilename(originalFilename)}`;
  try {
    const object = await env.MEDIA.put(storageKey, file.stream(), {
      httpMetadata: { contentType: accepted.mimeType },
      customMetadata: { ownerUserId: user.id, libraryItemId: id, mediaAssetId: assetId, version: "1" }
    });
    const version = catalogueVersionStatements(env, {
      ownerUserId: user.id, mediaAssetId: assetId, objectKey: storageKey,
      sizeBytes: file.size, mimeType: accepted.mimeType, etag: object.etag,
      originalFilename, versionNumber: 1, createdAt: now
    });
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO media_assets
          (id, owner_user_id, media_type, provider, storage_key, title, status, size_bytes,
           mime_type, captions_json, created_at, updated_at)
         VALUES (?, ?, ?, 'r2', ?, ?, 'ready', ?, ?, '[]', ?, ?)`
      ).bind(assetId, user.id, accepted.mediaType, storageKey, clean(form.get("title"), 160) || originalFilename,
        file.size, accepted.mimeType, now, now),
      ...version.statements,
      env.DB.prepare("UPDATE media_assets SET current_version_id = ? WHERE id = ?")
        .bind(version.versionId, assetId),
      env.DB.prepare(
        `INSERT INTO creator_library_items
          (id, owner_user_id, folder_id, media_asset_id, item_kind, media_type, title, description,
           original_filename, tags_json, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'file', ?, ?, ?, ?, ?, 'active', ?, ?)`
      ).bind(
        id, user.id, folderId, assetId, accepted.mediaType,
        clean(form.get("title"), 160) || originalFilename, clean(form.get("description"), 2000),
        originalFilename, JSON.stringify(tags(form.get("tags"))), now, now
      )
    ]);
    await audit(env, user.id, "creator_library.uploaded", id, { mediaType: accepted.mediaType, sizeBytes: file.size });
  } catch (error) {
    await env.MEDIA.delete(storageKey);
    throw error;
  } finally {
    await releaseStorageReservation(env, reservation.id);
  }
  const item = await ownedItem(env, id, user.id);
  return json({ item: item ? publicItem(item) : { id } }, { status: 201 });
}

async function uploadVersion(request: Request, env: ApiEnvironment, user: Actor, id: string): Promise<Response> {
  const item = await ownedItem(env, id, user.id);
  if (!item || item.item_kind !== "file" || !item.media_asset_id || item.status !== "active") {
    return problem(404, "library_item_not_found", "Choose an active file from your Content Library.");
  }
  let form: FormData;
  try { form = await request.formData(); }
  catch { return problem(400, "invalid_upload", "Choose a replacement file."); }
  const file = form.get("file");
  if (!(file instanceof File) || !file.size) return problem(400, "file_required", "Choose a replacement file.");
  const accepted = acceptedLibraryFile(file.name, file.type);
  if (!accepted || accepted.mediaType !== item.media_type) {
    return problem(415, "incompatible_version", `New versions must remain ${item.media_type} files.`);
  }
  const policy = libraryUploadPolicy(env);
  const directLimit = Math.min(policy.directUploadThresholdBytes, policy.maxBytesByType[accepted.mediaType]);
  if (file.size > directLimit) {
    return problem(413, "resumable_upload_required", "Large replacement files must use resumable upload with libraryItemId.");
  }
  if (accepted.extension === "wmv" && !validWmvHeader(new Uint8Array(await file.slice(0, 16).arrayBuffer()))) {
    return problem(415, "invalid_wmv", "This file does not contain a valid WMV header.");
  }
  const reservation = await reserveStorage(env, user.id, file.size);
  if (!reservation) return problem(413, "storage_quota_exceeded", "This version exceeds your storage allowance.");
  const versionNumber = await nextAssetVersion(env, item.media_asset_id);
  const now = new Date().toISOString();
  const originalFilename = file.name.slice(0, 255);
  const storageKey = `creators/${user.id}/assets/${item.media_asset_id}/versions/${crypto.randomUUID()}/${safeLibraryFilename(originalFilename)}`;
  try {
    const object = await env.MEDIA.put(storageKey, file.stream(), {
      httpMetadata: { contentType: accepted.mimeType },
      customMetadata: { ownerUserId: user.id, libraryItemId: id, mediaAssetId: item.media_asset_id, version: String(versionNumber) }
    });
    const version = catalogueVersionStatements(env, {
      ownerUserId: user.id, mediaAssetId: item.media_asset_id, objectKey: storageKey,
      sizeBytes: file.size, mimeType: accepted.mimeType, etag: object.etag,
      originalFilename, versionNumber, createdAt: now
    });
    await env.DB.batch([
      ...version.statements,
      env.DB.prepare(
        `UPDATE media_assets SET current_version_id = ?, storage_key = ?, size_bytes = ?, mime_type = ?,
           status = 'ready', updated_at = ? WHERE id = ?`
      ).bind(version.versionId, storageKey, file.size, accepted.mimeType, now, item.media_asset_id),
      env.DB.prepare(
        "UPDATE creator_library_items SET original_filename = ?, updated_at = ? WHERE id = ?"
      ).bind(originalFilename, now, id)
    ]);
    await audit(env, user.id, "creator_library.version_created", id, { versionNumber, sizeBytes: file.size });
    return json({ item: publicItem((await ownedItem(env, id, user.id))!), versionNumber }, { status: 201 });
  } catch (error) {
    await env.MEDIA.delete(storageKey);
    throw error;
  } finally {
    await releaseStorageReservation(env, reservation.id);
  }
}

async function listVersions(env: ApiEnvironment, user: Actor, id: string): Promise<Response> {
  const item = await ownedItem(env, id, user.id, true);
  if (!item?.media_asset_id) return problem(404, "library_item_not_found", "This file is not available.");
  const versions = await env.DB.prepare(
    `SELECT v.id, v.version_number, v.original_filename, v.created_at,
       o.size_bytes, o.mime_type, o.etag, o.purged_at,
       CASE WHEN ma.current_version_id = v.id THEN 1 ELSE 0 END AS is_current
     FROM media_asset_versions v
     JOIN r2_asset_objects o ON o.id = v.object_id
     JOIN media_assets ma ON ma.id = v.media_asset_id
     WHERE v.media_asset_id = ? ORDER BY v.version_number DESC`
  ).bind(item.media_asset_id).all<{
    id: string; version_number: number; original_filename: string | null; created_at: string;
    size_bytes: number; mime_type: string | null; etag: string | null; purged_at: string | null; is_current: number;
  }>();
  return json({ versions: versions.results.map((version) => ({
    id: version.id, versionNumber: version.version_number, originalFilename: version.original_filename,
    sizeBytes: Number(version.size_bytes), mimeType: version.mime_type, etag: version.etag,
    isCurrent: Boolean(version.is_current), available: !version.purged_at, createdAt: version.created_at
  })) });
}

async function restoreVersion(env: ApiEnvironment, user: Actor, id: string, versionId: string): Promise<Response> {
  const item = await ownedItem(env, id, user.id);
  if (!item?.media_asset_id || item.status !== "active") {
    return problem(404, "library_item_not_found", "Choose an active file from your Content Library.");
  }
  const selected = await env.DB.prepare(
    `SELECT v.object_id, v.original_filename, o.object_key, o.size_bytes, o.mime_type
     FROM media_asset_versions v JOIN r2_asset_objects o ON o.id = v.object_id
     WHERE v.id = ? AND v.media_asset_id = ? AND o.purged_at IS NULL`
  ).bind(versionId, item.media_asset_id).first<{
    object_id: string; original_filename: string | null; object_key: string; size_bytes: number; mime_type: string | null;
  }>();
  if (!selected) return problem(404, "asset_version_not_found", "This content version is no longer available.");
  const versionNumber = await nextAssetVersion(env, item.media_asset_id);
  const restoredVersionId = crypto.randomUUID();
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO media_asset_versions
        (id, media_asset_id, object_id, version_number, original_filename, created_by_user_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).bind(restoredVersionId, item.media_asset_id, selected.object_id, versionNumber,
      selected.original_filename, user.id, now),
    env.DB.prepare(
      `UPDATE media_assets SET current_version_id = ?, storage_key = ?, size_bytes = ?, mime_type = ?,
       status = 'ready', updated_at = ? WHERE id = ?`
    ).bind(restoredVersionId, selected.object_key, selected.size_bytes, selected.mime_type, now, item.media_asset_id),
    env.DB.prepare("UPDATE creator_library_items SET original_filename = COALESCE(?, original_filename), updated_at = ? WHERE id = ?")
      .bind(selected.original_filename, now, id)
  ]);
  await audit(env, user.id, "creator_library.version_restored", id, { sourceVersionId: versionId, versionNumber });
  return json({ restored: true, versionNumber, versionId: restoredVersionId });
}

async function createReference(request: Request, env: ApiEnvironment, user: Actor): Promise<Response> {
  let input: Record<string, unknown>;
  try { input = await request.json<Record<string, unknown>>(); }
  catch { return problem(400, "invalid_request", "Provide reference details."); }
  const itemKind = input.itemKind === "note" ? "note" : "link";
  const title = clean(input.title, 160);
  const description = clean(input.description, 2000);
  const noteText = itemKind === "note" ? clean(input.noteText, 20000) : null;
  let sourceUrl: string | null = null;
  if (itemKind === "link") {
    try {
      const parsed = new URL(clean(input.sourceUrl, 2000));
      if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("invalid");
      sourceUrl = parsed.toString();
    } catch { return problem(400, "invalid_url", "Add a valid HTTP or HTTPS reference link."); }
  }
  if (!title || (itemKind === "note" && !noteText)) return problem(400, "invalid_reference", "Add a title and note content.");
  const folderId = clean(input.folderId, 80) || null;
  if (folderId) {
    const folder = await env.DB.prepare("SELECT 1 FROM creator_library_folders WHERE id = ? AND owner_user_id = ?")
      .bind(folderId, user.id).first();
    if (!folder) return problem(400, "invalid_folder", "Choose one of your content folders.");
  }
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO creator_library_items
      (id, owner_user_id, folder_id, item_kind, media_type, title, description, source_url,
       note_text, tags_json, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`
  ).bind(
    id, user.id, folderId, itemKind, itemKind, title, description, sourceUrl, noteText,
    JSON.stringify(tags(input.tags)), now, now
  ).run();
  await audit(env, user.id, `creator_library.${itemKind}.created`, id);
  return json({ item: publicItem((await ownedItem(env, id, user.id))!) }, { status: 201 });
}

async function createFolder(request: Request, env: ApiEnvironment, user: Actor): Promise<Response> {
  let input: Record<string, unknown>;
  try { input = await request.json<Record<string, unknown>>(); }
  catch { return problem(400, "invalid_request", "Add a folder name."); }
  const name = clean(input.name, 80);
  if (!name) return problem(400, "folder_name_required", "Add a folder name.");
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  try {
    await env.DB.prepare(
      "INSERT INTO creator_library_folders (id, owner_user_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)"
    ).bind(id, user.id, name, now, now).run();
  } catch {
    return problem(409, "folder_exists", "You already have a folder with this name.");
  }
  return json({ folder: { id, name, item_count: 0 } }, { status: 201 });
}

async function updateItem(request: Request, env: ApiEnvironment, user: Actor, id: string): Promise<Response> {
  const item = await ownedItem(env, id, user.id);
  if (!item) return problem(404, "library_item_not_found", "This content item is not available.");
  let input: Record<string, unknown>;
  try { input = await request.json<Record<string, unknown>>(); }
  catch { return problem(400, "invalid_request", "Provide content details."); }
  const nextStatus = ["active", "archived"].includes(String(input.status)) ? String(input.status) : item.status;
  const title = clean(input.title, 160) || item.title;
  const description = typeof input.description === "string" ? clean(input.description, 2000) : item.description;
  const nextTags = input.tags === undefined ? item.tags_json : JSON.stringify(tags(input.tags));
  const folderId = input.folderId === null || input.folderId === "" ? null : clean(input.folderId, 80) || item.folder_id;
  if (folderId) {
    const folder = await env.DB.prepare("SELECT 1 FROM creator_library_folders WHERE id = ? AND owner_user_id = ?")
      .bind(folderId, user.id).first();
    if (!folder) return problem(400, "invalid_folder", "Choose one of your content folders.");
  }
  const now = new Date().toISOString();
  await env.DB.prepare(
    "UPDATE creator_library_items SET title = ?, description = ?, tags_json = ?, folder_id = ?, status = ?, updated_at = ? WHERE id = ?"
  ).bind(title, description, nextTags, folderId, nextStatus, now, id).run();
  await audit(env, user.id, nextStatus !== item.status ? `creator_library.${nextStatus}` : "creator_library.updated", id);
  const updated = await ownedItem(env, id, user.id);
  return json({ item: updated ? publicItem(updated) : { id } });
}

async function deleteItem(env: ApiEnvironment, user: Actor, id: string): Promise<Response> {
  const item = await ownedItem(env, id, user.id);
  if (!item) return problem(404, "library_item_not_found", "This content item is not available.");
  const usage = await env.DB.prepare(
    `SELECT
      (SELECT COUNT(*) FROM creator_library_usages WHERE item_id = ?) +
      (SELECT COUNT(*) FROM creator_library_resource_links WHERE item_id = ?) +
      (SELECT COUNT(*) FROM assessment_question_media WHERE library_item_id = ?) AS total`
  ).bind(id, id, id).first<{ total: number }>();
  if (Number(usage?.total ?? 0) > 0) {
    return problem(409, "library_item_in_use", "Archive this item instead. It is currently used by created content.");
  }
  const now = new Date().toISOString();
  const recoverableUntil = recoveryDeadline(env, new Date(now));
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE creator_library_items SET status = 'deleted', deleted_at = ?, recoverable_until = ?,
       purged_at = NULL, updated_at = ? WHERE id = ?`
    ).bind(now, recoverableUntil, now, id),
    ...(item.media_asset_id ? [env.DB.prepare("UPDATE media_assets SET status = 'archived', updated_at = ? WHERE id = ?").bind(now, item.media_asset_id)] : []),
    ...(item.media_asset_id ? [env.DB.prepare(
      `UPDATE r2_asset_objects SET purge_after = ?
       WHERE id IN (SELECT object_id FROM media_asset_versions WHERE media_asset_id = ?) AND purged_at IS NULL`
    ).bind(recoverableUntil, item.media_asset_id)] : [])
  ]);
  await audit(env, user.id, "creator_library.deleted", id, { recoverableUntil });
  return json({ deleted: true, id, recoverableUntil });
}

async function restoreDeletedItem(env: ApiEnvironment, user: Actor, id: string): Promise<Response> {
  const item = await ownedItem(env, id, user.id, true);
  if (!item || item.status !== "deleted") {
    return problem(404, "deleted_library_item_not_found", "This deleted content is not available.");
  }
  if (item.purged_at || !item.recoverable_until || Date.parse(item.recoverable_until) <= Date.now()) {
    return problem(410, "recovery_window_expired", "The seven-day recovery window for this content has expired.");
  }
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE creator_library_items SET status = 'active', deleted_at = NULL, recoverable_until = NULL,
       purged_at = NULL, updated_at = ? WHERE id = ?`
    ).bind(now, id),
    ...(item.media_asset_id ? [
      env.DB.prepare("UPDATE media_assets SET status = 'ready', updated_at = ? WHERE id = ?").bind(now, item.media_asset_id),
      env.DB.prepare(
        `UPDATE r2_asset_objects SET purge_after = NULL
         WHERE id IN (SELECT object_id FROM media_asset_versions WHERE media_asset_id = ?) AND purged_at IS NULL`
      ).bind(item.media_asset_id)
    ] : [])
  ]);
  await audit(env, user.id, "creator_library.recovered", id);
  const restored = await ownedItem(env, id, user.id);
  return json({ restored: true, item: restored ? publicItem(restored) : { id } });
}

async function addUsage(request: Request, env: ApiEnvironment, user: Actor, id: string): Promise<Response> {
  const item = await ownedItem(env, id, user.id);
  if (!item) return problem(404, "library_item_not_found", "This content item is not available.");
  let input: Record<string, unknown>;
  try { input = await request.json<Record<string, unknown>>(); }
  catch { return problem(400, "invalid_request", "Choose content to attach."); }
  const entityType = clean(input.entityType, 30);
  const entityId = clean(input.entityId, 100);
  if (!["course", "learning_product", "lesson", "material"].includes(entityType) || !entityId) {
    return problem(400, "invalid_usage", "Choose a valid product or course.");
  }
  const ownershipSql = entityType === "learning_product"
    ? "SELECT 1 FROM learning_products WHERE id = ? AND creator_id = ?"
    : entityType === "course"
      ? "SELECT 1 FROM courses WHERE id = ? AND tutor_id = ?"
      : entityType === "lesson"
        ? "SELECT 1 FROM lessons l JOIN course_modules m ON m.id = l.module_id JOIN courses c ON c.id = m.course_id WHERE l.id = ? AND c.tutor_id = ?"
        : "SELECT 1 FROM course_materials m JOIN courses c ON c.id = m.course_id WHERE m.id = ? AND c.tutor_id = ?";
  if (!await env.DB.prepare(ownershipSql).bind(entityId, user.id).first()) {
    return problem(403, "content_forbidden", "You cannot attach content to this item.");
  }
  await env.DB.prepare(
    `INSERT OR IGNORE INTO creator_library_usages (item_id, entity_type, entity_id, usage_label, created_at)
     VALUES (?, ?, ?, ?, ?)`
  ).bind(id, entityType, entityId, clean(input.usageLabel, 160), new Date().toISOString()).run();
  await audit(env, user.id, "creator_library.attached", id, { entityType, entityId });
  return json({ attached: true, itemId: id, entityType, entityId });
}

const resourceRoles = new Set([
  "primary_media", "primary_document", "lesson_media", "cover",
  "chapter_reference", "transcript", "captions", "supplement"
]);

async function attachResource(request: Request, env: ApiEnvironment, user: Actor, id: string): Promise<Response> {
  const item = await ownedItem(env, id, user.id);
  if (!item || item.status !== "active") {
    return problem(404, "library_item_not_found", "Choose an active item from your Content Library.");
  }
  let input: Record<string, unknown>;
  try { input = await request.json<Record<string, unknown>>(); }
  catch { return problem(400, "invalid_request", "Choose where to use this content."); }
  const entityType = clean(input.entityType, 30);
  const entityId = clean(input.entityId, 100);
  const role = clean(input.role, 40);
  const position = Math.max(1, Math.round(Number(input.position) || 1));
  const requiredPercent = Math.min(100, Math.max(1, Math.round(Number(input.requiredPercent) || 90)));
  if (!["learning_product", "lesson", "ebook", "ebook_chapter"].includes(entityType)
    || !entityId || !resourceRoles.has(role)) {
    return problem(400, "invalid_resource_link", "Choose a valid content target, role and position.");
  }

  let target: Record<string, unknown> | null = null;
  if (entityType === "learning_product") {
    target = await env.DB.prepare(
      "SELECT id, product_type, status FROM learning_products WHERE id = ? AND creator_id = ?"
    ).bind(entityId, user.id).first<Record<string, unknown>>();
  } else if (entityType === "lesson") {
    target = await env.DB.prepare(
      `SELECT l.id, l.lesson_type, c.status FROM lessons l
       JOIN course_modules m ON m.id = l.module_id JOIN courses c ON c.id = m.course_id
       WHERE l.id = ? AND (c.tutor_id = ? OR EXISTS (
         SELECT 1 FROM course_members cm WHERE cm.course_id = c.id AND cm.user_id = ?
           AND cm.status = 'active' AND cm.member_role IN ('owner', 'administrator', 'editor')
       ))`
    ).bind(entityId, user.id, user.id).first<Record<string, unknown>>();
  } else if (entityType === "ebook") {
    target = await env.DB.prepare(
      "SELECT id, status FROM ebooks WHERE id = ? AND creator_id = ?"
    ).bind(entityId, user.id).first<Record<string, unknown>>();
  } else {
    target = await env.DB.prepare(
      `SELECT ch.id, e.status FROM ebook_chapters ch JOIN ebooks e ON e.id = ch.ebook_id
       WHERE ch.id = ? AND e.creator_id = ?`
    ).bind(entityId, user.id).first<Record<string, unknown>>();
  }
  if (!target) return problem(403, "content_forbidden", "You cannot attach content to this item.");
  if (target.status !== "draft") {
    return problem(409, "draft_required", "Create or edit a draft before changing its Content Library resources.");
  }

  const productType = String(target.product_type ?? "");
  const lessonType = String(target.lesson_type ?? "");
  const compatible = role === "cover" ? item.media_type === "image"
    : role === "primary_media" && productType === "audio" ? item.media_type === "audio"
      : role === "primary_media" && productType === "video" ? item.media_type === "video"
        : role === "primary_document" && productType === "ebook" ? item.media_type === "document"
          : role === "lesson_media" && lessonType === "video" ? item.media_type === "video"
            : ["chapter_reference", "transcript", "captions", "supplement"].includes(role);
  if (!compatible) {
    return problem(409, "incompatible_library_item", "This library item's media type does not match the selected product resource role.");
  }
  if (item.media_type === "video" && ["video/x-ms-wmv", "video/x-ms-asf"].includes(item.mime_type ?? "")
    && ["primary_media", "lesson_media"].includes(role)) {
    return problem(409, "wmv_playback_unsupported", "WMV files can be supplied as downloads, but use MP4 or WebM for in-page video playback.");
  }

  const now = new Date().toISOString();
  const statements = [
    env.DB.prepare(
      "DELETE FROM creator_library_resource_links WHERE entity_type = ? AND entity_id = ? AND resource_role = ? AND position = ?"
    ).bind(entityType, entityId, role, position),
    env.DB.prepare(
      `INSERT INTO creator_library_resource_links
        (id, item_id, owner_user_id, entity_type, entity_id, resource_role, position, required_percent, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(crypto.randomUUID(), id, user.id, entityType, entityId, role, position, requiredPercent, now)
  ];
  if (entityType === "learning_product" && ["primary_media", "primary_document"].includes(role)) {
    statements.push(env.DB.prepare(
      "UPDATE learning_products SET content_url = ?, updated_at = ? WHERE id = ?"
    ).bind("/api/creator/content-library/items/" + id + "/content", now, entityId));
  }
  if (entityType === "lesson" && role === "lesson_media" && item.media_asset_id) {
    statements.push(env.DB.prepare(
      `INSERT INTO lesson_media (lesson_id, media_asset_id, position, required_percent)
       VALUES (?, ?, ?, ?) ON CONFLICT(lesson_id, media_asset_id) DO UPDATE SET
       position = excluded.position, required_percent = excluded.required_percent`
    ).bind(entityId, item.media_asset_id, position, requiredPercent));
  }
  if (entityType === "ebook" && role === "cover" && item.media_asset_id) {
    statements.push(env.DB.prepare("UPDATE ebooks SET cover_asset_id = ?, updated_at = ? WHERE id = ?")
      .bind(item.media_asset_id, now, entityId));
  }
  await env.DB.batch(statements);
  await audit(env, user.id, "creator_library.resource_attached", id, { entityType, entityId, role, position });
  return json({
    attached: true,
    resource: { libraryItemId: id, entityType, entityId, role, position, requiredPercent }
  });
}

async function canReadContent(env: ApiEnvironment, item: LibraryItem, userId: string): Promise<boolean> {
  if (item.owner_user_id === userId) return true;
  const access = await env.DB.prepare(
    `SELECT 1 FROM creator_library_usages u
     WHERE u.item_id = ? AND (
       (u.entity_type = 'learning_product' AND (
         EXISTS(SELECT 1 FROM learning_product_entitlements e
           WHERE e.learning_product_id = u.entity_id AND e.user_id = ? AND e.status IN ('active', 'completed'))
         OR EXISTS(SELECT 1 FROM course_offering_learning_products olp
           JOIN enrolment_offerings eo ON eo.course_offering_id = olp.course_offering_id
           WHERE olp.learning_product_id = u.entity_id AND eo.student_user_id = ? AND eo.status IN ('active', 'completed'))
       ))
       OR (u.entity_type = 'course' AND EXISTS(
         SELECT 1 FROM enrolment_offerings eo WHERE eo.course_id = u.entity_id
           AND eo.student_user_id = ? AND eo.status IN ('active', 'completed')
       ))
     ) LIMIT 1`
  ).bind(item.id, userId, userId, userId).first();
  if (access) return true;
  const resourceAccess = await env.DB.prepare(
    `SELECT 1 FROM creator_library_resource_links r WHERE r.item_id = ? AND (
      (r.entity_type = 'learning_product' AND (
        EXISTS(SELECT 1 FROM learning_product_entitlements e
          WHERE e.learning_product_id = r.entity_id AND e.user_id = ? AND e.status IN ('active', 'completed'))
        OR EXISTS(SELECT 1 FROM course_offering_learning_products olp
          JOIN enrolment_offerings eo ON eo.course_offering_id = olp.course_offering_id
          WHERE olp.learning_product_id = r.entity_id AND eo.student_user_id = ?
            AND eo.status IN ('active', 'completed'))
      ))
      OR (r.entity_type = 'lesson' AND EXISTS(
        SELECT 1 FROM lessons l JOIN course_modules m ON m.id = l.module_id
        JOIN enrolment_offerings eo ON eo.course_id = m.course_id
        WHERE l.id = r.entity_id AND eo.student_user_id = ? AND eo.status IN ('active', 'completed')
      ))
      OR (r.entity_type = 'ebook' AND EXISTS(
        SELECT 1 FROM ebooks e WHERE e.id = r.entity_id AND (
          EXISTS(SELECT 1 FROM learning_product_entitlements le
            WHERE le.learning_product_id = e.learning_product_id AND le.user_id = ?
              AND le.status IN ('active', 'completed'))
          OR EXISTS(SELECT 1 FROM course_offering_learning_products olp
            JOIN enrolment_offerings eo ON eo.course_offering_id = olp.course_offering_id
            WHERE olp.learning_product_id = e.learning_product_id AND eo.student_user_id = ?
              AND eo.status IN ('active', 'completed'))
        )
      ))
      OR (r.entity_type = 'ebook_chapter' AND EXISTS(
        SELECT 1 FROM ebook_chapters ch JOIN ebooks e ON e.id = ch.ebook_id
        JOIN learning_product_entitlements le ON le.learning_product_id = e.learning_product_id
        WHERE ch.id = r.entity_id AND le.user_id = ? AND le.status IN ('active', 'completed')
      ))
    ) LIMIT 1`
  ).bind(item.id, userId, userId, userId, userId, userId, userId).first();
  return Boolean(resourceAccess);
}

async function serveContent(env: ApiEnvironment, user: Actor, id: string): Promise<Response> {
  const item = await env.DB.prepare(
    `SELECT i.*, COALESCE(o.object_key, ma.storage_key) AS storage_key,
       COALESCE(o.mime_type, ma.mime_type) AS mime_type,
       COALESCE(o.size_bytes, ma.size_bytes) AS size_bytes
     FROM creator_library_items i JOIN media_assets ma ON ma.id = i.media_asset_id
     LEFT JOIN media_asset_versions v ON v.id = ma.current_version_id
     LEFT JOIN r2_asset_objects o ON o.id = v.object_id AND o.purged_at IS NULL
     WHERE i.id = ? AND i.status IN ('active', 'archived') AND ma.status = 'ready'`
  ).bind(id).first<LibraryItem>();
  if (!item?.storage_key || !await canReadContent(env, item, user.id)) {
    return problem(404, "library_content_not_found", "This private content is not available.");
  }
  const object = await env.MEDIA.get(item.storage_key);
  if (!object) return problem(404, "library_content_not_found", "This private content is not available.");
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("content-type", item.mime_type ?? "application/octet-stream");
  headers.set("content-length", String(item.size_bytes ?? object.size));
  const disposition = ["video/x-ms-wmv", "video/x-ms-asf"].includes(item.mime_type ?? "") ? "attachment" : "inline";
  headers.set("content-disposition", disposition + '; filename="' + safeLibraryFilename(item.original_filename ?? item.title) + '"');
  headers.set("cache-control", "private, no-store");
  headers.set("x-content-type-options", "nosniff");
  return new Response(object.body, { headers });
}

export async function handleCreatorLibraryRequest(
  request: Request,
  env: ApiEnvironment,
  pathname: string
): Promise<Response | null> {
  if (!pathname.startsWith("/api/creator/content-library")) return null;
  const user = await actor(request, env);
  if (!user) return problem(401, "authentication_required", "Sign in to use your Content Library.");
  if (pathname === "/api/creator/content-library") {
    if (request.method === "GET") return listLibrary(request, env, user);
    if (request.method === "POST") {
      return request.headers.get("content-type")?.includes("multipart/form-data")
        ? uploadFile(request, env, user) : createReference(request, env, user);
    }
  }
  if (pathname === "/api/creator/content-library/folders" && request.method === "POST") {
    return createFolder(request, env, user);
  }
  const versionMatch = pathname.match(
    /^\/api\/creator\/content-library\/items\/([^/]+)\/versions(?:\/([^/]+)\/restore)?$/
  );
  if (versionMatch) {
    const id = decodeURIComponent(versionMatch[1]);
    if (!versionMatch[2] && request.method === "GET") return listVersions(env, user, id);
    if (!versionMatch[2] && request.method === "POST") return uploadVersion(request, env, user, id);
    if (versionMatch[2] && request.method === "POST") {
      return restoreVersion(env, user, id, decodeURIComponent(versionMatch[2]));
    }
    return problem(405, "method_not_allowed", "Method not allowed.");
  }
  const recoveryMatch = pathname.match(/^\/api\/creator\/content-library\/items\/([^/]+)\/restore$/);
  if (recoveryMatch) {
    return request.method === "POST"
      ? restoreDeletedItem(env, user, decodeURIComponent(recoveryMatch[1]))
      : problem(405, "method_not_allowed", "Method not allowed.");
  }
  const match = pathname.match(/^\/api\/creator\/content-library\/items\/([^/]+)(?:\/(content|usages|attachments))?$/);
  if (!match) return problem(404, "library_route_not_found", "Content Library route not found.");
  const id = decodeURIComponent(match[1]);
  if (match[2] === "content" && request.method === "GET") return serveContent(env, user, id);
  if (match[2] === "usages" && request.method === "POST") return addUsage(request, env, user, id);
  if (match[2] === "attachments" && request.method === "POST") return attachResource(request, env, user, id);
  if (!match[2] && request.method === "GET") {
    const item = await ownedItem(env, id, user.id);
    if (!item) return problem(404, "library_item_not_found", "This content item is not available.");
    return json({ item: publicItem(item) });
  }
  if (!match[2] && request.method === "PATCH") return updateItem(request, env, user, id);
  if (!match[2] && request.method === "DELETE") return deleteItem(env, user, id);
  return problem(405, "method_not_allowed", "Method not allowed.");
}
