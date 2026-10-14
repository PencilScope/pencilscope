import { json, problem } from "../../../src/lib/http";
import type { ApiEnvironment } from "./index";
import { releaseStorageReservation, reserveStorage, storageUsage } from "./storage-subscriptions";
import { acceptedLibraryFile, libraryUploadPolicy, safeLibraryFilename, validWmvHeader } from "./creator-library-upload-policy";
import { catalogueVersionStatements, nextAssetVersion } from "./r2-asset-catalogue";

type Actor = { id: string };
type UploadRow = {
  id: string; user_id: string; reservation_id: string; r2_upload_id: string; storage_key: string;
  original_filename: string; mime_type: string; media_type: "video" | "audio" | "image" | "document";
  total_bytes: number; part_size_bytes: number; title: string; description: string; folder_id: string | null;
  tags_json: string; status: string; expires_at: string; created_at: string; updated_at: string;
  target_library_item_id: string | null;
};
type PartRow = { part_number: number; etag: string; size_bytes: number; uploaded_at: string };

const actorId = (request: Request) => request.headers.get("x-pencilscope-user-id")?.trim() || null;
async function actor(request: Request, env: ApiEnvironment): Promise<Actor | null> {
  const id = actorId(request);
  if (!id) return null;
  return env.DB.prepare("SELECT id FROM users WHERE id = ? AND status = 'active'").bind(id).first<Actor>();
}
const clean = (value: unknown, max: number) => typeof value === "string" ? value.trim().slice(0, max) : "";
function cleanTags(value: unknown): string[] {
  const input = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
  return [...new Set(input.map((entry) => clean(entry, 40).toLowerCase()).filter(Boolean))].slice(0, 20);
}
async function ownedUpload(env: ApiEnvironment, id: string, userId: string) {
  return env.DB.prepare("SELECT * FROM creator_library_multipart_uploads WHERE id = ? AND user_id = ?")
    .bind(id, userId).first<UploadRow>();
}
async function expireIfNeeded(env: ApiEnvironment, upload: UploadRow): Promise<boolean> {
  if (Date.parse(upload.expires_at) > Date.now()) return false;
  try { await env.MEDIA.resumeMultipartUpload(upload.storage_key, upload.r2_upload_id).abort(); } catch { /* already unavailable */ }
  await env.DB.prepare("UPDATE creator_library_multipart_uploads SET status = 'expired', updated_at = ? WHERE id = ? AND status = 'uploading'")
    .bind(new Date().toISOString(), upload.id).run();
  await releaseStorageReservation(env, upload.reservation_id);
  return true;
}

async function initiate(request: Request, env: ApiEnvironment, user: Actor): Promise<Response> {
  let input: Record<string, unknown>;
  try { input = await request.json<Record<string, unknown>>(); }
  catch { return problem(400, "invalid_upload", "Choose a file to upload."); }
  const filename = clean(input.filename, 255);
  const totalBytes = Math.trunc(Number(input.sizeBytes));
  const accepted = acceptedLibraryFile(filename, clean(input.mimeType, 120));
  if (!filename || !Number.isSafeInteger(totalBytes) || totalBytes <= 0) return problem(400, "invalid_upload", "Choose a valid file to upload.");
  if (!accepted) return problem(415, "unsupported_file", "Use an image, PDF, text, audio, MP4, WebM or WMV file.");
  const policy = libraryUploadPolicy(env);
  const typeLimit = policy.maxBytesByType[accepted.mediaType];
  if (totalBytes > typeLimit) {
    return problem(413, "file_too_large", `${accepted.mediaType[0].toUpperCase() + accepted.mediaType.slice(1)} files must be ${Math.round(typeLimit / 1_000_000)} MB or smaller.`);
  }
  const folderId = clean(input.folderId, 80) || null;
  if (folderId && !await env.DB.prepare("SELECT 1 FROM creator_library_folders WHERE id = ? AND owner_user_id = ?").bind(folderId, user.id).first()) {
    return problem(400, "invalid_folder", "Choose one of your content folders.");
  }
  const targetLibraryItemId = clean(input.libraryItemId, 80) || null;
  const target = targetLibraryItemId ? await env.DB.prepare(
    `SELECT id, media_asset_id, media_type, status FROM creator_library_items
     WHERE id = ? AND owner_user_id = ? AND item_kind = 'file'`
  ).bind(targetLibraryItemId, user.id).first<{
    id: string; media_asset_id: string | null; media_type: string; status: string;
  }>() : null;
  if (targetLibraryItemId && (!target || !target.media_asset_id || target.status !== "active")) {
    return problem(404, "library_item_not_found", "Choose an active file from your Content Library.");
  }
  if (target && target.media_type !== accepted.mediaType) {
    return problem(415, "incompatible_version", `New versions must remain ${target.media_type} files.`);
  }
  const reservation = await reserveStorage(env, user.id, totalBytes, policy.resumeHours * 3_600_000);
  if (!reservation) {
    const usage = await storageUsage(env, user.id);
    return problem(413, "storage_quota_exceeded", `This upload exceeds your ${Math.round(usage.quotaBytes / 1_000_000_000)} GB storage allowance. Upgrade storage or permanently delete unused files.`);
  }
  const id = crypto.randomUUID();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + policy.resumeHours * 3_600_000).toISOString();
  const storageKey = target?.media_asset_id
    ? `creators/${user.id}/assets/${target.media_asset_id}/versions/${id}/${safeLibraryFilename(filename)}`
    : `creators/${user.id}/uploads/${id}/${safeLibraryFilename(filename)}`;
  let multipart: R2MultipartUpload | null = null;
  try {
    multipart = await env.MEDIA.createMultipartUpload(storageKey, {
      httpMetadata: { contentType: accepted.mimeType },
      customMetadata: { ownerUserId: user.id, libraryUploadId: id, originalFilename: filename }
    });
    await env.DB.prepare(
      `INSERT INTO creator_library_multipart_uploads
        (id, user_id, reservation_id, r2_upload_id, storage_key, original_filename, mime_type, media_type,
         total_bytes, part_size_bytes, title, description, folder_id, tags_json, status, expires_at, created_at, updated_at,
         target_library_item_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'uploading', ?, ?, ?, ?)`
    ).bind(id, user.id, reservation.id, multipart.uploadId, storageKey, filename, accepted.mimeType, accepted.mediaType,
      totalBytes, policy.partSizeBytes, clean(input.title, 160) || filename, clean(input.description, 2000), folderId,
      JSON.stringify(cleanTags(input.tags)), expiresAt, now.toISOString(), now.toISOString(), targetLibraryItemId).run();
  } catch (error) {
    if (multipart) try { await multipart.abort(); } catch { /* best effort */ }
    await releaseStorageReservation(env, reservation.id);
    console.error("library.multipart.initiate_failed", { userId: user.id, error });
    return problem(502, "upload_start_failed", "The resumable upload could not be started.");
  }
  return json({ upload: { id, filename, totalBytes, partSizeBytes: policy.partSizeBytes, expiresAt, uploadedParts: [] } }, { status: 201 });
}

async function uploadPart(request: Request, env: ApiEnvironment, user: Actor, id: string, partNumber: number): Promise<Response> {
  const upload = await ownedUpload(env, id, user.id);
  if (!upload || upload.status !== "uploading") return problem(404, "upload_not_found", "This resumable upload is not available.");
  if (await expireIfNeeded(env, upload)) return problem(410, "upload_expired", "This upload expired. Start it again.");
  const expectedParts = Math.ceil(upload.total_bytes / upload.part_size_bytes);
  if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > expectedParts) return problem(400, "invalid_part", "Choose a valid upload part.");
  const expectedSize = Math.min(upload.part_size_bytes, upload.total_bytes - (partNumber - 1) * upload.part_size_bytes);
  const contentLength = Number(request.headers.get("content-length") ?? request.headers.get("x-pencilscope-part-size"));
  if (!Number.isSafeInteger(contentLength) || contentLength !== expectedSize) return problem(400, "invalid_part_size", `Upload part ${partNumber} must contain ${expectedSize} bytes.`);
  let body: ReadableStream | ArrayBuffer;
  if (upload.mime_type === "video/x-ms-wmv" && partNumber === 1) {
    const buffer = await request.arrayBuffer();
    if (!validWmvHeader(new Uint8Array(buffer, 0, Math.min(16, buffer.byteLength)))) {
      return problem(415, "invalid_wmv", "This file does not contain a valid WMV header.");
    }
    body = buffer;
  } else {
    if (!request.body) return problem(400, "empty_part", "This upload part is empty.");
    body = request.body;
  }
  try {
    const result = await env.MEDIA.resumeMultipartUpload(upload.storage_key, upload.r2_upload_id).uploadPart(partNumber, body);
    const now = new Date().toISOString();
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO creator_library_multipart_parts (upload_id, part_number, etag, size_bytes, uploaded_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(upload_id, part_number) DO UPDATE SET etag = excluded.etag,
           size_bytes = excluded.size_bytes, uploaded_at = excluded.uploaded_at`
      ).bind(upload.id, partNumber, result.etag, expectedSize, now),
      env.DB.prepare("UPDATE creator_library_multipart_uploads SET updated_at = ? WHERE id = ?").bind(now, upload.id)
    ]);
    return json({ part: { partNumber, etag: result.etag, sizeBytes: expectedSize } });
  } catch (error) {
    console.error("library.multipart.part_failed", { uploadId: upload.id, partNumber, error });
    return problem(502, "upload_part_failed", `Part ${partNumber} could not be uploaded. Retry this part.`);
  }
}

async function status(env: ApiEnvironment, user: Actor, id: string): Promise<Response> {
  const upload = await ownedUpload(env, id, user.id);
  if (!upload) return problem(404, "upload_not_found", "This resumable upload is not available.");
  if (upload.status === "uploading" && await expireIfNeeded(env, upload)) return problem(410, "upload_expired", "This upload expired. Start it again.");
  const parts = await env.DB.prepare(
    "SELECT part_number, etag, size_bytes, uploaded_at FROM creator_library_multipart_parts WHERE upload_id = ? ORDER BY part_number"
  ).bind(upload.id).all<PartRow>();
  return json({ upload: {
    id: upload.id, filename: upload.original_filename, totalBytes: upload.total_bytes,
    partSizeBytes: upload.part_size_bytes, status: upload.status, expiresAt: upload.expires_at,
    uploadedParts: parts.results.map((part) => ({ partNumber: part.part_number, etag: part.etag, sizeBytes: part.size_bytes }))
  } });
}

async function complete(env: ApiEnvironment, user: Actor, id: string): Promise<Response> {
  const upload = await ownedUpload(env, id, user.id);
  if (!upload || upload.status !== "uploading") return problem(404, "upload_not_found", "This resumable upload is not available.");
  if (await expireIfNeeded(env, upload)) return problem(410, "upload_expired", "This upload expired. Start it again.");
  const parts = await env.DB.prepare(
    "SELECT part_number, etag, size_bytes, uploaded_at FROM creator_library_multipart_parts WHERE upload_id = ? ORDER BY part_number"
  ).bind(upload.id).all<PartRow>();
  const expectedParts = Math.ceil(upload.total_bytes / upload.part_size_bytes);
  const actualBytes = parts.results.reduce((sum, part) => sum + Number(part.size_bytes), 0);
  if (parts.results.length !== expectedParts || actualBytes !== upload.total_bytes || parts.results.some((part, index) => part.part_number !== index + 1)) {
    return problem(409, "upload_incomplete", "Upload every file part before completing this upload.");
  }
  const now = new Date().toISOString();
  try {
    const object = await env.MEDIA.resumeMultipartUpload(upload.storage_key, upload.r2_upload_id)
      .complete(parts.results.map((part) => ({ partNumber: part.part_number, etag: part.etag })));
    if (object.size !== upload.total_bytes) {
      await env.MEDIA.delete(upload.storage_key);
      throw new Error(`Completed object size ${object.size} does not match ${upload.total_bytes}`);
    }
    const target = upload.target_library_item_id ? await env.DB.prepare(
      `SELECT id, media_asset_id FROM creator_library_items
       WHERE id = ? AND owner_user_id = ? AND status = 'active' AND item_kind = 'file'`
    ).bind(upload.target_library_item_id, user.id).first<{ id: string; media_asset_id: string | null }>() : null;
    if (upload.target_library_item_id && !target?.media_asset_id) {
      await env.MEDIA.delete(upload.storage_key);
      throw new Error("Target library item is no longer available");
    }
    const assetId = target?.media_asset_id ?? crypto.randomUUID();
    const versionNumber = target ? await nextAssetVersion(env, assetId) : 1;
    const version = catalogueVersionStatements(env, {
      ownerUserId: user.id, mediaAssetId: assetId, objectKey: upload.storage_key,
      sizeBytes: upload.total_bytes, mimeType: upload.mime_type, etag: object.etag,
      originalFilename: upload.original_filename, versionNumber, createdAt: now
    });
    const assetStatements = target ? [
      ...version.statements,
      env.DB.prepare(
        `UPDATE media_assets SET current_version_id = ?, storage_key = ?, size_bytes = ?, mime_type = ?,
         status = 'ready', updated_at = ? WHERE id = ?`
      ).bind(version.versionId, upload.storage_key, upload.total_bytes, upload.mime_type, now, assetId),
      env.DB.prepare(
        "UPDATE creator_library_items SET original_filename = ?, updated_at = ? WHERE id = ?"
      ).bind(upload.original_filename, now, target.id)
    ] : [
      env.DB.prepare(
        `INSERT INTO media_assets
          (id, owner_user_id, media_type, provider, storage_key, title, status, size_bytes,
           mime_type, captions_json, created_at, updated_at)
         VALUES (?, ?, ?, 'r2', ?, ?, 'ready', ?, ?, '[]', ?, ?)`
      ).bind(assetId, user.id, upload.media_type, upload.storage_key, upload.title,
        upload.total_bytes, upload.mime_type, now, now),
      ...version.statements,
      env.DB.prepare("UPDATE media_assets SET current_version_id = ? WHERE id = ?").bind(version.versionId, assetId),
      env.DB.prepare(
        `INSERT INTO creator_library_items
          (id, owner_user_id, folder_id, media_asset_id, item_kind, media_type, title, description,
           original_filename, tags_json, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'file', ?, ?, ?, ?, ?, 'active', ?, ?)`
      ).bind(upload.id, user.id, upload.folder_id, assetId, upload.media_type, upload.title, upload.description,
        upload.original_filename, upload.tags_json, now, now)
    ];
    const itemId = target?.id ?? upload.id;
    await env.DB.batch([
      ...assetStatements,
      env.DB.prepare("UPDATE creator_library_multipart_uploads SET status = 'completed', updated_at = ? WHERE id = ?")
        .bind(now, upload.id),
      env.DB.prepare(
        `INSERT INTO audit_logs (id, actor_user_id, action, entity_type, entity_id, metadata_json, created_at)
         VALUES (?, ?, ?, 'creator_library_item', ?, ?, ?)`
      ).bind(crypto.randomUUID(), user.id,
        target ? "creator_library.version_created" : "creator_library.multipart_completed",
        itemId, JSON.stringify({ mediaType: upload.media_type, sizeBytes: upload.total_bytes, parts: expectedParts, versionNumber }), now)
    ]);
    await releaseStorageReservation(env, upload.reservation_id);
    return json({ item: { id: itemId, title: upload.title, mediaType: upload.media_type, sizeBytes: upload.total_bytes }, versionNumber }, { status: 201 });
  } catch (error) {
    await env.MEDIA.delete(upload.storage_key).catch(() => undefined);
    await env.DB.prepare("UPDATE creator_library_multipart_uploads SET status = 'failed', updated_at = ? WHERE id = ?")
      .bind(now, upload.id).run();
    await releaseStorageReservation(env, upload.reservation_id);
    console.error("library.multipart.complete_failed", { uploadId: upload.id, error });
    return problem(502, "upload_complete_failed", "The uploaded file could not be finalised. Start the upload again.");
  }
}

async function abort(env: ApiEnvironment, user: Actor, id: string): Promise<Response> {
  const upload = await ownedUpload(env, id, user.id);
  if (!upload || !["uploading", "failed"].includes(upload.status)) return problem(404, "upload_not_found", "This resumable upload is not available.");
  try { await env.MEDIA.resumeMultipartUpload(upload.storage_key, upload.r2_upload_id).abort(); } catch { /* already completed or removed */ }
  const now = new Date().toISOString();
  await env.DB.prepare("UPDATE creator_library_multipart_uploads SET status = 'aborted', updated_at = ? WHERE id = ?")
    .bind(now, upload.id).run();
  await releaseStorageReservation(env, upload.reservation_id);
  return json({ aborted: true, id: upload.id });
}

export async function handleCreatorLibraryUploadRequest(request: Request, env: ApiEnvironment, pathname: string): Promise<Response | null> {
  if (!pathname.startsWith("/api/creator/content-library/uploads")) return null;
  const user = await actor(request, env);
  if (!user) return problem(401, "authentication_required", "Sign in to upload Content Library files.");
  if (pathname === "/api/creator/content-library/uploads" && request.method === "POST") return initiate(request, env, user);
  const match = pathname.match(/^\/api\/creator\/content-library\/uploads\/([^/]+)(?:\/parts\/(\d+)|\/(complete))?$/);
  if (!match) return problem(404, "upload_route_not_found", "Content upload route not found.");
  const id = decodeURIComponent(match[1]);
  if (match[2] && request.method === "PUT") return uploadPart(request, env, user, id, Number(match[2]));
  if (match[3] === "complete" && request.method === "POST") return complete(env, user, id);
  if (!match[2] && !match[3] && request.method === "GET") return status(env, user, id);
  if (!match[2] && !match[3] && request.method === "DELETE") return abort(env, user, id);
  return problem(405, "method_not_allowed", "Method not allowed.");
}
