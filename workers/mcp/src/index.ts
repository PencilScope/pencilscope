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
const allProductTypes = [...courseProductTypes, ...productTypes];
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
    explanation: { type: "string", maxLength: 1000 },
    mediaLibraryItemId: { type: "string", minLength: 1, description: "Optional image, video or audio Content Library item ID." },
    mediaAltText: { type: "string", maxLength: 500, description: "Required accessibility description when the selected media is an image." },
    mediaCaption: { type: "string", maxLength: 1000, description: "Optional caption or transcript for the question media." }
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

const offeringFields = {
  title: { type: "string", minLength: 2, maxLength: 120 },
  offeringType: { type: "string", enum: ["self_paced", "cohort", "event", "academic_term"] },
  deliveryMode: { type: "string", enum: ["recorded", "live_online", "in_person", "hybrid"] },
  priceCents: { type: "integer", minimum: 50, maximum: 1000000, description: "Creator tuition in SGD cents before platform and planned meeting charges." },
  startsAt: { type: "string", format: "date-time" },
  endsAt: { type: "string", format: "date-time" },
  enrolmentOpensAt: { type: "string", format: "date-time" },
  enrolmentClosesAt: { type: "string", format: "date-time" },
  accessEndsAt: { type: "string", format: "date-time" },
  timezone: { type: "string", minLength: 1, maxLength: 80, default: "Asia/Singapore" },
  capacity: { type: ["integer", "null"], minimum: 1 },
  plannedMeetingMinutes: { type: "integer", minimum: 0, maximum: 100000 },
  plannedMeetingParticipants: { type: "integer", minimum: 0, maximum: 10000 },
  plannedPaidLearners: { type: "integer", minimum: 1, maximum: 10000 },
  academicYear: { type: "integer", minimum: 2000, maximum: 2200 },
  termNumber: { type: "integer", minimum: 1, maximum: 12 }
};

const sessionFields = {
  title: { type: "string", minLength: 2, maxLength: 160 },
  deliveryMode: { type: "string", enum: ["live_online", "in_person"] },
  startsAt: { type: "string", format: "date-time" },
  endsAt: { type: "string", format: "date-time" },
  timezone: { type: "string", minLength: 1, maxLength: 80, default: "Asia/Singapore" },
  capacity: { type: ["integer", "null"], minimum: 1 },
  instructorId: { type: "string", minLength: 1 },
  venueName: { type: "string", minLength: 2, maxLength: 160 },
  venueAddress: { type: "string", minLength: 3, maxLength: 300 },
  city: { type: "string", minLength: 1, maxLength: 120 },
  arrivalInstructions: { type: "string", maxLength: 1000 }
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
    name: "begin_content_upload",
    title: "Begin a Content Library file upload",
    description: "Start a quota-checked resumable upload for an image, video, audio or document. Returns the exact part size; send every base64-encoded part with upload_content_part before completing.",
    inputSchema: { type: "object", additionalProperties: false,
      required: ["filename", "mimeType", "sizeBytes"],
      properties: {
        filename: { type: "string", minLength: 1, maxLength: 255 },
        mimeType: { type: "string", minLength: 3, maxLength: 120 },
        sizeBytes: { type: "integer", minimum: 1, maximum: 5000000000 },
        title: { type: "string", maxLength: 160 },
        description: { type: "string", maxLength: 2000 },
        folderId: { type: "string", maxLength: 80 },
        tags: { type: "array", maxItems: 20, items: { type: "string", maxLength: 40 } },
        libraryItemId: { type: "string", maxLength: 80, description: "Optional existing library item ID when uploading a new immutable version." }
      }
    },
    securitySchemes: authSchemes(["library:write"]),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
  },
  {
    name: "upload_content_part",
    title: "Upload one Content Library file part",
    description: "Upload one base64-encoded part for a resumable Content Library upload. The decoded byte length must match the part size returned by begin_content_upload, except for the final part.",
    inputSchema: { type: "object", additionalProperties: false,
      required: ["uploadId", "partNumber", "dataBase64"],
      properties: {
        uploadId: { type: "string", minLength: 1 },
        partNumber: { type: "integer", minimum: 1 },
        dataBase64: { type: "string", minLength: 1 }
      }
    },
    securitySchemes: authSchemes(["library:write"]),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  },
  {
    name: "get_content_upload",
    title: "Check a Content Library upload",
    description: "Return the current upload status and uploaded part numbers so an interrupted file upload can resume.",
    inputSchema: { type: "object", additionalProperties: false, required: ["uploadId"], properties: {
      uploadId: { type: "string", minLength: 1 }
    }},
    securitySchemes: authSchemes(["library:write"]),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  },
  {
    name: "complete_content_upload",
    title: "Complete a Content Library file upload",
    description: "Finalize a fully uploaded image, video, audio or document as a private, versioned Content Library item.",
    inputSchema: { type: "object", additionalProperties: false, required: ["uploadId"], properties: {
      uploadId: { type: "string", minLength: 1 }
    }},
    securitySchemes: authSchemes(["library:write"]),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  },
  {
    name: "abort_content_upload",
    title: "Cancel a Content Library file upload",
    description: "Cancel an unfinished upload and release its reserved storage quota.",
    inputSchema: { type: "object", additionalProperties: false, required: ["uploadId", "confirm"], properties: {
      uploadId: { type: "string", minLength: 1 },
      confirm: { type: "boolean", description: "Must be true after the user confirms cancellation." }
    }},
    securitySchemes: authSchemes(["library:write"]),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false }
  },  {
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
    name: "set_course_cover",
    title: "Set a course cover image",
    description: "Attach a creator-owned Content Library image as the cover of an editable course draft.",
    inputSchema: { type: "object", additionalProperties: false, required: ["courseId", "libraryItemId"], properties: {
      courseId: { type: "string", minLength: 1 },
      libraryItemId: { type: "string", minLength: 1 }
    }},
    securitySchemes: authSchemes(["courses:write", "library:write"]),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  },  {
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
    description: "Find every signed-in creator product, including online, in-person and video course drafts, by title, ID, type and status before reading or changing one. Use query to rediscover a course when its ID is unknown.",
    inputSchema: { type: "object", additionalProperties: false, properties: {
      status: { type: "string", enum: ["all", "draft", "published", "unpublished"], default: "all" },
      productType: { type: "string", enum: allProductTypes },
      query: { type: "string", minLength: 1, maxLength: 160, description: "Case-insensitive title or exact/partial product ID search." },
      cursor: { type: "string", minLength: 1, maxLength: 100, description: "Opaque cursor returned by the previous page." },
      limit: { type: "integer", minimum: 1, maximum: 50, default: 20 }
    }},
    securitySchemes: authSchemes(["products:read"]),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  },
  {
    name: "get_my_product",
    title: "Get one PencilScope product",
    description: "Inspect a creator-owned standalone product or course, including course modules and lessons or assessment questions, before proposing edits or publication.",
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
    description: "Check whether a creator-owned standalone product or course has the content required for publication. Courses still require a priced course offering; this tool never publishes.",
    inputSchema: { type: "object", additionalProperties: false, required: ["productId"], properties: {
      productId: { type: "string", minLength: 1 }
    }},
    securitySchemes: authSchemes(["products:read"]),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  },
  {
    name: "publish_product",
    title: "Publish a learning product",
    description: "Publish a validated standalone learning product only after explicit confirmation. For a course, use create_course_offering and publish_course_offering instead.",
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
    name: "republish_product",
    title: "Republish a learning product",
    description: "Return a previously unpublished creator-owned product to listings after explicit user confirmation. Use publish_product for drafts instead.",
    inputSchema: { type: "object", additionalProperties: false, required: ["productId", "confirm"], properties: {
      productId: { type: "string", minLength: 1 },
      confirm: { type: "boolean", description: "Must be true only after explicit user confirmation." }
    }},
    securitySchemes: authSchemes(["products:publish"]),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
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
    name: "list_product_offers",
    title: "List product offers",
    description: "List the creator's independent offers and bundles, plus published course offerings eligible to be bundled, including price and publication status.",
    inputSchema: { type: "object", additionalProperties: false, properties: {
      productId: { type: "string", minLength: 1, description: "Optionally return only offers containing this standalone product." },
      courseId: { type: "string", minLength: 1, description: "Optionally return only bundles containing this course." }
    }},
    securitySchemes: authSchemes(["products:read"]),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  },
  {
    name: "create_product_offer",
    title: "Create an independent or bundled product offer",
    description: "Create a draft priced offer containing standalone products, published course offerings, or both. One item is independent; multiple items form a bundle. This never publishes.",
    inputSchema: { type: "object", additionalProperties: false, required: ["title", "priceCents"], anyOf: [{ required: ["productIds"] }, { required: ["courseOfferingIds"] }], properties: {
      title: { type: "string", minLength: 2, maxLength: 160 }, description: { type: "string", maxLength: 2000 },
      priceCents: { type: "integer", minimum: 50, maximum: 1000000 }, currency: { type: "string", enum: ["SGD"], default: "SGD" },
      productIds: { type: "array", minItems: 1, maxItems: 100, uniqueItems: true, items: { type: "string", minLength: 1 } },
      courseOfferingIds: { type: "array", minItems: 1, maxItems: 100, uniqueItems: true, items: { type: "string", minLength: 1 }, description: "Published, priced course offering IDs returned by list_product_offers." },
      enrolmentOpensAt: { type: "string", format: "date-time" }, enrolmentClosesAt: { type: "string", format: "date-time" },
      accessEndsAt: { type: "string", format: "date-time" }, capacity: { type: ["integer", "null"], minimum: 1 }
    }},
    securitySchemes: authSchemes(["products:write"]),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
  },
  {
    name: "update_product_offer",
    title: "Update a draft product offer",
    description: "Update the name, price, booking window, validity or capacity of a draft independent or bundle offer.",
    inputSchema: { type: "object", additionalProperties: false, required: ["offerId"], properties: {
      offerId: { type: "string", minLength: 1 }, title: { type: "string", minLength: 2, maxLength: 160 }, description: { type: "string", maxLength: 2000 },
      priceCents: { type: "integer", minimum: 50, maximum: 1000000 }, enrolmentOpensAt: { type: ["string", "null"], format: "date-time" },
      enrolmentClosesAt: { type: ["string", "null"], format: "date-time" }, accessEndsAt: { type: ["string", "null"], format: "date-time" },
      capacity: { type: ["integer", "null"], minimum: 1 }
    }},
    securitySchemes: authSchemes(["products:write"]),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  },
  {
    name: "add_product_to_offer",
    title: "Add a product to a draft offer",
    description: "Add another creator-owned product to a draft offer, turning an independent offer into a bundle when needed.",
    inputSchema: { type: "object", additionalProperties: false, required: ["offerId", "productId"], properties: {
      offerId: { type: "string", minLength: 1 }, productId: { type: "string", minLength: 1 }, position: { type: "integer", minimum: 1 }
    }},
    securitySchemes: authSchemes(["products:write"]),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  },
  {
    name: "remove_product_from_offer",
    title: "Remove a product from a draft offer",
    description: "Remove one product from a draft offer. At least one product must remain before publication.",
    inputSchema: { type: "object", additionalProperties: false, required: ["offerId", "productId"], properties: {
      offerId: { type: "string", minLength: 1 }, productId: { type: "string", minLength: 1 }
    }},
    securitySchemes: authSchemes(["products:write"]),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false }
  },
  {
    name: "publish_product_offer",
    title: "Publish a product offer",
    description: "Publish a ready independent or bundle offer and create its Stripe price only after explicit user confirmation.",
    inputSchema: { type: "object", additionalProperties: false, required: ["offerId", "confirm"], properties: {
      offerId: { type: "string", minLength: 1 }, confirm: { type: "boolean" }
    }},
    securitySchemes: authSchemes(["products:publish"]),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true }
  },
  {
    name: "unpublish_product_offer",
    title: "Close a product offer",
    description: "Close an independent or bundle offer to new purchases after explicit user confirmation. Existing learner access is preserved.",
    inputSchema: { type: "object", additionalProperties: false, required: ["offerId", "confirm"], properties: {
      offerId: { type: "string", minLength: 1 }, confirm: { type: "boolean" }
    }},
    securitySchemes: authSchemes(["products:publish"]),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false }
  },
  {
    name: "get_google_calendar_connection_status",
    title: "Check Google Calendar and Meet connection",
    description: "Check whether the signed-in course creator can create Google Meet sessions. Returns a direct connection URL when setup is required.",
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
    securitySchemes: authSchemes(["courses:write"]),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  },
  {
    name: "create_course_draft",
    title: "Create an online, in-person or video course draft",
    description: "Create an unpublished PencilScope online course, in-person course or video course shell. Pricing is configured later through an offer; this tool never publishes.",
    inputSchema: { type: "object", additionalProperties: false,
      required: ["courseType", "title", "description", "subject", "primaryLevel"],
      properties: {
        courseType: { type: "string", enum: courseProductTypes, description: "online_course uses live online delivery, in_person_course uses venue-based or hybrid delivery, and video_course uses recorded self-paced delivery." },
        title: { type: "string", minLength: 3, maxLength: 120 },
        description: { type: "string", minLength: 20, maxLength: 2000 },
        subject: { type: "string", minLength: 2, maxLength: 80 },
        primaryLevel: { type: "string", minLength: 2, maxLength: 40 },
        deliveryMode: { type: "string", enum: ["self-paced", "live", "hybrid", "ai-supported"], description: "Optional legacy override. Prefer courseType." },
        priceCents: { type: "integer", minimum: 50, maximum: 1000000, description: "Optional legacy draft price. Prefer configuring pricing and validity later in Creator Studio." },
        categorySlugs: { type: "array", maxItems: 10, items: { type: "string" } }
      }
    },
    securitySchemes: authSchemes(["courses:write"]),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
  },
  {
    name: "create_course_offering",
    title: "Create a priced course offering",
    description: "Create a draft enrolment offer with price, delivery dates, booking dates, learner access validity, capacity and live-meeting allowances. Cohort and event offers require start and end dates. This never publishes.",
    inputSchema: { type: "object", additionalProperties: false,
      required: ["courseId", "title", "offeringType", "deliveryMode", "priceCents"],
      properties: { courseId: { type: "string", minLength: 1 }, ...offeringFields }
    },
    securitySchemes: authSchemes(["courses:write"]),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
  },
  {
    name: "update_course_offering",
    title: "Update a draft course offering",
    description: "Update pricing, schedule, booking window, learner access validity, timezone or capacity on a draft offer. Published offers are locked.",
    inputSchema: { type: "object", additionalProperties: false,
      required: ["offeringId"], properties: { offeringId: { type: "string", minLength: 1 }, ...offeringFields }
    },
    securitySchemes: authSchemes(["courses:write"]),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  },
  {
    name: "assign_offering_content",
    title: "Add content to a course offering",
    description: "Add a course module, material, assessment, flashcard deck or published standalone learning product to a draft offer bundle.",
    inputSchema: { type: "object", additionalProperties: false,
      required: ["offeringId", "kind", "contentId"], properties: {
        offeringId: { type: "string", minLength: 1 },
        kind: { type: "string", enum: ["module", "material", "assessment", "flashcard_deck", "learning_product"] },
        contentId: { type: "string", minLength: 1 },
        position: { type: "integer", minimum: 1 }
      }
    },
    securitySchemes: authSchemes(["courses:write"]),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  },
  {
    name: "add_course_session",
    title: "Schedule a course class",
    description: "Add a dated online or in-person class to a draft offering. Online classes create Google Meet automatically; in-person classes require venue name and address.",
    inputSchema: { type: "object", additionalProperties: false,
      required: ["offeringId", "title", "deliveryMode", "startsAt", "endsAt"],
      properties: { offeringId: { type: "string", minLength: 1 }, ...sessionFields }
    },
    securitySchemes: authSchemes(["courses:write"]),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }
  },
  {
    name: "update_course_session",
    title: "Update a scheduled course class",
    description: "Update a class title, dates, timezone, capacity or in-person venue while its offer remains a draft. Online schedule changes are synchronized to Google Calendar and Meet.",
    inputSchema: { type: "object", additionalProperties: false,
      required: ["sessionId"], properties: { sessionId: { type: "string", minLength: 1 }, ...sessionFields }
    },
    securitySchemes: authSchemes(["courses:write"]),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true }
  },
  {
    name: "publish_course_offering",
    title: "Publish a course offering",
    description: "Publish a ready draft offer and create its Stripe price only after explicit user confirmation. Opening dates still control when learners may enrol.",
    inputSchema: { type: "object", additionalProperties: false,
      required: ["offeringId", "confirm"], properties: {
        offeringId: { type: "string", minLength: 1 },
        confirm: { type: "boolean", description: "Must be true only after explicit user confirmation." }
      }
    },
    securitySchemes: authSchemes(["courses:write", "products:publish"]),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true }
  },  {
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
  begin_content_upload: ["library:write"],
  upload_content_part: ["library:write"],
  get_content_upload: ["library:write"],
  complete_content_upload: ["library:write"],
  abort_content_upload: ["library:write"],
  attach_library_resource: ["library:write", "products:write"],
  set_course_cover: ["courses:write", "library:write"],
  create_ebook_draft: ["products:write", "library:write"],
  add_ebook_chapter: ["products:write", "library:write"],
  list_my_products: ["products:read"],
  get_my_product: ["products:read"],
  create_product_draft: ["products:write", "library:write"],
  update_product_draft: ["products:write"],
  validate_product_for_publication: ["products:read"],
  publish_product: ["products:publish"],
  unpublish_product: ["products:publish"],
  republish_product: ["products:publish"],
  delete_product_draft: ["products:write"],
  list_product_offers: ["products:read"],
  create_product_offer: ["products:write"],
  update_product_offer: ["products:write"],
  add_product_to_offer: ["products:write"],
  remove_product_from_offer: ["products:write"],
  publish_product_offer: ["products:publish"],
  unpublish_product_offer: ["products:publish"],
  get_google_calendar_connection_status: ["courses:write"],
  create_course_draft: ["courses:write"],
  create_course_offering: ["courses:write"],
  update_course_offering: ["courses:write"],
  assign_offering_content: ["courses:write"],
  add_course_session: ["courses:write"],
  update_course_session: ["courses:write"],
  publish_course_offering: ["courses:write", "products:publish"],
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

async function callApiBytes(
  env: Environment,
  context: TokenContext,
  path: string,
  method: string,
  bytes: Uint8Array
): Promise<{ ok: boolean; status: number; data: any; errorCode?: string }> {
  const response = await env.API.fetch(new Request(`https://pencilscope-api.internal${path}`, {
    method,
    headers: {
      "x-pencilscope-user-id": context.userId,
      "content-type": "application/octet-stream",
      "x-pencilscope-part-size": String(bytes.byteLength)
    },
    body: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
  }));
  let data: any;
  try {
    data = await response.json();
  } catch {
    data = { error: { code: "invalid_api_response", message: "PencilScope returned an unreadable response." } };
  }
  return { ok: response.ok, status: response.status, data, errorCode: data?.error?.code };
}

function decodeBase64Part(value: unknown): Uint8Array | null {
  if (typeof value !== "string" || !value.length || value.length > 20_000_000) return null;
  try {
    const normalized = value.replace(/\s+/g, "").replace(/-/g, "+").replace(/_/g, "/");
    const binary = atob(normalized);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  } catch {
    return null;
  }
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

function courseProductType(deliveryMode: unknown): string {
  if (deliveryMode === "live") return "online_course";
  if (deliveryMode === "hybrid") return "in_person_course";
  return "video_course";
}

function creatorStudioUrl(env: Environment, entityKind: "course" | "learning_product", id: string): string {
  const base = env.AUTHORIZATION_SERVER.replace(/\/+$/, "");
  const params = entityKind === "course"
    ? `workspace=creation&section=course-studio&courseId=${encodeURIComponent(id)}`
    : `workspace=creation&section=product&productId=${encodeURIComponent(id)}`;
  return `${base}/dashboard?${params}`;
}

async function creatorCourses(env: Environment, context: TokenContext): Promise<any[]> {
  const result = await env.DB.prepare(
    `SELECT c.id, c.slug, c.title, c.description, c.subject, c.primary_level,
      c.delivery_mode, c.status, c.listing_status, c.content_version, c.updated_at
     FROM courses c
     WHERE c.tutor_id = ? OR EXISTS (
       SELECT 1 FROM course_members cm
       WHERE cm.course_id = c.id AND cm.user_id = ? AND cm.status = 'active'
     )
     ORDER BY c.updated_at DESC, c.id`
  ).bind(context.userId, context.userId).all();
  return result.results;
}

function decodeListCursor(value: unknown): number {
  if (typeof value !== "string" || !value) return 0;
  try {
    const offset = Number(atob(value));
    return Number.isSafeInteger(offset) && offset >= 0 ? offset : 0;
  } catch {
    return 0;
  }
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
  if (name === "begin_content_upload") {
    const response = await callApi(env, context, "/api/creator/content-library/uploads", "POST", {
      filename: args.filename, mimeType: args.mimeType, sizeBytes: args.sizeBytes,
      title: args.title, description: args.description, folderId: args.folderId,
      tags: args.tags, libraryItemId: args.libraryItemId
    });
    return {
      result: contentResult(response.data, response.ok ? "Content upload started. Send each file part in order, then complete the upload." : response.data?.error?.message ?? "Content upload could not be started.", !response.ok),
      entityId: response.data?.upload?.id,
      errorCode: response.ok ? undefined : response.errorCode
    };
  }
  if (name === "upload_content_part") {
    const uploadId = String(args.uploadId ?? "");
    const partNumber = Number(args.partNumber);
    const bytes = decodeBase64Part(args.dataBase64);
    if (!uploadId || !Number.isSafeInteger(partNumber) || partNumber < 1 || !bytes) {
      return { result: contentResult({ error: "invalid_upload_part" }, "Provide a valid upload ID, part number and base64 file data.", true), errorCode: "invalid_upload_part" };
    }
    const response = await callApiBytes(
      env, context,
      `/api/creator/content-library/uploads/${encodeURIComponent(uploadId)}/parts/${partNumber}`,
      "PUT", bytes
    );
    return {
      result: contentResult(response.data, response.ok ? `Upload part ${partNumber} stored.` : response.data?.error?.message ?? "The upload part could not be stored.", !response.ok),
      entityId: uploadId,
      errorCode: response.ok ? undefined : response.errorCode
    };
  }
  if (name === "get_content_upload") {
    const uploadId = String(args.uploadId ?? "");
    const response = await callApi(env, context, `/api/creator/content-library/uploads/${encodeURIComponent(uploadId)}`);
    return {
      result: contentResult(response.data, response.ok ? "Content upload status loaded." : response.data?.error?.message ?? "Upload status could not be loaded.", !response.ok),
      entityId: uploadId,
      errorCode: response.ok ? undefined : response.errorCode
    };
  }
  if (name === "complete_content_upload") {
    const uploadId = String(args.uploadId ?? "");
    const response = await callApi(env, context, `/api/creator/content-library/uploads/${encodeURIComponent(uploadId)}/complete`, "POST");
    return {
      result: contentResult(response.data, response.ok ? "Content Library file uploaded and versioned." : response.data?.error?.message ?? "The content upload could not be completed.", !response.ok),
      entityId: response.data?.item?.id ?? uploadId,
      errorCode: response.ok ? undefined : response.errorCode
    };
  }
  if (name === "abort_content_upload") {
    const uploadId = String(args.uploadId ?? "");
    if (args.confirm !== true) {
      return { result: contentResult({ error: "confirmation_required" }, "Ask the user to confirm cancelling this upload, then call again with confirm=true.", true), entityId: uploadId, errorCode: "confirmation_required" };
    }
    const response = await callApi(env, context, `/api/creator/content-library/uploads/${encodeURIComponent(uploadId)}`, "DELETE");
    return {
      result: contentResult(response.data, response.ok ? "Content upload cancelled and reserved quota released." : response.data?.error?.message ?? "The content upload could not be cancelled.", !response.ok),
      entityId: uploadId,
      errorCode: response.ok ? undefined : response.errorCode
    };
  }  if (name === "list_content_library") {
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
  if (name === "set_course_cover") {
    const courseId = String(args.courseId ?? "");
    const libraryItemId = String(args.libraryItemId ?? "");
    const response = await callApi(
      env, context,
      "/api/creator/content-library/items/" + encodeURIComponent(libraryItemId) + "/attachments",
      "POST", { entityType: "course", entityId: courseId, role: "cover", position: 1 }
    );
    return {
      result: contentResult(response.data, response.ok ? "Course cover image attached." : response.data?.error?.message ?? "Course cover attachment failed.", !response.ok),
      entityId: courseId,
      errorCode: response.ok ? undefined : response.errorCode
    };
  }  if (name === "attach_library_resource") {
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
    const [products, courses] = await Promise.all([
      creatorProducts(env, context),
      creatorCourses(env, context)
    ]);
    const status = typeof args.status === "string" ? args.status : "all";
    const type = typeof args.productType === "string" ? args.productType : null;
    const query = typeof args.query === "string" ? args.query.trim().toLocaleLowerCase() : "";
    const limit = Math.min(50, Math.max(1, Number(args.limit) || 20));
    const offset = decodeListCursor(args.cursor);
    const normalizedProducts = products.map((product) => ({
      id: product.id,
      title: product.title,
      productType: product.product_type,
      entityKind: "learning_product",
      status: product.status,
      listingStatus: product.listing_status,
      contentVersion: product.content_version,
      updatedAt: product.updated_at,
      studioUrl: creatorStudioUrl(env, "learning_product", String(product.id))
    }));
    const normalizedCourses = courses.map((course) => ({
      id: course.id,
      title: course.title,
      productType: courseProductType(course.delivery_mode),
      entityKind: "course",
      status: course.status,
      listingStatus: course.listing_status,
      contentVersion: course.content_version,
      updatedAt: course.updated_at,
      studioUrl: creatorStudioUrl(env, "course", String(course.id))
    }));
    const matches = [...normalizedProducts, ...normalizedCourses].filter((product) => {
      const displayStatus = product.status === "published" && product.listingStatus === "unpublished"
        ? "unpublished" : product.status;
      const searchable = `${product.id} ${product.title}`.toLocaleLowerCase();
      return (status === "all" || displayStatus === status)
        && (!type || product.productType === type)
        && (!query || searchable.includes(query));
    }).sort((left, right) => {
      const byDate = String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? ""));
      return byDate || String(left.id).localeCompare(String(right.id));
    });
    const items = matches.slice(offset, offset + limit);
    const nextOffset = offset + items.length;
    const nextCursor = nextOffset < matches.length ? btoa(String(nextOffset)) : null;
    const summary = items.length === 0
      ? "No matching products found."
      : [
          `Found ${matches.length} matching product(s); showing ${offset + 1}-${offset + items.length}:`,
          ...items.map((item, index) => {
            const displayStatus = item.status === "published" && item.listingStatus === "unpublished"
              ? "unpublished" : item.status;
            return `${offset + index + 1}. ${item.title} | type=${item.productType} | status=${displayStatus} | id=${item.id} | studio=${item.studioUrl}`;
          })
        ].join("\n");
    return { result: contentResult({ products: items, total: matches.length, nextCursor }, summary) };
  }
  if (name === "get_my_product" || name === "validate_product_for_publication") {
    const productId = String(args.productId ?? "");
    const product = (await creatorProducts(env, context)).find((item) => item.id === productId);
    if (!product) {
      const course = (await creatorCourses(env, context)).find((item) => item.id === productId);
      if (!course) return { result: contentResult({ error: "product_not_found" }, "Product not found or not owned by this creator.", true), errorCode: "product_not_found" };
      const response = await callApi(env, context, `/api/tutor/courses/${encodeURIComponent(productId)}/studio`);
      if (!response.ok) return {
        result: contentResult(response.data, response.data?.error?.message ?? "Course details could not be loaded.", true),
        entityId: productId, errorCode: response.errorCode ?? "course_load_failed"
      };
      const courseDetails = {
        ...response.data.course,
        entityKind: "course",
        productType: courseProductType(response.data.course?.delivery_mode),
        studioUrl: creatorStudioUrl(env, "course", productId)
      };
      if (name === "get_my_product") return {
        result: contentResult({ ...response.data, product: courseDetails }, `Loaded course ${courseDetails.title}.`),
        entityId: productId
      };
      const checks = [
        { key: "title", complete: typeof courseDetails.title === "string" && courseDetails.title.length >= 3 },
        { key: "description", complete: typeof courseDetails.description === "string" && courseDetails.description.length >= 20 },
        { key: "audience", complete: Boolean(courseDetails.primary_level) },
        { key: "modules", complete: Array.isArray(response.data.modules) && response.data.modules.length > 0 },
        { key: "lessons", complete: Array.isArray(response.data.lessons) && response.data.lessons.length > 0 }
      ];
      const ready = checks.every((check) => check.complete) && courseDetails.status === "draft";
      return {
        result: contentResult({
          productId, productType: courseDetails.productType, ready, checks,
          studioUrl: courseDetails.studioUrl,
          nextStep: "Create a course offering with pricing and validity, then publish that offering after confirmation.",
          marketplaceRequirement: "Visibility and enrolment require a priced, published course offering."
        }, ready ? "The course content is ready for pricing and offer publication." : "The course still has incomplete content requirements."),
        entityId: productId
      };
    }
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
  if (["publish_product", "unpublish_product", "republish_product", "delete_product_draft"].includes(name)) {
    const productId = String(args.productId ?? "");
    const course = (await creatorCourses(env, context)).find((item) => item.id === productId);
    if (course) {
      return {
        result: contentResult({
          error: "course_offering_required",
          courseId: productId,
          productType: courseProductType(course.delivery_mode),
          studioUrl: creatorStudioUrl(env, "course", productId),
          nextTools: ["create_course_offering", "assign_offering_content", "publish_course_offering"]
        }, "Courses are made enrolable through a priced course offering. Create or update the offering, add its content and schedule, then ask for confirmation before calling publish_course_offering.", true),
        entityId: productId,
        errorCode: "course_offering_required"
      };
    }
    if (args.confirm !== true) {
      return {
        result: contentResult({ error: "confirmation_required" }, "Ask the user to explicitly confirm this action, then call again with confirm=true.", true),
        entityId: productId, errorCode: "confirmation_required"
      };
    }
    const action = name === "publish_product"
      ? "publish"
      : name === "unpublish_product"
        ? "unpublish"
        : name === "republish_product"
          ? "republish"
          : "";
    const method = name === "delete_product_draft" ? "DELETE" : "POST";
    const path = `/api/creator/learning-products/${encodeURIComponent(productId)}${action ? `/${action}` : ""}`;
    const response = await callApi(env, context, path, method);
    const successText = name === "publish_product"
      ? "Product published."
      : name === "unpublish_product"
        ? "Product unpublished."
        : name === "republish_product"
          ? "Product republished."
          : "Product draft deleted.";
    return {
      result: contentResult(response.data, response.ok ? successText : response.data?.error?.message ?? "The action failed.", !response.ok),
      entityId: productId, errorCode: response.ok ? undefined : response.errorCode
    };
  }
  if (name === "list_product_offers") {
    const query = new URLSearchParams();
    if (args.productId) query.set("productId", String(args.productId));
    if (args.courseId) query.set("courseId", String(args.courseId));
    const suffix = query.size ? `?${query}` : "";
    const response = await callApi(env, context, `/api/creator/product-offers${suffix}`);
    const offers = Array.isArray(response.data?.offers) ? response.data.offers : [];
    const summary = offers.length ? [
      `Found ${offers.length} product offer(s):`,
      ...offers.map((offer: any, index: number) => `${index + 1}. ${offer.title} | ${offer.product_count === 1 ? "independent" : `${offer.product_count} products`} | ${offer.currency} ${(Number(offer.price_cents) / 100).toFixed(2)} | status=${offer.status} | id=${offer.id}`)
    ].join("\n") : "No matching product offers found.";
    return { result: contentResult(response.data, response.ok ? summary : response.data?.error?.message ?? "Offers could not be loaded.", !response.ok), errorCode: response.ok ? undefined : response.errorCode };
  }
  if (name === "create_product_offer") {
    const response = await callApi(env, context, "/api/creator/product-offers", "POST", args);
    return { result: contentResult(response.data, response.ok ? "Draft product offer created. Publish it only after the user confirms." : response.data?.error?.message ?? "Offer creation failed.", !response.ok), entityId: response.data?.offer?.id, errorCode: response.ok ? undefined : response.errorCode };
  }
  if (name === "update_product_offer") {
    const offerId = String(args.offerId ?? "");
    const { offerId: _offerId, ...payload } = args;
    const response = await callApi(env, context, `/api/creator/product-offers/${encodeURIComponent(offerId)}`, "PATCH", payload);
    return { result: contentResult(response.data, response.ok ? "Draft product offer updated." : response.data?.error?.message ?? "Offer update failed.", !response.ok), entityId: offerId, errorCode: response.ok ? undefined : response.errorCode };
  }
  if (name === "add_product_to_offer") {
    const offerId = String(args.offerId ?? "");
    const response = await callApi(env, context, `/api/creator/product-offers/${encodeURIComponent(offerId)}/items`, "POST", { productId: args.productId, position: args.position });
    return { result: contentResult(response.data, response.ok ? "Product added to the draft offer." : response.data?.error?.message ?? "Product could not be added.", !response.ok), entityId: offerId, errorCode: response.ok ? undefined : response.errorCode };
  }
  if (name === "remove_product_from_offer") {
    const offerId = String(args.offerId ?? "");
    const productId = String(args.productId ?? "");
    const response = await callApi(env, context, `/api/creator/product-offers/${encodeURIComponent(offerId)}/items/${encodeURIComponent(productId)}`, "DELETE");
    return { result: contentResult(response.data, response.ok ? "Product removed from the draft offer." : response.data?.error?.message ?? "Product could not be removed.", !response.ok), entityId: offerId, errorCode: response.ok ? undefined : response.errorCode };
  }
  if (name === "publish_product_offer" || name === "unpublish_product_offer") {
    const offerId = String(args.offerId ?? "");
    if (args.confirm !== true) return { result: contentResult({ error: "confirmation_required" }, "Ask the user to explicitly confirm this offer action, then call again with confirm=true.", true), entityId: offerId, errorCode: "confirmation_required" };
    const action = name === "publish_product_offer" ? "publish" : "unpublish";
    const response = await callApi(env, context, `/api/creator/product-offers/${encodeURIComponent(offerId)}/${action}`, "POST");
    return { result: contentResult(response.data, response.ok ? (action === "publish" ? "Product offer published and priced." : "Product offer closed to new purchases.") : response.data?.error?.message ?? "Offer action failed.", !response.ok), entityId: offerId, errorCode: response.ok ? undefined : response.errorCode };
  }
  if (name === "get_google_calendar_connection_status") {
    const response = await callApi(env, context, "/api/integrations/google/status", "GET");
    const connected = response.ok && response.data?.integration?.status === "active";
    const data = {
      connected,
      googleEmail: connected ? response.data.integration.google_email : null,
      connectUrl: connected ? null : `${env.AUTHORIZATION_SERVER}/api/integrations/google/start`
    };
    return {
      result: contentResult(data, connected
        ? `Google Calendar and Meet are connected${data.googleEmail ? ` as ${data.googleEmail}` : ""}.`
        : "Google Calendar and Meet are not connected. Ask the creator to open connectUrl before scheduling an online session.", !response.ok),
      errorCode: response.ok ? undefined : response.errorCode
    };
  }
  if (name === "create_course_draft") {
    const courseType = String(args.courseType ?? "video_course");
    const deliveryMode = courseType === "online_course" ? "live" : courseType === "in_person_course" ? "hybrid" : "self-paced";
    const { courseType: _courseType, ...courseArgs } = args;
    const response = await callApi(env, context, "/api/tutor/courses", "POST", {
      ...courseArgs, deliveryMode, currency: "SGD", publish: false
    });
    const courseId = String(response.data?.course?.id ?? "");
    const resultData = response.ok && courseId
      ? {
          ...response.data,
          course: {
            ...response.data.course,
            productType: courseType,
            studioUrl: creatorStudioUrl(env, "course", courseId)
          }
        }
      : response.data;
    return {
      result: contentResult(resultData, response.ok
        ? `Course draft created. ID: ${courseId}. Keep this ID or use list_my_products to find the course again.`
        : response.data?.error?.message ?? "Course creation failed.", !response.ok),
      entityId: response.data?.course?.id, errorCode: response.ok ? undefined : response.errorCode
    };
  }
  if (name === "create_course_offering") {
    const courseId = String(args.courseId ?? "");
    const { courseId: _courseId, ...payload } = args;
    const response = await callApi(env, context, `/api/tutor/courses/${encodeURIComponent(courseId)}/offerings`, "POST", payload);
    return {
      result: contentResult(response.data, response.ok ? "Draft course offering created. Add bundle content and sessions before publication." : response.data?.error?.message ?? "Course offering creation failed.", !response.ok),
      entityId: response.data?.offering?.id ?? courseId,
      errorCode: response.ok ? undefined : response.errorCode
    };
  }
  if (name === "update_course_offering") {
    const offeringId = String(args.offeringId ?? "");
    const { offeringId: _offeringId, offeringType: _lockedType, academicYear: _lockedYear, termNumber: _lockedTerm, ...payload } = args;
    const response = await callApi(env, context, `/api/tutor/offerings/${encodeURIComponent(offeringId)}`, "PATCH", payload);
    return {
      result: contentResult(response.data, response.ok ? "Draft course offering updated." : response.data?.error?.message ?? "Course offering update failed.", !response.ok),
      entityId: offeringId,
      errorCode: response.ok ? undefined : response.errorCode
    };
  }
  if (name === "assign_offering_content") {
    const offeringId = String(args.offeringId ?? "");
    const response = await callApi(env, context, `/api/tutor/offerings/${encodeURIComponent(offeringId)}/content`, "POST", {
      kind: args.kind, contentId: args.contentId, position: args.position
    });
    return {
      result: contentResult(response.data, response.ok ? "Content added to the draft offer bundle." : response.data?.error?.message ?? "Offering content could not be added.", !response.ok),
      entityId: offeringId,
      errorCode: response.ok ? undefined : response.errorCode
    };
  }
  if (name === "add_course_session") {
    const offeringId = String(args.offeringId ?? "");
    const { offeringId: _offeringId, ...payload } = args;
    const response = await callApi(env, context, `/api/tutor/offerings/${encodeURIComponent(offeringId)}/sessions`, "POST", payload);
    return {
      result: contentResult(response.data, response.ok
        ? (args.deliveryMode === "live_online" ? "Online class scheduled and Google Meet created." : "In-person class and venue scheduled.")
        : response.data?.error?.message ?? "Course session scheduling failed.", !response.ok),
      entityId: response.data?.session?.id ?? offeringId,
      errorCode: response.ok ? undefined : response.errorCode
    };
  }
  if (name === "update_course_session") {
    const sessionId = String(args.sessionId ?? "");
    const { sessionId: _sessionId, instructorId: _lockedInstructor, ...payload } = args;
    const response = await callApi(env, context, `/api/tutor/sessions/${encodeURIComponent(sessionId)}`, "PATCH", payload);
    return {
      result: contentResult(response.data, response.ok ? "Scheduled class updated." : response.data?.error?.message ?? "Course session update failed.", !response.ok),
      entityId: sessionId,
      errorCode: response.ok ? undefined : response.errorCode
    };
  }
  if (name === "publish_course_offering") {
    const offeringId = String(args.offeringId ?? "");
    if (args.confirm !== true) {
      return {
        result: contentResult({ error: "confirmation_required" }, "Ask the user to explicitly confirm publishing this offer and opening it according to its booking dates, then call again with confirm=true.", true),
        entityId: offeringId, errorCode: "confirmation_required"
      };
    }
    const response = await callApi(env, context, `/api/tutor/offerings/${encodeURIComponent(offeringId)}/publish`, "POST");
    return {
      result: contentResult(response.data, response.ok ? "Course offering published." : response.data?.error?.message ?? "Course offering publication failed.", !response.ok),
      entityId: offeringId,
      errorCode: response.ok ? undefined : response.errorCode
    };
  }  if (name === "add_course_module") {
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
      instructions: "Create drafts first. Use list_my_products to rediscover every standalone product or course draft by title or ID before creating a possible duplicate. Products are priced independently from content: use create_product_offer with one standalone product or course offering for independent sale, or multiple items for a bundle, then publish_product_offer only after confirmation. For courses, create and publish a course offering; use list_product_offers to find eligible published course offering IDs. Before adding an online session, call get_google_calendar_connection_status and give the creator its connectUrl when needed. To add a new file, use begin_content_upload, upload every base64 part, then complete_content_upload; use get_content_upload to resume. Use list_content_library to select reusable resources by ID; never request or reveal storage keys. Online sessions create Google Meet and require connected Google Calendar; in-person sessions require a venue. Return every created ID and Creator Studio URL. Read before editing. Never publish, unpublish, close or delete unless the user explicitly confirms."
    });
  }
  if (message.method === "initialize") {
    return rpc(message.id, {
      protocolVersion: "2025-11-25",
      serverInfo: { name: "pencilscope-creator", version: "1.0.0" },
      capabilities: { tools: {} },
      instructions: "Create drafts first. Use list_my_products to rediscover every standalone product or course draft by title or ID before creating a possible duplicate. Products are priced independently from content: use create_product_offer with one standalone product or course offering for independent sale, or multiple items for a bundle, then publish_product_offer only after confirmation. For courses, create and publish a course offering; use list_product_offers to find eligible published course offering IDs. Before adding an online session, call get_google_calendar_connection_status and give the creator its connectUrl when needed. To add a new file, use begin_content_upload, upload every base64 part, then complete_content_upload; use get_content_upload to resume. Use list_content_library to select reusable resources by ID; never request or reveal storage keys. Online sessions create Google Meet and require connected Google Calendar; in-person sessions require a venue. Return every created ID and Creator Studio URL. Read before editing. Never publish, unpublish, close or delete unless the user explicitly confirms."
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
