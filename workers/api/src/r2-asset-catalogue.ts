import type { ApiEnvironment } from "./index";

export const DEFAULT_RECOVERY_DAYS = 7;

const recoveryDays = (env: ApiEnvironment) => {
  const parsed = Number(env.CONTENT_LIBRARY_RECOVERY_DAYS);
  return Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= 30 ? parsed : DEFAULT_RECOVERY_DAYS;
};

export const recoveryDeadline = (env: ApiEnvironment, from = new Date()) =>
  new Date(from.getTime() + recoveryDays(env) * 86_400_000).toISOString();

export type CatalogueVersionInput = {
  ownerUserId: string;
  mediaAssetId: string;
  objectKey: string;
  sizeBytes: number;
  mimeType: string;
  etag?: string | null;
  originalFilename?: string | null;
  versionNumber: number;
  createdAt: string;
};

export function catalogueVersionStatements(env: ApiEnvironment, input: CatalogueVersionInput) {
  const objectId = crypto.randomUUID();
  const versionId = crypto.randomUUID();
  return {
    objectId,
    versionId,
    statements: [
      env.DB.prepare(
        `INSERT INTO r2_asset_objects
          (id, owner_user_id, bucket_binding, object_key, size_bytes, mime_type, etag, storage_class, created_at)
         VALUES (?, ?, 'MEDIA', ?, ?, ?, ?, 'Standard', ?)`
      ).bind(objectId, input.ownerUserId, input.objectKey, input.sizeBytes, input.mimeType, input.etag ?? null, input.createdAt),
      env.DB.prepare(
        `INSERT INTO media_asset_versions
          (id, media_asset_id, object_id, version_number, original_filename, created_by_user_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).bind(versionId, input.mediaAssetId, objectId, input.versionNumber, input.originalFilename ?? null,
        input.ownerUserId, input.createdAt)
    ]
  };
}

export async function nextAssetVersion(env: ApiEnvironment, mediaAssetId: string): Promise<number> {
  const row = await env.DB.prepare(
    "SELECT COALESCE(MAX(version_number), 0) AS version_number FROM media_asset_versions WHERE media_asset_id = ?"
  ).bind(mediaAssetId).first<{ version_number: number }>();
  return Number(row?.version_number ?? 0) + 1;
}

export async function purgeExpiredLibraryItems(env: ApiEnvironment, limit = 100): Promise<number> {
  const now = new Date().toISOString();
  const items = await env.DB.prepare(
    `SELECT i.id, i.media_asset_id FROM creator_library_items i
     WHERE i.status = 'deleted' AND i.purged_at IS NULL AND i.recoverable_until <= ?
       AND NOT EXISTS (SELECT 1 FROM assessment_question_media q WHERE q.library_item_id = i.id)
     ORDER BY recoverable_until LIMIT ?`
  ).bind(now, Math.max(1, Math.min(500, limit))).all<{ id: string; media_asset_id: string | null }>();

  let purged = 0;
  for (const item of items.results) {
    const objects = item.media_asset_id ? await env.DB.prepare(
      `SELECT DISTINCT o.id, o.object_key FROM media_asset_versions v
       JOIN r2_asset_objects o ON o.id = v.object_id
       WHERE v.media_asset_id = ? AND o.purged_at IS NULL`
    ).bind(item.media_asset_id).all<{ id: string; object_key: string }>() : { results: [] };
    if (objects.results.length) {
      await env.MEDIA.delete(objects.results.map((object) => object.object_key));
    }
    await env.DB.batch([
      ...objects.results.map((object) => env.DB.prepare(
        "UPDATE r2_asset_objects SET purged_at = ?, purge_after = COALESCE(purge_after, ?) WHERE id = ? AND purged_at IS NULL"
      ).bind(now, now, object.id)),
      env.DB.prepare(
        "UPDATE creator_library_items SET purged_at = ?, updated_at = ? WHERE id = ? AND purged_at IS NULL"
      ).bind(now, now, item.id),
      ...(item.media_asset_id ? [env.DB.prepare(
        "UPDATE media_assets SET storage_key = NULL, current_version_id = NULL, status = 'archived', updated_at = ? WHERE id = ?"
      ).bind(now, item.media_asset_id)] : [])
    ]);
    purged += 1;
  }
  return purged;
}
