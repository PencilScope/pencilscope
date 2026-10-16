# PencilScope

PencilScope is an open learning marketplace for recorded courses, live online learning and in-person training. It supports academic and enrichment courses, professional and personal development, masterclasses, workshops, seminars and community knowledge sharing.

## Included

- Astro server-rendered application targeting Cloudflare Workers
- Public landing page, course catalogue and course details
- D1 migration for the initial learning and commerce domains
- Stripe Checkout and signature-verified, idempotent webhook processing
- Automatic Stripe Product and Price creation when a course is published
- Versioned course pricing that preserves the Stripe Price used by each order
- Resend email service boundary
- Private API Worker connected to the Astro web Worker with a Service Binding
- API-owned R2, Queue, D1, Stripe and Resend bindings
- Health endpoint at `/api/health`
- Individual and Organisation registration with session-backed sign-in
- Google and Facebook OAuth sign-in and registration with provider identity linking
- Parent-managed learner profiles and role-aware dashboards
- Stripe payment-to-enrolment entitlement assignment
- Protected course modules, lessons and progress tracking
- A shared quiz, test and mock-exam engine with automatic choice grading
- Spaced-repetition flashcard review
- Creator studio available to every active account
- Configurable course categories and creator memberships
- Self-paced, cohort, event and academic-term offerings with independent Stripe prices
- Recorded lessons, live online sessions, in-person venues, attendance and capacity
- Offering-specific modules, materials, quizzes, tests, mock exams and flashcards

## Local setup

Requirements: Node.js 22.12 or newer and pnpm.

1. Install dependencies with `pnpm install`.
2. Copy `.dev.vars.example` to `.dev.vars` and add test credentials.
3. Apply the local migration with `pnpm db:migrate:local`.
4. Start the API Worker with `pnpm api:dev`.
5. In a second terminal, start the Astro web Worker with `pnpm dev`.

Run `pnpm test:storage` for an isolated local D1/R2 integration check. It creates temporary Wrangler state, applies every migration, exercises uploads, immutable replacement versions, quota accounting, rollback, deletion and recovery, then removes that state.

The catalogue renders sample content before D1 is initialised. Publishing a paid offering from the creator studio creates or reuses the course's Stripe Product and creates an immutable one-time Price for that offering. Checkout requires migrated D1 data and Stripe test credentials.

Password credentials use PBKDF2-SHA-256 with a unique salt and 100,000 iterations, the maximum currently supported by Cloudflare Workers Web Crypto.

## Cloudflare environments

The repository has two isolated named Cloudflare environments. Each environment contains a public Astro web Worker and a private API Worker:

| Git branch | Public web Worker | Private API Worker | D1 | R2 | Queue |
| --- | --- | --- | --- | --- | --- |
| `uat` | `pencilscope-uat` | `pencilscope-api-uat` | `pencilscope-db-uat` | `pencilscope-media-uat` | `pencilscope-jobs-uat` |
| `production` | `pencilscope-production` | `pencilscope-api-production` | `pencilscope-db-production` | `pencilscope-media-production` | `pencilscope-jobs-production` |

The web Worker owns assets, Astro sessions and the `API` service binding. The API Worker exclusively owns D1, R2, Queue, Stripe and Resend. Public `/api/*` requests enter through the web origin and are forwarded privately; the API Workers have `workers_dev` disabled.

Use `pnpm db:migrate:uat` and `pnpm deploy:uat` for UAT. Use `pnpm db:migrate:production` and `pnpm deploy:production` for production. Deployment always publishes the API first and then builds and publishes the web Worker.

Store secrets separately in each environment; never commit them:

```powershell
pnpm exec wrangler secret put STRIPE_SECRET_KEY --config workers/api/wrangler.jsonc --env uat
pnpm exec wrangler secret put STRIPE_WEBHOOK_SECRET --config workers/api/wrangler.jsonc --env uat
pnpm exec wrangler secret put RESEND_API_KEY --config workers/api/wrangler.jsonc --env uat
pnpm exec wrangler secret put EMAIL_FROM --config workers/api/wrangler.jsonc --env uat

pnpm exec wrangler secret put STRIPE_SECRET_KEY --config workers/api/wrangler.jsonc --env production
pnpm exec wrangler secret put STRIPE_WEBHOOK_SECRET --config workers/api/wrangler.jsonc --env production
pnpm exec wrangler secret put RESEND_API_KEY --config workers/api/wrangler.jsonc --env production
pnpm exec wrangler secret put EMAIL_FROM --config workers/api/wrangler.jsonc --env production
```

### Google and Facebook sign-in

Create a Google OAuth web client and a Meta app with Facebook Login. Register these exact callback URLs:

- Local: `http://localhost:4321/api/auth/google/callback` and `http://localhost:4321/api/auth/facebook/callback`
- UAT: `https://pencilscope-uat.rdproducts-adm1.workers.dev/api/auth/google/callback` and `https://pencilscope-uat.rdproducts-adm1.workers.dev/api/auth/facebook/callback`
- Production: `https://pencilscope.com/api/auth/google/callback` and `https://pencilscope.com/api/auth/facebook/callback`

Google requires the `openid`, `email`, and `profile` scopes. Facebook Login requires `email` and `public_profile`. Configure credentials on both the public web Worker and private API Worker; client secrets belong only on the API Worker:

```powershell
pnpm exec wrangler secret put GOOGLE_CLIENT_ID --config wrangler.jsonc --env uat
pnpm exec wrangler secret put FACEBOOK_APP_ID --config wrangler.jsonc --env uat
pnpm exec wrangler secret put GOOGLE_CLIENT_ID --config workers/api/wrangler.jsonc --env uat
pnpm exec wrangler secret put GOOGLE_CLIENT_SECRET --config workers/api/wrangler.jsonc --env uat
pnpm exec wrangler secret put FACEBOOK_APP_ID --config workers/api/wrangler.jsonc --env uat
pnpm exec wrangler secret put FACEBOOK_APP_SECRET --config workers/api/wrangler.jsonc --env uat

pnpm exec wrangler secret put GOOGLE_CLIENT_ID --config wrangler.jsonc --env production
pnpm exec wrangler secret put FACEBOOK_APP_ID --config wrangler.jsonc --env production
pnpm exec wrangler secret put GOOGLE_CLIENT_ID --config workers/api/wrangler.jsonc --env production
pnpm exec wrangler secret put GOOGLE_CLIENT_SECRET --config workers/api/wrangler.jsonc --env production
pnpm exec wrangler secret put FACEBOOK_APP_ID --config workers/api/wrangler.jsonc --env production
pnpm exec wrangler secret put FACEBOOK_APP_SECRET --config workers/api/wrangler.jsonc --env production
```

Email registration and sign-in use Cloudflare Turnstile. Create separate managed widgets for UAT and production, restrict each widget to its environment hostnames, and configure both the public site key and private secret on the web Worker:

```powershell
pnpm exec wrangler secret put TURNSTILE_SITE_KEY --env uat
pnpm exec wrangler secret put TURNSTILE_SECRET_KEY --env uat
pnpm exec wrangler secret put TURNSTILE_SITE_KEY --env production
pnpm exec wrangler secret put TURNSTILE_SECRET_KEY --env production
```

Local development falls back to Cloudflare's official always-pass test keys. Production environments fail closed when either deployed key is missing.

New social users continue through the same onboarding flow as email registrations. When a provider returns the same normalized email as an active PencilScope account, its provider identity is linked to that account instead of creating a duplicate.

Configure separate Stripe webhook endpoints for:

- `https://pencilscope-uat.rdproducts-adm1.workers.dev/api/webhooks/stripe`
- `https://pencilscope-production.rdproducts-adm1.workers.dev/api/webhooks/stripe`

## Learning journeys

### Accounts and capabilities

- **Individual** accounts can purchase and access learning for themselves, manage linked learner profiles, and create courses.
- **Organisation** accounts publish courses under an organisation name and do not hold learner entitlements.
- **Creator** is a capability, not an exclusive account type. Course ownership and collaboration live in `course_members`, while public creator and future payout state live in `creator_profiles`.
- The legacy `users.role` values remain internally for backward compatibility. Product behaviour uses `account_profiles.account_type` instead.

### Parent and student

1. A parent registers, signs in and creates one or more learner profiles.
2. The parent chooses a learner on a course page and completes Stripe Checkout.
3. The verified Stripe webhook records the order and activates that learner's enrolment.
4. The dashboard links to the protected course player, which records lesson progress.
5. Quizzes, tests and mock exams share the same versioned attempt and response model.
6. Flashcard confidence ratings schedule each learner's next review.

Student accounts can use the same learning endpoints directly. Parent access to progress, assessments and flashcards is limited to linked learner profiles.

### Creator

Every active account can use `/tutor` (the current creator-studio URL) to create a course. A creator can add:

- self-paced, cohort, event and academic-term offerings;
- recorded, live online and in-person lessons;
- scheduled online sessions, venues and capacity limits;
- ordered modules, materials and lessons;
- quizzes, tests and mock exams with choice questions;
- flashcard decks and cards.

Academic term details are required only for an `academic_term` offering. Each published offering has its own price and entitlement. Assessments and decks must contain content before they can be published.

### Creator pricing API

Creator endpoints require an active authenticated account that owns the course. The `/api/tutor/*` path is retained for backward compatibility while the user interface calls it the Creator Studio.

- `POST /api/tutor/courses` creates a draft. Send `publish: true` to create its Stripe Product and first one-time Price immediately.
- `POST /api/tutor/courses/:id/publish` publishes an existing draft and provisions its Stripe pricing.
- `PATCH /api/tutor/courses/:id/pricing` creates a new versioned Stripe Price for a published course and archives the previous Price.
- `POST /api/tutor/courses/:id/offerings` creates a bookable course offering.
- `POST /api/tutor/offerings/:id/publish` publishes an offering and provisions its Stripe Price.
- `POST /api/tutor/offerings/:id/sessions` schedules a live online or in-person session.

Stripe creation calls use stable idempotency keys. A failed sync leaves the course unpublished with `pricing_status = 'failed'`, allowing a safe retry. Drafts do not create Stripe resources until publication.

## Hybrid D1/R2 content storage

D1 is the operational source of truth for ownership, search metadata, permissions, product links, quota subscriptions, recovery state and the R2 object catalogue. R2 stores file bytes only.

- `r2_asset_objects` records each immutable R2 object, byte size, MIME type, ETag and retention state.
- `media_asset_versions` provides ordered immutable versions for a logical `media_assets` record.
- New and replacement uploads always use a unique R2 key. Rolling back creates a new catalogue version pointing at a retained object; it never overwrites bytes.
- Quotas include every unpurged R2 object, including superseded versions and files inside the seven-day recovery window.
- Deleting unused content starts a seven-day recovery window. The daily Worker schedule removes expired R2 objects and marks their catalogue rows purged.
- R2 object keys remain private and are not returned by Content Library or version APIs.

Relevant creator endpoints:

- `POST /api/creator/content-library/items/:id/versions` uploads a direct replacement version.
- `GET /api/creator/content-library/items/:id/versions` lists safe version metadata.
- `POST /api/creator/content-library/items/:id/versions/:versionId/restore` rolls back by creating a new current version.
- `DELETE /api/creator/content-library/items/:id` starts the seven-day recovery window.
- `POST /api/creator/content-library/items/:id/restore` recovers deleted content before expiry.
- Resumable upload initiation accepts `libraryItemId` to create a large replacement version.

## Remaining production work

The implemented journeys are an MVP. Before a public marketplace launch, add creator identity and course moderation, Stripe Connect payouts, password reset and email verification, refunds and cancellation policies, manual grading, certificates, calendar/meeting-provider integration, reminder emails and a full automated browser test suite.
# PencilScope Creator MCP

PencilScope exposes a remote, OAuth-protected MCP server for ChatGPT, Claude and other compatible assistants.

- Local endpoint: `http://localhost:8790/mcp`
- UAT endpoint: `https://pencilscope-mcp-uat.rdproducts-adm1.workers.dev/mcp`
- Production endpoint: `https://pencilscope-mcp-production.rdproducts-adm1.workers.dev/mcp`
- OAuth metadata: `/.well-known/oauth-authorization-server` on the matching PencilScope web origin

The MCP Worker validates a per-user OAuth token, strips caller identity, and forwards authoring operations to the private core API service binding. It can list safe Content Library metadata, attach creator-owned library items by ID, create audio or uploaded-ebook products, build native ebook chapters, and attach playable library videos to video-course lessons. R2 storage keys are never returned. Product creation is draft-first; publish, unpublish and delete tools require explicit confirmation. Apply D1 migrations before deploying the API and MCP Workers.
