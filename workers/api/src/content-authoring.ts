import { getCreatorActorById } from "../../../src/lib/auth";
import { json, problem } from "../../../src/lib/http";
import type { ApiEnvironment } from "./index";

const actorId = (request: Request) => request.headers.get("x-pencilscope-user-id")?.trim() || null;
const clean = (value: unknown, limit: number) => typeof value === "string" ? value.trim().slice(0, limit) : "";

function slugify(value: string): string {
  return value.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 64) || "ebook";
}

async function creatorEbooks(request: Request, env: ApiEnvironment): Promise<Response> {
  const actor = await getCreatorActorById(actorId(request), env.DB);
  if (!actor) return problem(401, "authentication_required", "Sign in to create an ebook.");
  if (request.method === "GET") {
    const result = await env.DB.prepare(
      `SELECT e.*, p.listing_status, COUNT(ch.id) AS chapter_count
       FROM ebooks e LEFT JOIN ebook_chapters ch ON ch.ebook_id = e.id
       LEFT JOIN learning_products p ON p.id = e.learning_product_id
       WHERE e.creator_id = ? GROUP BY e.id ORDER BY e.updated_at DESC`
    ).bind(actor.id).all();
    return json({ ebooks: result.results });
  }
  let input: Record<string, unknown>;
  try { input = await request.json(); } catch { return problem(400, "invalid_json", "A JSON body is required."); }
  const title = clean(input.title, 160);
  const subtitle = clean(input.subtitle, 240);
  const description = clean(input.description, 2000);
  const subject = clean(input.subject, 120);
  const audience = clean(input.audience, 120);
  if (title.length < 3 || description.length < 20 || !subject || !audience) {
    return problem(400, "invalid_ebook", "Add a title, description, topic and audience.");
  }
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO ebooks
      (id, creator_id, title, subtitle, description, subject, audience, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?)`
  ).bind(id, actor.id, title, subtitle, description, subject, audience, now, now).run();
  return json({ ebook: { id, title, status: "draft" } }, { status: 201 });
}

async function creatorEbook(
  request: Request,
  env: ApiEnvironment,
  ebookId: string,
  action?: string
): Promise<Response> {
  const actor = await getCreatorActorById(actorId(request), env.DB);
  if (!actor) return problem(401, "authentication_required", "Sign in to manage this ebook.");
  const ebook = await env.DB.prepare(
    `SELECT e.*, p.listing_status FROM ebooks e
     LEFT JOIN learning_products p ON p.id = e.learning_product_id
     WHERE e.id = ? AND (e.creator_id = ? OR ? = 'admin')`
  ).bind(ebookId, actor.id, actor.role).first<Record<string, unknown>>();
  if (!ebook) return problem(404, "ebook_not_found", "This ebook does not exist.");
  if (request.method === "GET" && !action) {
    const chapters = await env.DB.prepare(
      "SELECT * FROM ebook_chapters WHERE ebook_id = ? ORDER BY position"
    ).bind(ebookId).all();
    return json({ ebook, chapters: chapters.results });
  }
  if (request.method === "PATCH" && !action) {
    if (ebook.status !== "draft") {
      return problem(409, "draft_version_required", "Create a new draft version before editing a published ebook.");
    }
    let input: Record<string, unknown>;
    try { input = await request.json(); } catch { return problem(400, "invalid_json", "A JSON body is required."); }
    const title = clean(input.title, 160);
    const subtitle = clean(input.subtitle, 240);
    const description = clean(input.description, 2000);
    const subject = clean(input.subject, 120);
    const audience = clean(input.audience, 120);
    if (title.length < 3 || description.length < 20 || !subject || !audience) {
      return problem(400, "invalid_ebook", "Add a title, description, topic and audience.");
    }
    const now = new Date().toISOString();
    const statements = [
      env.DB.prepare(
        `UPDATE ebooks SET title = ?, subtitle = ?, description = ?, subject = ?,
          audience = ?, updated_at = ? WHERE id = ?`
      ).bind(title, subtitle, description, subject, audience, now, ebookId)
    ];
    if (typeof ebook.learning_product_id === "string" && ebook.learning_product_id) {
      statements.push(env.DB.prepare(
        `UPDATE learning_products SET title = ?, description = ?, subject = ?, audience = ?,
          updated_at = ? WHERE id = ? AND creator_id = ?`
      ).bind(title, description, subject, audience, now, ebook.learning_product_id, ebook.creator_id));
    }
    statements.push(env.DB.prepare(
      `INSERT INTO audit_logs
        (id, actor_user_id, action, entity_type, entity_id, metadata_json, created_at)
       VALUES (?, ?, 'ebook.updated', 'ebook', ?, ?, ?)`
    ).bind(crypto.randomUUID(), actor.id, ebookId, JSON.stringify({ title }), now));
    await env.DB.batch(statements);
    return json({ ebook: { id: ebookId, title, status: ebook.status } });
  }
  if (request.method === "DELETE" && !action) {
    if (ebook.status !== "draft") {
      return problem(409, "draft_required", "Published ebooks cannot be deleted. Unpublish them or create a new version instead.");
    }
    const now = new Date().toISOString();
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO audit_logs
          (id, actor_user_id, action, entity_type, entity_id, metadata_json, created_at)
         VALUES (?, ?, 'ebook.deleted', 'ebook', ?, '{}', ?)`
      ).bind(crypto.randomUUID(), actor.id, ebookId, now),
      env.DB.prepare("DELETE FROM ebooks WHERE id = ?").bind(ebookId)
    ]);
    return json({ deleted: true, id: ebookId });
  }
  if (request.method === "POST" && (action === "unpublish" || action === "republish")) {
    if (ebook.status !== "published" || typeof ebook.learning_product_id !== "string") {
      return problem(409, "published_ebook_required", "Publish this ebook before changing its visibility.");
    }
    const listingStatus = action === "unpublish" ? "unpublished" : "listed";
    const now = new Date().toISOString();
    await env.DB.batch([
      env.DB.prepare("UPDATE learning_products SET listing_status = ?, updated_at = ? WHERE id = ?")
        .bind(listingStatus, now, ebook.learning_product_id),
      env.DB.prepare(
        `INSERT INTO audit_logs
          (id, actor_user_id, action, entity_type, entity_id, metadata_json, created_at)
         VALUES (?, ?, ?, 'ebook', ?, '{}', ?)`
      ).bind(crypto.randomUUID(), actor.id, `ebook.${action}`, ebookId, now)
    ]);
    return json({ ebook: { id: ebookId, status: "published", listingStatus } });
  }
  if (request.method === "POST" && action === "copy") {
    if (ebook.status !== "published") {
      return problem(409, "published_ebook_required", "Publish this ebook before creating a new version.");
    }
    const rootId = typeof ebook.source_ebook_id === "string" && ebook.source_ebook_id
      ? ebook.source_ebook_id : ebookId;
    const versionRow = await env.DB.prepare(
      "SELECT MAX(content_version) AS version FROM ebooks WHERE id = ? OR source_ebook_id = ?"
    ).bind(rootId, rootId).first<{ version: number | null }>();
    const version = Number(versionRow?.version ?? ebook.content_version ?? 1) + 1;
    const chapters = await env.DB.prepare(
      "SELECT title, content_json, position FROM ebook_chapters WHERE ebook_id = ? ORDER BY position"
    ).bind(ebookId).all<{ title: string; content_json: string; position: number }>();
    const newId = crypto.randomUUID();
    const now = new Date().toISOString();
    const statements = [env.DB.prepare(
      `INSERT INTO ebooks
        (id, creator_id, learning_product_id, title, subtitle, description, subject,
         audience, cover_asset_id, status, current_version, created_at, updated_at,
         source_ebook_id, content_version)
       VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, 'draft', 1, ?, ?, ?, ?)`
    ).bind(
      newId, ebook.creator_id, ebook.title, ebook.subtitle, ebook.description, ebook.subject,
      ebook.audience, ebook.cover_asset_id, now, now, rootId, version
    )];
    chapters.results.forEach((chapter) => statements.push(env.DB.prepare(
      `INSERT INTO ebook_chapters
        (id, ebook_id, title, content_json, position, version, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 1, ?, ?)`
    ).bind(crypto.randomUUID(), newId, chapter.title, chapter.content_json, chapter.position, now, now)));
    statements.push(env.DB.prepare(
      `INSERT INTO audit_logs
        (id, actor_user_id, action, entity_type, entity_id, metadata_json, created_at)
       VALUES (?, ?, 'ebook.version_created', 'ebook', ?, ?, ?)`
    ).bind(crypto.randomUUID(), actor.id, newId, JSON.stringify({ sourceId: ebookId, version }), now));
    await env.DB.batch(statements);
    return json({ ebook: { id: newId, status: "draft", contentVersion: version } }, { status: 201 });
  }
  if (request.method === "POST" && action === "chapters") {
    let input: Record<string, unknown>;
    try { input = await request.json(); } catch { return problem(400, "invalid_json", "A JSON body is required."); }
    const title = clean(input.title, 160);
    const content = clean(input.content, 100_000);
    if (!title || !content) return problem(400, "invalid_chapter", "Add a chapter title and content.");
    const count = await env.DB.prepare(
      "SELECT COUNT(*) AS total FROM ebook_chapters WHERE ebook_id = ?"
    ).bind(ebookId).first<{ total: number }>();
    const now = new Date().toISOString();
    const id = crypto.randomUUID();
    const blocks = content.split(/\n\s*\n/).map((text) => ({ type: "paragraph", text: text.trim() })).filter((block) => block.text);
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO ebook_chapters
          (id, ebook_id, title, content_json, position, version, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 1, ?, ?)`
      ).bind(id, ebookId, title, JSON.stringify({ blocks }), Number(count?.total ?? 0) + 1, now, now),
      env.DB.prepare("UPDATE ebooks SET updated_at = ? WHERE id = ?").bind(now, ebookId)
    ]);
    return json({ chapter: { id, ebookId, title } }, { status: 201 });
  }
  if (request.method === "POST" && action === "publish") {
    const chapters = await env.DB.prepare(
      "SELECT content_json FROM ebook_chapters WHERE ebook_id = ? ORDER BY position"
    ).bind(ebookId).all<{ content_json: string }>();
    if (!chapters.results.length) return problem(409, "ebook_not_ready", "Add at least one chapter before publishing.");
    const wordCount = chapters.results.reduce((total, chapter) => {
      try {
        const parsed = JSON.parse(chapter.content_json) as { blocks?: Array<{ text?: string }> };
        return total + (parsed.blocks ?? []).reduce((sum, block) => sum + String(block.text ?? "").split(/\s+/).filter(Boolean).length, 0);
      } catch { return total; }
    }, 0);
    const now = new Date().toISOString();
    const existingProductId = typeof ebook.learning_product_id === "string" ? ebook.learning_product_id : null;
    const productId = existingProductId ?? crypto.randomUUID();
    let slug = `${slugify(String(ebook.title))}-${ebookId.slice(0, 8)}`;
    const existingSlug = existingProductId
      ? await env.DB.prepare("SELECT slug FROM learning_products WHERE id = ?").bind(existingProductId).first<{ slug: string }>()
      : null;
    if (existingSlug) slug = existingSlug.slug;
    const productStatement = existingProductId
      ? env.DB.prepare(
          `UPDATE learning_products SET title = ?, description = ?, subject = ?, audience = ?,
            content_url = ?, estimated_minutes = ?, status = 'published',
            published_at = COALESCE(published_at, ?), updated_at = ? WHERE id = ?`
        ).bind(
          ebook.title, ebook.description, ebook.subject, ebook.audience,
          `/ebooks/${ebookId}`, Math.max(1, Math.ceil(wordCount / 220)), now, now, productId
        )
      : env.DB.prepare(
          `INSERT INTO learning_products
            (id, creator_id, slug, product_type, title, description, subject, audience,
             content_url, content_json, estimated_minutes, price_cents, currency,
             status, published_at, created_at, updated_at)
           VALUES (?, ?, ?, 'ebook', ?, ?, ?, ?, ?, ?, ?, 0, 'SGD', 'published', ?, ?, ?)`
        ).bind(
          productId, actor.id, slug, ebook.title, ebook.description, ebook.subject, ebook.audience,
          `/ebooks/${ebookId}`, JSON.stringify({ ebookId }),
          Math.max(1, Math.ceil(wordCount / 220)), now, now, now
        );
    await env.DB.batch([
      productStatement,
      env.DB.prepare(
        `UPDATE ebooks SET learning_product_id = ?, status = 'published',
          published_at = COALESCE(published_at, ?), current_version = current_version + 1,
          updated_at = ? WHERE id = ?`
      ).bind(productId, now, now, ebookId),
      env.DB.prepare(
        `INSERT INTO audit_logs
          (id, actor_user_id, action, entity_type, entity_id, metadata_json, created_at)
         VALUES (?, ?, 'ebook.published', 'ebook', ?, ?, ?)`
      ).bind(crypto.randomUUID(), actor.id, ebookId, JSON.stringify({ productId, wordCount }), now)
    ]);
    return json({ ebook: { id: ebookId, status: "published", productId, slug } });
  }
  return problem(405, "method_not_allowed", "Method not allowed.");
}

async function updateChapter(request: Request, env: ApiEnvironment, chapterId: string): Promise<Response> {
  const actor = await getCreatorActorById(actorId(request), env.DB);
  if (!actor) return problem(401, "authentication_required", "Sign in to edit this chapter.");
  const chapter = await env.DB.prepare(
    `SELECT ch.id, ch.ebook_id, e.status FROM ebook_chapters ch JOIN ebooks e ON e.id = ch.ebook_id
     WHERE ch.id = ? AND (e.creator_id = ? OR ? = 'admin')`
  ).bind(chapterId, actor.id, actor.role).first<{ id: string; ebook_id: string; status: string }>();
  if (!chapter) return problem(404, "chapter_not_found", "This chapter does not exist.");
  if (chapter.status !== "draft") {
    return problem(409, "draft_version_required", "Create a new draft version before editing published chapters.");
  }
  let input: Record<string, unknown>;
  try { input = await request.json(); } catch { return problem(400, "invalid_json", "A JSON body is required."); }
  const title = clean(input.title, 160);
  const content = clean(input.content, 100_000);
  if (!title || !content) return problem(400, "invalid_chapter", "Add a chapter title and content.");
  const blocks = content.split(/\n\s*\n/).map((text) => ({ type: "paragraph", text: text.trim() })).filter((block) => block.text);
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE ebook_chapters SET title = ?, content_json = ?, version = version + 1,
        updated_at = ? WHERE id = ?`
    ).bind(title, JSON.stringify({ blocks }), now, chapterId),
    env.DB.prepare("UPDATE ebooks SET updated_at = ? WHERE id = ?").bind(now, chapter.ebook_id)
  ]);
  return json({ chapter: { id: chapterId, title } });
}

async function readEbook(env: ApiEnvironment, ebookId: string): Promise<Response> {
  const ebook = await env.DB.prepare(
    `SELECT e.id, e.title, e.subtitle, e.description, e.subject, e.audience,
      e.creator_id, e.current_version, e.published_at,
      COALESCE(NULLIF(u.display_name, ''), 'PencilScope creator') AS creator_name
     FROM ebooks e JOIN users u ON u.id = e.creator_id
     WHERE e.id = ? AND e.status = 'published'`
  ).bind(ebookId).first();
  if (!ebook) return problem(404, "ebook_not_found", "This ebook is not available.");
  const chapters = await env.DB.prepare(
    "SELECT id, title, content_json, position FROM ebook_chapters WHERE ebook_id = ? ORDER BY position"
  ).bind(ebookId).all();
  return json({ ebook, chapters: chapters.results });
}

export async function handleContentAuthoringRequest(
  request: Request,
  env: ApiEnvironment,
  pathname: string
): Promise<Response | null> {
  if (pathname === "/api/creator/ebooks" && (request.method === "GET" || request.method === "POST")) {
    return creatorEbooks(request, env);
  }
  const creatorEbookMatch = pathname.match(/^\/api\/creator\/ebooks\/([^/]+)(?:\/(chapters|publish|copy|unpublish|republish))?$/);
  if (creatorEbookMatch && (request.method === "GET" || request.method === "POST" || request.method === "PATCH" || request.method === "DELETE")) {
    return creatorEbook(request, env, decodeURIComponent(creatorEbookMatch[1]), creatorEbookMatch[2]);
  }
  const chapterMatch = pathname.match(/^\/api\/creator\/ebook-chapters\/([^/]+)$/);
  if (chapterMatch && request.method === "PATCH") {
    return updateChapter(request, env, decodeURIComponent(chapterMatch[1]));
  }
  const readMatch = pathname.match(/^\/api\/ebooks\/([^/]+)$/);
  if (readMatch && request.method === "GET") return readEbook(env, decodeURIComponent(readMatch[1]));
  return null;
}
