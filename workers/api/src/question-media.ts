import { problem } from "../../../src/lib/http";
import type { ApiEnvironment } from "./index";

export type ResolvedQuestionMedia = {
  libraryItemId: string;
  assetVersionId: string;
  mediaType: "image" | "video" | "audio";
  altText: string;
  caption: string;
};

export async function resolveQuestionMedia(
  env: ApiEnvironment,
  ownerUserId: string,
  input: Record<string, unknown>
): Promise<ResolvedQuestionMedia | Response | null> {
  const libraryItemId = typeof input.mediaLibraryItemId === "string"
    ? input.mediaLibraryItemId.trim().slice(0, 100) : "";
  if (!libraryItemId) return null;
  const item = await env.DB.prepare(
    `SELECT i.id, i.media_type, ma.current_version_id
     FROM creator_library_items i
     JOIN media_assets ma ON ma.id = i.media_asset_id
     JOIN media_asset_versions v ON v.id = ma.current_version_id
     JOIN r2_asset_objects o ON o.id = v.object_id AND o.purged_at IS NULL
     WHERE i.id = ? AND i.owner_user_id = ? AND i.status = 'active'
       AND i.item_kind = 'file' AND i.media_type IN ('image', 'video', 'audio')`
  ).bind(libraryItemId, ownerUserId).first<{
    id: string; media_type: "image" | "video" | "audio"; current_version_id: string;
  }>();
  if (!item?.current_version_id) {
    return problem(409, "question_media_unavailable", "Choose an active image, video or audio item from your Content Library.");
  }
  const altText = typeof input.mediaAltText === "string" ? input.mediaAltText.trim().slice(0, 500) : "";
  const caption = typeof input.mediaCaption === "string" ? input.mediaCaption.trim().slice(0, 1000) : "";
  if (item.media_type === "image" && !altText) {
    return problem(400, "question_media_alt_required", "Add a short image description for learners using assistive technology.");
  }
  return {
    libraryItemId: item.id,
    assetVersionId: item.current_version_id,
    mediaType: item.media_type,
    altText,
    caption
  };
}

export function questionMediaInsert(
  env: ApiEnvironment,
  ownerUserId: string,
  media: ResolvedQuestionMedia,
  target: { courseQuestionId: string } | { learningProductId: string; standaloneQuestionId: string },
  now: string
) {
  const courseQuestionId = "courseQuestionId" in target ? target.courseQuestionId : null;
  const learningProductId = "learningProductId" in target ? target.learningProductId : null;
  const standaloneQuestionId = "standaloneQuestionId" in target ? target.standaloneQuestionId : null;
  return env.DB.prepare(
    `INSERT INTO assessment_question_media
      (id, owner_user_id, library_item_id, asset_version_id, course_question_id,
       learning_product_id, standalone_question_id, media_type, alt_text, caption, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    crypto.randomUUID(), ownerUserId, media.libraryItemId, media.assetVersionId,
    courseQuestionId, learningProductId, standaloneQuestionId, media.mediaType,
    media.altText, media.caption, now, now
  );
}

export async function serveQuestionMediaVersion(env: ApiEnvironment, assetVersionId: string): Promise<Response> {
  const asset = await env.DB.prepare(
    `SELECT o.object_key, o.mime_type, o.size_bytes, v.original_filename
     FROM media_asset_versions v JOIN r2_asset_objects o ON o.id = v.object_id
     WHERE v.id = ? AND o.purged_at IS NULL`
  ).bind(assetVersionId).first<{
    object_key: string; mime_type: string | null; size_bytes: number; original_filename: string | null;
  }>();
  if (!asset) return problem(404, "question_media_not_found", "This question media is no longer available.");
  const object = await env.MEDIA.get(asset.object_key);
  if (!object) return problem(404, "question_media_not_found", "This question media is no longer available.");
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("content-type", asset.mime_type ?? "application/octet-stream");
  headers.set("content-length", String(asset.size_bytes ?? object.size));
  headers.set("content-disposition", "inline");
  headers.set("cache-control", "private, no-store");
  headers.set("x-content-type-options", "nosniff");
  return new Response(object.body, { headers });
}
