type Environment = {
  DB: D1Database;
  API: Fetcher;
  ENVIRONMENT: string;
  AUTHORIZATION_SERVER: string;
  MCP_ORIGIN: string;
};

type TokenContext = {
  userId: string;
  clientId: string;
  scopes: Set<string>;
};

type RpcRequest = {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: { name?: string; arguments?: Record<string, unknown> };
};

const productTypes = ["ebook", "reading", "quiz", "test", "mock_exam", "video", "audio"];
const courseProductTypes = ["online_course", "in_person_course", "video_course"];
const assessmentTypes = new Set(["quiz", "test", "mock_exam"]);
const allScopes = ["products:read", "products:write", "products:publish", "courses:write", "library:read", "library:write"];

const questionSchema = {
  type: "object",
  additionalProperties: false,
  required: ["prompt", "options", "correctIndex"],
  properties: {
    prompt: { type: "string", minLength: 1, maxLength: 1000 },
    options: { type: "array", minItems: 2, maxItems: 10, items: { type: "string", minLength: 1, maxLength: 500 } },
    correctIndex: { type: "integer", minimum: 0 },
    explanation: { type: "string", maxLength: 1000 }
  }
};

const productFields = {
  productType: { type: "string", enum: productTypes, description: "The stored learning product format. Use audio for an audio book." },
  title: { type: "string", minLength: 3, maxLength: 140 },
  description: { type: "string", minLength: 20, maxLength: 2000 },
  subject: { type: "string", minLength: 1, maxLength: 120 },
  audience: { type: "string", minLength: 1, maxLength: 120 },
  estimatedMinutes: { type: "integer", minimum: 1, maximum: 10000 },
  contentUrl: { type: "string", format: "uri", description: "Public HTTPS content URL. Omit when primaryLibraryItemId is provided." },
  primaryLibraryItemId: { type: "string", minLength: 1, description: "Private Content Library item ID to use as the primary ebook document, audio, or video." },
  questions: { type: "array", minItems: 1, maxItems: 200, items: questionSchema, description: "Required for quizzes, tests and mock exams." },
  passingScore: { type: "integer", minimum: 0, maximum: 100 },
  timeLimitMinutes: { type: "integer", minimum: 1, maximum: 10000 }
};

const authSchemes = (scopes: string[]) => [{ type: "oauth2", scopes }];

const tools = [
  {
    name: "list_content_library",
    title: "List my Content Library",
    description: "Find reusable private files, links and notes by ID before creating a product. Returns safe metadata only and never exposes R2 storage keys.",
    inputSchema: { type: "object", additionalProperties: false, properties: {
      query: { type: "string", maxLength: 120 },
      mediaType: { type: "string", enum: ["video", "audio", "image", "document", "link", "note"] },
      status: { type: "string", enum: ["active", "archived"], default: "active" },
      limit: { type: "integer", minimum: 1, maximum: 100, default: 30 }
    }},
    securitySchemes: authSchemes(["library:read"]),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  },
  {
    name: "attach_library_resource",
    title: "Attach a Content Library resource",
    description: "Attach a creator-owned library item to a draft product, ebook, ebook chapter or course lesson using a semantic role. The server verifies ownership and media compatibility.",
    inputSchema: { type: "object", additionalProperties: false,
      required: ["libraryItemId", "targetType", "targetId", "role"],
      properties: {
        libraryItemId: { type: "string", minLength: 1 },
        targetType: { type: "string", enum: ["learning_product", "lesson", "ebook", "ebook_chapter"] },
        targetId: { type: "string", minLength: 1 },
        role: { type: "string", enum: ["primary_media", "primary_document", "lesson_media", "cover", "chapter_reference", "transcript", "captions", "supplement"] },
        position: { type: "integer", minimum: 1, default: 1 },
        requiredPercent: { type: "integer", minimum: 1, maximum: 100, default: 90 }
      }
    },
    securitySchemes: authSchemes(["library:write", "products:write"]),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  },
  {
    name: "create_ebook_draft",
    title: "Create a native ebook draft",
    description: "Create an unpublished, chapter-based ebook in Ebook Studio. Add chapters with add_ebook_chapter; this never publishes.",
    inputSchema: { type: "object", additionalProperties: false,
      required: ["title", "description", "subject", "audience"],
      properties: {
        title: { type: "string", minLength: 3, maxLength: 160 },
        subtitle: { type: "string", maxLength: 240 },
        description: { type: "string", minLength: 20, maxLength: 2000 },
        subject: { type: "string", minLength: 1, maxLength: 120 },
        audience: { type: "string", minLength: 1, maxLength: 120 },
        coverLibraryItemId: { type: "string", minLength: 1 }
      }
    },
    securitySchemes: authSchemes(["products:write", "library:write"]),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
  },
  {
    name: "add_ebook_chapter",
    title: "Add a chapter to an ebook draft",
    description: "Add a chapter to a creator-owned native ebook draft. Optionally attach one library reference to the new chapter.",
    inputSchema: { type: "object", additionalProperties: false,
      required: ["ebookId", "title", "content"],
      properties: {
        ebookId: { type: "string", minLength: 1 },
        title: { type: "string", minLength: 1, maxLength: 160 },
        content: { type: "string", minLength: 1, maxLength: 100000 },
        referenceLibraryItemId: { type: "string", minLength: 1 }
      }
    },
    securitySchemes: authSchemes(["products:write", "library:write"]),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
  },
  {
    name: "list_my_products",
    title: "List my PencilScope products",
    description: "Use this to find the signed-in creator's products and their draft, published or unpublished status before reading or changing one.",
    inputSchema: { type: "object", additionalProperties: false, properties: {
      status: { type: "string", enum: ["all", "draft", "published", "unpublished"], default: "all" },
      productType: { type: "string", enum: productTypes },
      limit: { type: "integer", minimum: 1, maximum: 50, default: 20 }
    }},
    securitySchemes: authSchemes(["products:read"]),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  },
  {
    name: "get_my_product",
    title: "Get one PencilScope product",
    description: "Use this to inspect a creator-owned product, including assessment questions, before proposing edits or publication.",
    inputSchema: { type: "object", additionalProperties: false, required: ["productId"], properties: {
      productId: { type: "string", minLength: 1 }
    }},
    securitySchemes: authSchemes(["products:read"]),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  },
  {
    name: "create_product_draft",
    title: "Create a learning product draft",
    description: "Create an unpublished PencilScope ebook, audio book, quiz, test or mock exam draft. Legacy reading and standalone video formats remain supported. Never publishes the product.",
    inputSchema: { type: "object", additionalProperties: false,
      required: ["productType", "title", "description", "subject", "audience", "estimatedMinutes"],
      properties: productFields
    },
    securitySchemes: authSchemes(["products:write", "library:write"]),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
  },
  {
    name: "update_product_draft",
    title: "Update a learning product draft",
    description: "Replace the editable content of a creator-owned draft. Published products must first be copied to a new draft version.",
    inputSchema: { type: "object", additionalProperties: false,
      required: ["productId", "productType", "title", "description", "subject", "audience", "estimatedMinutes"],
      properties: { productId: { type: "string", minLength: 1 }, ...productFields }
    },
    securitySchemes: authSchemes(["products:write"]),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  },
  {
    name: "validate_product_for_publication",
    title: "Validate product publication readiness",
    description: "Check whether a creator-owned product has the content required for publication. This does not publish it or create a priced offer.",
    inputSchema: { type: "object", additionalProperties: false, required: ["productId"], properties: {
      productId: { type: "string", minLength: 1 }
    }},
    securitySchemes: authSchemes(["products:read"]),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  },
  {
    name: "publish_product",
    title: "Publish a learning product",
    description: "Publish a validated creator-owned product only after the user explicitly confirms. Marketplace visibility still requires a priced, published offer.",
    inputSchema: { type: "object", additionalProperties: false, required: ["productId", "confirm"], properties: {
      productId: { type: "string", minLength: 1 },
      confirm: { type: "boolean", description: "Must be true only after explicit user confirmation." }
    }},
    securitySchemes: authSchemes(["products:publish"]),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  },
  {
    name: "unpublish_product",
    title: "Unpublish a learning product",
    description: "Remove a published product from listings after explicit user confirmation without deleting its content.",
    inputSchema: { type: "object", additionalProperties: false, required: ["productId", "confirm"], properties: {
      productId: { type: "string", minLength: 1 },
      confirm: { type: "boolean", description: "Must be true only after explicit user confirmation." }
    }},
    securitySchemes: authSchemes(["products:publish"]),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false }
  },
  {
    name: "delete_product_draft",
    title: "Delete a product draft",
    description: "Permanently delete a creator-owned draft only after explicit user confirmation. Published products cannot be deleted.",
    inputSchema: { type: "object", additionalProperties: false, required: ["productId", "confirm"], properties: {
      productId: { type: "string", minLength: 1 },
      confirm: { type: "boolean", description: "Must be true only after explicit user confirmation." }
    }},
    securitySchemes: authSchemes(["products:write"]),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false }
  },
  {
    name: "create_course_draft",
    title: "Create an online, in-person or video course draft",
    description: "Create an unpublished PencilScope online course, in-person course or video course shell. Use the exact courseType requested by the user. The price is the creator's SGD amount before configurable platform charges; this tool never publishes.",
    inputSchema: { type: "object", additionalProperties: false,
      required: ["courseType", "title", "description", "subject", "primaryLevel", "priceCents"],
      properties: {
        courseType: { type: "string", enum: courseProductTypes, description: "online_course uses live online delivery, in_person_course uses venue-based or hybrid delivery, and video_course uses recorded self-paced delivery." },
        title: { type: "string", minLength: 3, maxLength: 120 },
        description: { type: "string", minLength: 20, maxLength: 2000 },
        subject: { type: "string", minLength: 2, maxLength: 80 },
        primaryLevel: { type: "string", minLength: 2, maxLength: 40 },
        deliveryMode: { type: "string", enum: ["self-paced", "live", "hybrid", "ai-supported"], description: "Optional legacy override. Prefer courseType." },
        priceCents: { type: "integer", minimum: 50, maximum: 1000000 },
        categorySlugs: { type: "array", maxItems: 10, items: { type: "string" } }
      }
    },
    securitySchemes: authSchemes(["courses:write"]),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
  },
  {
    name: "add_course_module",
    title: "Add a module to a course draft",
    description: "Add a titled module to a course the signed-in creator owns or can edit.",
    inputSchema: { type: "object", additionalProperties: false, required: ["courseId", "title"], properties: {
      courseId: { type: "string", minLength: 1 },
      title: { type: "string", minLength: 2, maxLength: 120 },
      position: { type: "integer", minimum: 1 }
    }},
    securitySchemes: authSchemes(["courses:write"]),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
  },
  {
    name: "add_course_lesson",
    title: "Add a lesson to a course module",
    description: "Add a text, document, video, quiz, live or AI lesson to an editable course module.",
    inputSchema: { type: "object", additionalProperties: false, required: ["moduleId", "title", "lessonType"], properties: {
      moduleId: { type: "string", minLength: 1 },
      title: { type: "string", minLength: 2, maxLength: 120 },
      lessonType: { type: "string", enum: ["video", "text", "document", "quiz", "live", "ai"] },
      deliveryMode: { type: "string", enum: ["recorded", "live_online", "in_person"] },
      summary: { type: "string", maxLength: 1000 },
      videoUrl: { type: "string", format: "uri" },
      libraryItemId: { type: "string", minLength: 1, description: "Content Library video item to attach to this lesson instead of a public video URL." },
      estimatedMinutes: { type: "integer", minimum: 1, maximum: 10000 },
      position: { type: "integer", minimum: 1 }
    }},
    securitySchemes: authSchemes(["courses:write", "library:write"]),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
  }
];

const requiredScope: Record<string, string[]> = {
  list_content_library: ["library:read"],
  attach_library_resource: ["library:write", "products:write"],
  create_ebook_draft: ["products:write", "library:write"],
  add_ebook_chapter: ["products:write", "library:write"],
  list_my_products: ["products:read"],
  get_my_product: ["products:read"],
  create_product_draft: ["products:write", "library:write"],
  update_product_draft: ["products:write"],
  validate_product_for_publication: ["products:read"],
  publish_product: ["products:publish"],
  unpublish_product: ["products:publish"],
  delete_product_draft: ["products:write"],
  create_course_draft: ["courses:write"],
  add_course_module: ["courses:write"],
  add_course_lesson: ["courses:write", "library:write"]
};

const base64url = (bytes: Uint8Array) => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
};

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return base64url(new Uint8Array(digest));
}

function cors(headers: HeadersInit = {}): Headers {
  const result = new Headers(headers);
  result.set("access-control-allow-origin", "*");
  result.set("access-control-allow-methods", "GET, POST, OPTIONS");
  result.set("access-control-allow-headers", "authorization, content-type, mcp-protocol-version, mcp-method");
  result.set("access-control-expose-headers", "www-authenticate");
  return result;
}

function rpc(id: RpcRequest["id"], result: unknown, status = 200): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id: id ?? null, result }), {
    status,
    headers: cors({
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "mcp-protocol-version": "2026-07-28"
    })
  });
}

function rpcError(id: RpcRequest["id"], code: number, message: string, status = 200): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id: id ?? null, error: { code, message } }), {
    status,
    headers: cors({ "content-type": "application/json; charset=utf-8", "cache-control": "no-store" })
  });
}

function challenge(env: Environment, id: RpcRequest["id"] = null): Response {
  const metadata = `${env.MCP_ORIGIN}/.well-known/oauth-protected-resource/mcp`;
  return new Response(JSON.stringify({
    jsonrpc: "2.0",
    id,
    error: { code: -32001, message: "Authentication required" }
  }), {
    status: 401,
    headers: cors({
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "www-authenticate": `Bearer resource_metadata="${metadata}", scope="${allScopes.join(" ")}"`
    })
  });
}

async function authenticate(request: Request, env: Environment): Promise<TokenContext | null> {
  const match = request.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i);
  if (!match) return null;
  const row = await env.DB.prepare(
    `SELECT t.user_id, t.client_id, t.scopes_json
     FROM mcp_oauth_tokens t JOIN users u ON u.id = t.user_id
     WHERE t.access_token_hash = ? AND t.resource = ? AND t.revoked_at IS NULL
       AND t.access_expires_at > ? AND u.status = 'active'`
  ).bind(await sha256(match[1]), `${env.MCP_ORIGIN}/mcp`, new Date().toISOString())
    .first<{ user_id: string; client_id: string; scopes_json: string }>();
  if (!row) return null;
  return { userId: row.user_id, clientId: row.client_id, scopes: new Set(JSON.parse(row.scopes_json) as string[]) };
}

async function callApi(
  env: Environment,
  context: TokenContext,
  path: string,
  method = "GET",
  body?: unknown
): Promise<{ ok: boolean; status: number; data: any; errorCode?: string }> {
  const headers = new Headers({ "x-pencilscope-user-id": context.userId });
  if (body !== undefined) headers.set("content-type", "application/json");
  const response = await env.API.fetch(new Request(`https://pencilscope-api.internal${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  }));
  let data: any;
  try {
    data = await response.json();
  } catch {
    data = { error: { code: "invalid_api_response", message: "PencilScope returned an unreadable response." } };
  }
  return { ok: response.ok, status: response.status, data, errorCode: data?.error?.code };
}

const contentResult = (data: unknown, text: string, isError = false) => ({
  content: [{ type: "text", text }],
  structuredContent: data,
  ...(isError ? { isError: true } : {})
});

async function creatorProducts(env: Environment, context: TokenContext): Promise<any[]> {
  const response = await callApi(env, context, "/api/creator/learning-products");
  if (!response.ok) throw Object.assign(new Error(response.data?.error?.message ?? "Products could not be loaded."), {
    code: response.errorCode ?? "product_load_failed"
  });
  return Array.isArray(response.data?.products) ? response.data.products : [];
}

async function executeTool(
  env: Environment,
  context: TokenContext,
  name: string,
  args: Record<string, unknown>
): Promise<{ result: unknown; entityId?: string; errorCode?: string }> {
  const scopes = requiredScope[name];
  const missingScope = scopes?.find((scope) => !context.scopes.has(scope));
  if (!scopes || missingScope) {
    const scope = missingScope ?? "unknown";
    const metadata = `${env.MCP_ORIGIN}/.well-known/oauth-protected-resource/mcp`;
    return {
      result: {
        ...contentResult({ error: "insufficient_scope", requiredScope: scope }, `Permission required: ${scope}.`, true),
        _meta: {
          "mcp/www_authenticate": [
            `Bearer resource_metadata="${metadata}", error="insufficient_scope", error_description="Grant the ${scope} permission", scope="${scope}"`
          ]
        }
      },
      errorCode: "insufficient_scope"
    };
  }
  if (name === "list_content_library") {
    const params = new URLSearchParams();
    if (typeof args.query === "string" && args.query) params.set("q", args.query);
    if (typeof args.mediaType === "string" && args.mediaType) params.set("type", args.mediaType);
    params.set("status", typeof args.status === "string" ? args.status : "active");
    const response = await callApi(env, context, "/api/creator/content-library?" + params.toString());
    const limit = Math.min(100, Math.max(1, Number(args.limit) || 30));
    const items = (Array.isArray(response.data?.items) ? response.data.items : []).slice(0, limit).map((item: any) => ({
      id: item.id,
      title: item.title,
      description: item.description,
      mediaType: item.mediaType,
      itemKind: item.itemKind,
      mimeType: item.mimeType,
      originalFilename: item.originalFilename,
      sizeBytes: item.sizeBytes,
      tags: item.tags,
      status: item.status,
      usageCount: item.usageCount
    }));
    return {
      result: contentResult(
        { items, total: items.length },
        response.ok ? `Found ${items.length} Content Library item(s).` : response.data?.error?.message ?? "Content Library could not be loaded.",
        !response.ok
      ),
      errorCode: response.ok ? undefined : response.errorCode
    };
  }
  if (name === "attach_library_resource") {
    const libraryItemId = String(args.libraryItemId ?? "");
    const response = await callApi(
      env, context,
      "/api/creator/content-library/items/" + encodeURIComponent(libraryItemId) + "/attachments",
      "POST",
      {
        entityType: args.targetType,
        entityId: args.targetId,
        role: args.role,
        position: args.position,
        requiredPercent: args.requiredPercent
      }
    );
    return {
      result: contentResult(response.data, response.ok ? "Library resource attached to the draft." : response.data?.error?.message ?? "Resource attachment failed.", !response.ok),
      entityId: String(args.targetId ?? ""),
      errorCode: response.ok ? undefined : response.errorCode
    };
  }
  if (name === "create_ebook_draft") {
    const { coverLibraryItemId, ...payload } = args;
    const response = await callApi(env, context, "/api/creator/ebooks", "POST", payload);
    const ebookId = String(response.data?.ebook?.id ?? "");
    if (response.ok && ebookId && typeof coverLibraryItemId === "string" && coverLibraryItemId) {
      const attachment = await callApi(
        env, context,
        "/api/creator/content-library/items/" + encodeURIComponent(coverLibraryItemId) + "/attachments",
        "POST", { entityType: "ebook", entityId: ebookId, role: "cover", position: 1 }
      );
      if (!attachment.ok) {
        return {
          result: contentResult(
            { ebook: response.data.ebook, attachmentError: attachment.data?.error },
            "Ebook draft created, but its cover could not be attached: " + (attachment.data?.error?.message ?? "unknown error"),
            true
          ),
          entityId: ebookId,
          errorCode: attachment.errorCode ?? "cover_attachment_failed"
        };
      }
    }
    return {
      result: contentResult(response.data, response.ok ? "Native ebook draft created." : response.data?.error?.message ?? "Ebook creation failed.", !response.ok),
      entityId: ebookId || undefined,
      errorCode: response.ok ? undefined : response.errorCode
    };
  }
  if (name === "add_ebook_chapter") {
    const ebookId = String(args.ebookId ?? "");
    const response = await callApi(
      env, context, "/api/creator/ebooks/" + encodeURIComponent(ebookId) + "/chapters",
      "POST", { title: args.title, content: args.content }
    );
    const chapterId = String(response.data?.chapter?.id ?? "");
    if (response.ok && chapterId && typeof args.referenceLibraryItemId === "string" && args.referenceLibraryItemId) {
      const attachment = await callApi(
        env, context,
        "/api/creator/content-library/items/" + encodeURIComponent(args.referenceLibraryItemId) + "/attachments",
        "POST", { entityType: "ebook_chapter", entityId: chapterId, role: "chapter_reference", position: 1 }
      );
      if (!attachment.ok) {
        return {
          result: contentResult(
            { chapter: response.data.chapter, attachmentError: attachment.data?.error },
            "Ebook chapter created, but its library reference could not be attached: " + (attachment.data?.error?.message ?? "unknown error"),
            true
          ),
          entityId: chapterId,
          errorCode: attachment.errorCode ?? "chapter_attachment_failed"
        };
      }
    }
    return {
      result: contentResult(response.data, response.ok ? "Ebook chapter added." : response.data?.error?.message ?? "Chapter creation failed.", !response.ok),
      entityId: chapterId || ebookId,
      errorCode: response.ok ? undefined : response.errorCode
    };
  }
  if (name === "list_my_products") {
    const products = await creatorProducts(env, context);
    const status = typeof args.status === "string" ? args.status : "all";
    const type = typeof args.productType === "string" ? args.productType : null;
    const limit = Math.min(50, Math.max(1, Number(args.limit) || 20));
    const items = products.filter((product) => {
      const displayStatus = product.status === "published" && product.listing_status === "unpublished"
        ? "unpublished" : product.status;
      return (status === "all" || displayStatus === status) && (!type || product.product_type === type);
    }).slice(0, limit).map((product) => ({
      id: product.id, title: product.title, productType: product.product_type,
      status: product.status, listingStatus: product.listing_status,
      contentVersion: product.content_version, updatedAt: product.updated_at
    }));
    return { result: contentResult({ products: items, total: items.length }, `Found ${items.length} matching product(s).`) };
  }
  if (name === "get_my_product" || name === "validate_product_for_publication") {
    const productId = String(args.productId ?? "");
    const product = (await creatorProducts(env, context)).find((item) => item.id === productId);
    if (!product) return { result: contentResult({ error: "product_not_found" }, "Product not found or not owned by this creator.", true), errorCode: "product_not_found" };
    if (name === "get_my_product") return { result: contentResult({ product }, `Loaded ${product.title}.`), entityId: productId };
    const checks = [
      { key: "title", complete: typeof product.title === "string" && product.title.length >= 3 },
      { key: "description", complete: typeof product.description === "string" && product.description.length >= 20 },
      { key: "audience", complete: Boolean(product.audience) },
      { key: "duration", complete: Number(product.estimated_minutes) > 0 }
    ];
    if (assessmentTypes.has(product.product_type)) {
      checks.push({ key: "questions", complete: Array.isArray(product.questions) && product.questions.length > 0 });
    } else {
      checks.push({
        key: "contentSource",
        complete: typeof product.content_url === "string"
          && (product.content_url.startsWith("http") || product.content_url.startsWith("/api/creator/content-library/items/"))
      });
    }
    const ready = checks.every((check) => check.complete) && product.status === "draft";
    return {
      result: contentResult({
        productId, ready, checks,
        marketplaceRequirement: "Visibility and enrolment require inclusion in a priced, published offer."
      }, ready ? "The draft is ready for publication review." : "The product still has incomplete publication requirements."),
      entityId: productId
    };
  }
  if (name === "create_product_draft") {
    const response = await callApi(env, context, "/api/creator/learning-products", "POST", { ...args, status: "draft" });
    return {
      result: contentResult(response.data, response.ok ? "Product draft created." : response.data?.error?.message ?? "Product creation failed.", !response.ok),
      entityId: response.data?.product?.id,
      errorCode: response.ok ? undefined : response.errorCode
    };
  }
  if (name === "update_product_draft") {
    const productId = String(args.productId ?? "");
    const { productId: _discard, ...payload } = args;
    const response = await callApi(env, context, `/api/creator/learning-products/${encodeURIComponent(productId)}`, "PATCH", payload);
    return {
      result: contentResult(response.data, response.ok ? "Product draft updated." : response.data?.error?.message ?? "Product update failed.", !response.ok),
      entityId: productId, errorCode: response.ok ? undefined : response.errorCode
    };
  }
  if (["publish_product", "unpublish_product", "delete_product_draft"].includes(name)) {
    const productId = String(args.productId ?? "");
    if (args.confirm !== true) {
      return {
        result: contentResult({ error: "confirmation_required" }, "Ask the user to explicitly confirm this action, then call again with confirm=true.", true),
        entityId: productId, errorCode: "confirmation_required"
      };
    }
    const action = name === "publish_product" ? "publish" : name === "unpublish_product" ? "unpublish" : "";
    const method = name === "delete_product_draft" ? "DELETE" : "POST";
    const path = `/api/creator/learning-products/${encodeURIComponent(productId)}${action ? `/${action}` : ""}`;
    const response = await callApi(env, context, path, method);
    const successText = name === "publish_product" ? "Product published." : name === "unpublish_product" ? "Product unpublished." : "Product draft deleted.";
    return {
      result: contentResult(response.data, response.ok ? successText : response.data?.error?.message ?? "The action failed.", !response.ok),
      entityId: productId, errorCode: response.ok ? undefined : response.errorCode
    };
  }
  if (name === "create_course_draft") {
    const courseType = String(args.courseType ?? "video_course");
    const deliveryMode = courseType === "online_course" ? "live" : courseType === "in_person_course" ? "hybrid" : "self-paced";
    const { courseType: _courseType, ...courseArgs } = args;
    const response = await callApi(env, context, "/api/tutor/courses", "POST", {
      ...courseArgs, deliveryMode, currency: "SGD", publish: false
    });
    return {
      result: contentResult(response.data, response.ok ? "Course draft created." : response.data?.error?.message ?? "Course creation failed.", !response.ok),
      entityId: response.data?.course?.id, errorCode: response.ok ? undefined : response.errorCode
    };
  }
  if (name === "add_course_module") {
    const courseId = String(args.courseId ?? "");
    const response = await callApi(env, context, `/api/tutor/courses/${encodeURIComponent(courseId)}/modules`, "POST", {
      title: args.title, position: args.position
    });
    return {
      result: contentResult(response.data, response.ok ? "Course module added." : response.data?.error?.message ?? "Module creation failed.", !response.ok),
      entityId: response.data?.module?.id ?? courseId, errorCode: response.ok ? undefined : response.errorCode
    };
  }
  if (name === "add_course_lesson") {
    const moduleId = String(args.moduleId ?? "");
    const response = await callApi(env, context, `/api/tutor/modules/${encodeURIComponent(moduleId)}/lessons`, "POST", {
      title: args.title,
      lessonType: args.lessonType,
      deliveryMode: args.deliveryMode,
      estimatedMinutes: args.estimatedMinutes,
      position: args.position,
      content: { summary: args.summary, videoUrl: args.videoUrl }
    });
    const lessonId = String(response.data?.lesson?.id ?? "");
    if (response.ok && lessonId && typeof args.libraryItemId === "string" && args.libraryItemId) {
      const attachment = await callApi(
        env, context,
        "/api/creator/content-library/items/" + encodeURIComponent(args.libraryItemId) + "/attachments",
        "POST", { entityType: "lesson", entityId: lessonId, role: "lesson_media", position: 1, requiredPercent: 90 }
      );
      if (!attachment.ok) {
        return {
          result: contentResult(
            { lesson: response.data.lesson, attachmentError: attachment.data?.error },
            "Course lesson added, but its library video could not be attached: " + (attachment.data?.error?.message ?? "unknown error"),
            true
          ),
          entityId: lessonId,
          errorCode: attachment.errorCode ?? "lesson_attachment_failed"
        };
      }
    }
    return {
      result: contentResult(response.data, response.ok ? "Course lesson added." : response.data?.error?.message ?? "Lesson creation failed.", !response.ok),
      entityId: lessonId || moduleId, errorCode: response.ok ? undefined : response.errorCode
    };
  }
  return { result: contentResult({ error: "tool_not_found" }, "Unknown tool.", true), errorCode: "tool_not_found" };
}

async function audit(
  env: Environment,
  context: TokenContext,
  toolName: string,
  entityId: string | undefined,
  errorCode: string | undefined
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO mcp_tool_calls
      (id, user_id, client_id, tool_name, entity_id, succeeded, error_code, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    crypto.randomUUID(), context.userId, context.clientId, toolName, entityId ?? null,
    errorCode ? 0 : 1, errorCode ?? null, new Date().toISOString()
  ).run();
}

async function handleMcp(request: Request, env: Environment): Promise<Response> {
  let message: RpcRequest;
  try {
    message = await request.json<RpcRequest>();
  } catch {
    return rpcError(null, -32700, "Invalid JSON.");
  }
  const context = await authenticate(request, env);
  if (!context) return challenge(env, message.id);
  if (message.method === "server/discover") {
    return rpc(message.id, {
      supportedVersions: ["2026-07-28", "2025-11-25"],
      serverInfo: { name: "pencilscope-creator", version: "1.0.0" },
      capabilities: { tools: {} },
      instructions: "Create drafts first. Use list_content_library to select reusable resources by ID; never request or reveal storage keys. For an uploaded ebook or audio book use create_product_draft with primaryLibraryItemId. For a native ebook use create_ebook_draft and add_ebook_chapter. For a video course, create the course, modules and lessons, passing libraryItemId on video lessons. Return every created product ID. Read a product before editing it. Never publish, unpublish or delete unless the user explicitly confirms."
    });
  }
  if (message.method === "initialize") {
    return rpc(message.id, {
      protocolVersion: "2025-11-25",
      serverInfo: { name: "pencilscope-creator", version: "1.0.0" },
      capabilities: { tools: {} },
      instructions: "Create drafts first. Use list_content_library to select reusable resources by ID; never request or reveal storage keys. For an uploaded ebook or audio book use create_product_draft with primaryLibraryItemId. For a native ebook use create_ebook_draft and add_ebook_chapter. For a video course, create the course, modules and lessons, passing libraryItemId on video lessons. Return every created product ID. Read a product before editing it. Never publish, unpublish or delete unless the user explicitly confirms."
    });
  }
  if (message.method === "notifications/initialized") return new Response(null, { status: 202, headers: cors() });
  if (message.method === "tools/list") return rpc(message.id, { tools });
  if (message.method === "tools/call") {
    const name = String(message.params?.name ?? "");
    const args = message.params?.arguments && typeof message.params.arguments === "object"
      ? message.params.arguments : {};
    try {
      const execution = await executeTool(env, context, name, args);
      await audit(env, context, name, execution.entityId, execution.errorCode);
      return rpc(message.id, execution.result);
    } catch (error) {
      const code = typeof (error as { code?: unknown }).code === "string"
        ? String((error as { code: string }).code) : "tool_execution_failed";
      await audit(env, context, name, undefined, code).catch(() => undefined);
      return rpc(message.id, contentResult({ error: code }, error instanceof Error ? error.message : "The tool failed.", true));
    }
  }
  if (message.method?.startsWith("notifications/")) return new Response(null, { status: 202, headers: cors() });
  return rpcError(message.id, -32601, "Method not found.");
}

async function proxyOAuthRequest(request: Request, env: Environment, pathname: string): Promise<Response> {
  const endpoint = pathname === "/oauth/register"
    ? "/api/mcp/oauth/register"
    : pathname === "/oauth/token"
      ? "/api/mcp/oauth/token"
      : "/api/mcp/oauth/revoke";
  const headers = new Headers(request.headers);
  headers.delete("host");
  return env.API.fetch(new Request(`https://pencilscope-api.internal${endpoint}`, {
    method: "POST",
    headers,
    body: request.body
  }));
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors() });
    if (request.method === "GET" && (url.pathname === "/.well-known/oauth-protected-resource" ||
        url.pathname === "/.well-known/oauth-protected-resource/mcp")) {
      return new Response(JSON.stringify({
        resource: `${env.MCP_ORIGIN}/mcp`,
        authorization_servers: [env.AUTHORIZATION_SERVER],
        scopes_supported: allScopes,
        resource_documentation: `${env.AUTHORIZATION_SERVER}/integrations/mcp`
      }), { headers: cors({ "content-type": "application/json; charset=utf-8", "cache-control": "public, max-age=300" }) });
    }
    if (request.method === "GET" && url.pathname === "/health") {
      return new Response(JSON.stringify({
        status: "ok", service: "pencilscope-mcp", environment: env.ENVIRONMENT,
        time: new Date().toISOString()
      }), { headers: cors({ "content-type": "application/json; charset=utf-8" }) });
    }
    if (request.method === "GET" && url.pathname === "/") {
      return new Response("PencilScope Creator MCP. Connect using the /mcp endpoint.", {
        headers: cors({ "content-type": "text/plain; charset=utf-8" })
      });
    }
    if (request.method === "POST" && ["/oauth/register", "/oauth/token", "/oauth/revoke"].includes(url.pathname)) {
      return proxyOAuthRequest(request, env, url.pathname);
    }
    if (request.method === "POST" && url.pathname === "/mcp") return handleMcp(request, env);
    return new Response("Not found", { status: 404, headers: cors({ "content-type": "text/plain" }) });
  }
} satisfies ExportedHandler<Environment>;
